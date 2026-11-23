import { newId } from '@darmawanweb/ais-its-contracts/domain';
import { EVENT_TYPES, subjects } from '@darmawanweb/ais-its-contracts/events';
import { InjectConfig } from '@darmawanweb/ais-its-nest';
import { AuditService } from '@darmawanweb/ais-its-nest/audit';
import type { Principal } from '@darmawanweb/ais-its-nest/auth';
import {
  type Database,
  InjectDb,
  sanitizeError,
} from '@darmawanweb/ais-its-nest/db';
import { StreamReplayer } from '@darmawanweb/ais-its-nest/nats';
import {
  type BeforeApplicationShutdown,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
} from '@nestjs/common';
import type { FastifyRequest } from 'fastify';

import {
  RecomputeInProgressError,
  RecomputeJobNotFoundError,
  RecomputeRangeError,
} from '../../common/errors.js';
import type { Config } from '../../config.js';
import { lockVesselSegments } from '../../db/executor.js';
import type * as schema from '../../db/schema.js';
import { VesselAccessService } from '../profiles/vessel-access.service.js';
import { AggregateRefresher } from '../segments/aggregate-refresher.service.js';
import { CiiPublicationRepository } from '../segments/cii-publication.repository.js';
import { SegmentBuilderService } from '../segments/segment-builder.service.js';
import { SegmentsRepository } from '../segments/segments.repository.js';
import {
  RecomputeAlreadyRunning,
  type RecomputeJob,
  RecomputeJobsRepository,
} from './recompute-jobs.repository.js';

const DAY_MS = 86_400_000;
/** Retention of the AIS_POSITION stream (spec §7.2). */
const POSITION_RETENTION_MS = 7 * DAY_MS;
/** Extra stream time read around the range (position time ≠ storage time). */
const REPLAY_SLACK_MS = 15 * 60_000;
/** `to` may be this far ahead of the server clock (client skew); it is clamped to now. */
const MAX_FUTURE_SKEW_MS = 60_000;
/** Interval of the heartbeat of a running job. */
export const RECOMPUTE_HEARTBEAT_MS = 10_000;
/** A running job without a heartbeat for this long was interrupted (instance stopped). */
export const RECOMPUTE_STALE_AFTER_MS = 60_000;

/** Why a recomputation stopped before deleting anything (stored as `CODE: message`). */
class RecomputeStopped extends Error {
  override readonly name = 'RecomputeStopped';

  constructor(
    readonly code:
      'INTERRUPTED' | 'REPLAY_INCOMPLETE' | 'NO_POSITIONS' | 'VESSEL_CHANGED',
    message: string,
  ) {
    super(`${code}: ${message}`);
  }
}

/** A job running in this instance. */
interface RunningJob {
  readonly controller: AbortController;
  readonly done: Promise<void>;
}

/**
 * Recomputation of a vessel's segments by replay of `AIS_POSITION` with an
 * ephemeral consumer (spec §13.5, ≤ RECOMPUTE_MAX_DAYS days inside the
 * stream's 7 days, `to` not in the future). Every segment starting in
 * `[from, to)` is rebuilt from the replayed events by the live builder in
 * `replace` mode (current profile, readings and weather; same vessel lock).
 *
 * Only a complete replay deletes anything: when the kit reports the replay
 * `completed` (it read up to the subject's last message at start or past the
 * range, `endedBy` `end_of_stream`, `to` or `empty`), the segments of the
 * vessel under the replayed MMSI that the replay did not
 * produce again — computed before the job started, between the first and the
 * last rebuilt segment — are deleted. Rows written meanwhile by the live
 * consumers (later `computed_at`) and rows of the previous holder of a
 * re-assigned MMSI are never deleted; a replay that finds no position while
 * segments exist deletes nothing and fails. A partial replay (`endedBy`
 * `aborted` at shutdown, `closed` when the connection ended) fails and leaves
 * every segment in place (rebuilt ones are just recomputed). Then the aggregates are refreshed and the CII is marked
 * for publication.
 *
 * A running job writes a heartbeat; running jobs without one for
 * {@link RECOMPUTE_STALE_AFTER_MS} are failed at boot and before a new job
 * starts, and on shutdown this instance cancels its jobs and waits until they
 * recorded their outcome (`beforeApplicationShutdown`, while the database is
 * still open).
 */
@Injectable()
export class RecomputeService
  implements OnApplicationBootstrap, BeforeApplicationShutdown
{
  private readonly logger = new Logger(RecomputeService.name);
  private readonly running = new Map<string, RunningJob>();

  constructor(
    @InjectConfig() private readonly config: Config,
    @InjectDb() private readonly db: Database<typeof schema>,
    private readonly access: VesselAccessService,
    private readonly jobs: RecomputeJobsRepository,
    private readonly segments: SegmentsRepository,
    private readonly builder: SegmentBuilderService,
    private readonly replayer: StreamReplayer,
    private readonly refresher: AggregateRefresher,
    private readonly publication: CiiPublicationRepository,
    private readonly audit: AuditService,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    await this.failStaleJobs();
  }

  /** Cancels the jobs of this instance and waits until each recorded its outcome. */
  async beforeApplicationShutdown(): Promise<void> {
    const jobs = [...this.running.values()];
    for (const job of jobs) job.controller.abort();
    await Promise.all(jobs.map((job) => job.done));
  }

  /** Validates the range, creates the job and starts it in the background. */
  async start(
    mmsi: number,
    range: { readonly from?: Date | undefined; readonly to?: Date | undefined },
    principal: Principal,
    request?: FastifyRequest,
    now = new Date(),
  ): Promise<RecomputeJob> {
    // Platform administrators only: @RequirePlatformAdmin() on the route.
    if (
      range.to !== undefined &&
      range.to.getTime() > now.getTime() + MAX_FUTURE_SKEW_MS
    )
      throw new RecomputeRangeError('to must not be in the future');
    const to =
      range.to === undefined || range.to > now ? now : new Date(range.to);
    const from = range.from ?? new Date(to.getTime() - DAY_MS);
    if (from >= to) throw new RecomputeRangeError('from must be before to');
    if (
      to.getTime() - from.getTime() >
      this.config.RECOMPUTE_MAX_DAYS * DAY_MS
    ) {
      throw new RecomputeRangeError(
        `The range may span at most ${this.config.RECOMPUTE_MAX_DAYS} days`,
      );
    }
    if (from.getTime() < now.getTime() - POSITION_RETENTION_MS) {
      throw new RecomputeRangeError(
        'from is older than the 7 days kept by the AIS_POSITION stream',
      );
    }
    const profile = await this.access.accessible(mmsi, principal);
    await this.failStaleJobs();
    let job: RecomputeJob;
    try {
      job = await this.jobs.start({
        id: newId(),
        mmsi,
        vesselId: profile.vesselId,
        fromTime: from,
        toTime: to,
        requestedBy: principal.id,
      });
    } catch (error) {
      if (error instanceof RecomputeAlreadyRunning)
        throw new RecomputeInProgressError(mmsi);
      throw error;
    }
    await this.audit.record(
      {
        action: 'cii.recompute',
        targetType: 'vessel',
        targetId: profile.vesselId,
        orgId: profile.orgId,
        meta: { mmsi, jobId: job.id, from, to },
      },
      principal,
      request,
    );
    const controller = new AbortController();
    const done = this.run(job, profile.vesselId, controller.signal).finally(
      () => this.running.delete(job.id),
    );
    this.running.set(job.id, { controller, done });
    return job;
  }

  /** A job by id (platform administrators only: @RequirePlatformAdmin() on the route). */
  async get(id: string): Promise<RecomputeJob> {
    const job = await this.jobs.find(id);
    if (job === undefined) throw new RecomputeJobNotFoundError(id);
    return job;
  }

  /**
   * Jobs newest first, optionally of one MMSI and status, after a cursor
   * position (platform administrators only: @RequirePlatformAdmin() on the
   * route). Stale running jobs are failed first, so that a job whose
   * instance stopped never shows as running.
   */
  async list(
    filter: {
      readonly mmsi?: number | undefined;
      readonly status?: RecomputeJob['status'] | undefined;
    },
    before: { readonly createdAt: Date; readonly id: string } | undefined,
    limit: number,
  ): Promise<RecomputeJob[]> {
    await this.failStaleJobs();
    return this.jobs.list(filter, before, limit);
  }

  private async failStaleJobs(): Promise<void> {
    const failed = await this.jobs.failStale(RECOMPUTE_STALE_AFTER_MS);
    if (failed > 0)
      this.logger.warn(
        { failed },
        'interrupted recomputations marked as failed',
      );
  }

  /** Runs a job to its recorded outcome; never rejects. */
  private async run(
    job: RecomputeJob,
    vesselId: string,
    shutdown: AbortSignal,
  ): Promise<void> {
    const from = job.fromTime.getTime();
    const to = job.toTime.getTime();
    const subject = subjects.aisPosition(job.mmsi);
    const windowStart = new Date(from - REPLAY_SLACK_MS);
    const windowEnd = new Date(to + REPLAY_SLACK_MS);
    let replayed = 0;
    let rebuilt = 0;
    let deleted = 0;
    let first: number | undefined;
    let last: number | undefined;
    const heartbeat = setInterval(() => {
      this.jobs.heartbeat(job.id).catch((error: unknown) => {
        this.logger.warn(
          { err: sanitizeError(error), jobId: job.id },
          'recomputation heartbeat failed',
        );
      });
    }, RECOMPUTE_HEARTBEAT_MS);
    heartbeat.unref();
    try {
      // Stream time window: the kit stops at the first message stored after
      // `to` (`endedBy: 'to'`) or at the subject's last message at start.
      const report = await this.replayer.replay({
        stream: 'AIS_POSITION',
        filterSubjects: [subject],
        from: windowStart,
        to: windowEnd,
        eventTypes: [EVENT_TYPES.AIS_POSITION_RECORDED],
        signal: shutdown,
        handler: async (event) => {
          // The replay handler receives any envelope type (no consumer key).
          if (event.type !== EVENT_TYPES.AIS_POSITION_RECORDED) return;
          const previous = event.data.previous;
          if (previous === null || event.data.mmsi !== job.mmsi) return;
          const start = new Date(previous.time).getTime();
          if (start < from || start >= to) return;
          replayed += 1;
          const outcome = await this.builder.handlePosition(
            event.data,
            'replace',
            vesselId,
          );
          if (outcome === 'unknown_vessel')
            throw new RecomputeStopped(
              'VESSEL_CHANGED',
              `MMSI ${job.mmsi} no longer belongs to vessel ${vesselId}`,
            );
          if (outcome !== 'stored') return;
          rebuilt += 1;
          first = Math.min(first ?? start, start);
          last = Math.max(last ?? start, start);
        },
      });
      // Results replace stored segments only after a complete replay.
      if (!report.completed)
        throw report.endedBy === 'aborted'
          ? new RecomputeStopped(
              'INTERRUPTED',
              'the service stopped during the replay; no segment was deleted',
            )
          : new RecomputeStopped(
              'REPLAY_INCOMPLETE',
              `the replay ended early (${report.endedBy}) after stream sequence ${String(report.lastSequence)}; no segment was deleted`,
            );
      if (first !== undefined && last !== undefined) {
        const range = {
          mmsi: job.mmsi,
          vesselId,
          from: new Date(first),
          to: new Date(last),
          computedBefore: job.createdAt,
        };
        deleted = await this.db.transaction(async (tx) => {
          await lockVesselSegments(tx, job.mmsi);
          return this.segments.deleteStale(range, tx);
        });
      } else if (replayed === 0) {
        const existing = await this.segments.countStale({
          mmsi: job.mmsi,
          vesselId,
          from: job.fromTime,
          to: new Date(to - 1),
          computedBefore: job.createdAt,
        });
        if (existing > 0)
          throw new RecomputeStopped(
            'NO_POSITIONS',
            `AIS_POSITION holds no position of the range while ${String(existing)} segments exist; they were kept`,
          );
      }
      // The segments are committed: a failed refresh only delays the figures
      // (the change stays pending for the next tick; the policy catches up).
      await this.refresher.refreshNow().catch((error: unknown) => {
        this.logger.warn(
          { err: sanitizeError(error), jobId: job.id },
          'aggregate refresh after the recomputation failed (retried at the next tick)',
        );
      });
      await this.publication.markDirty(job.mmsi);
      await this.jobs.finish(job.id, {
        status: 'succeeded',
        replayed,
        segments: rebuilt,
        deleted,
        error: null,
      });
      this.logger.log(
        {
          jobId: job.id,
          mmsi: job.mmsi,
          endedBy: report.endedBy,
          replayed,
          rebuilt,
          deleted,
        },
        'recomputation finished',
      );
    } catch (error) {
      if (error instanceof RecomputeStopped)
        this.logger.warn(
          {
            jobId: job.id,
            mmsi: job.mmsi,
            code: error.code,
            reason: error.message,
          },
          'recomputation stopped without deleting segments',
        );
      else
        this.logger.error(
          { err: sanitizeError(error), jobId: job.id, mmsi: job.mmsi },
          'recomputation failed',
        );
      // Rebuilt segments changed the figures even when nothing was deleted.
      if (rebuilt > 0)
        await this.publication.markDirty(job.mmsi).catch(() => undefined);
      await this.jobs
        .finish(job.id, {
          status: 'failed',
          replayed,
          segments: rebuilt,
          deleted,
          error: error instanceof Error ? error.message : String(error),
        })
        .catch((finishError: unknown) => {
          this.logger.error(
            { err: sanitizeError(finishError), jobId: job.id },
            'could not record the failed recomputation',
          );
        });
    } finally {
      clearInterval(heartbeat);
    }
  }
}
