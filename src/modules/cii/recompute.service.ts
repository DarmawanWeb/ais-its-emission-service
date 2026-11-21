import { newId } from '@darmawanweb/ais-its-contracts/domain';
import { EVENT_TYPES, subjects } from '@darmawanweb/ais-its-contracts/events';
import { InjectConfig } from '@darmawanweb/ais-its-nest';
import { AuditService } from '@darmawanweb/ais-its-nest/audit';
import type { Principal } from '@darmawanweb/ais-its-nest/auth';
import { StreamReplayer } from '@darmawanweb/ais-its-nest/nats';
import {
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import type { FastifyRequest } from 'fastify';

import {
  RecomputeInProgressError,
  RecomputeJobNotFoundError,
  RecomputeRangeError,
} from '../../common/errors.js';
import { assertPlatformAdmin } from '../../common/tenancy.js';
import type { Config } from '../../config.js';
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
/** A running job older than this is considered interrupted. */
const STALE_JOB_MS = 60 * 60_000;

/**
 * Recomputation of a vessel's segments by replay of `AIS_POSITION` with an
 * ephemeral consumer (spec §13.5, ≤ RECOMPUTE_MAX_DAYS days inside the
 * stream's 7 days): every segment starting in `[from, to)` is rebuilt from
 * the replayed events (same builder as the live consumer, with the current
 * profile, readings and weather) and replaced; segments of the range that the
 * replay did not produce again are deleted at the end only, so a failed run
 * leaves the previous segments in place. Then the aggregates are refreshed
 * (complete past days and years; the current ones are real-time) and the CII
 * is marked for publication. Runs in the background; the job row tracks it.
 */
@Injectable()
export class RecomputeService
  implements OnApplicationBootstrap, OnApplicationShutdown
{
  private readonly logger = new Logger(RecomputeService.name);
  private readonly running = new Map<string, AbortController>();

  constructor(
    @InjectConfig() private readonly config: Config,
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
    const failed = await this.jobs.failStale(
      new Date(Date.now() - STALE_JOB_MS),
    );
    if (failed > 0)
      this.logger.warn(
        { failed },
        'interrupted recomputations marked as failed',
      );
  }

  onApplicationShutdown(): void {
    for (const controller of this.running.values()) controller.abort();
  }

  /** Validates the range, creates the job and starts it in the background. */
  async start(
    mmsi: number,
    range: { readonly from?: Date | undefined; readonly to?: Date | undefined },
    principal: Principal,
    request?: FastifyRequest,
    now = new Date(),
  ): Promise<RecomputeJob> {
    assertPlatformAdmin(principal);
    const to = range.to ?? now;
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
    await this.access.accessible(mmsi, principal);
    let job: RecomputeJob;
    try {
      job = await this.jobs.start({
        id: newId(),
        mmsi,
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
        targetId: String(mmsi),
        meta: { jobId: job.id, from, to },
      },
      principal,
      request,
    );
    const controller = new AbortController();
    this.running.set(job.id, controller);
    void this.run(job, controller.signal).finally(() =>
      this.running.delete(job.id),
    );
    return job;
  }

  /** A job by id (platform administrators only). */
  async get(id: string, principal: Principal): Promise<RecomputeJob> {
    assertPlatformAdmin(principal);
    const job = await this.jobs.find(id);
    if (job === undefined) throw new RecomputeJobNotFoundError(id);
    return job;
  }

  private async run(job: RecomputeJob, signal: AbortSignal): Promise<void> {
    const from = job.fromTime;
    const to = job.toTime;
    let replayed = 0;
    let deleted = 0;
    const rebuilt: Date[] = [];
    try {
      await this.replayer.replay({
        stream: 'AIS_POSITION',
        filterSubjects: [subjects.aisPosition(job.mmsi)],
        from: new Date(from.getTime() - REPLAY_SLACK_MS),
        to: new Date(to.getTime() + REPLAY_SLACK_MS),
        eventTypes: [EVENT_TYPES.AIS_POSITION_RECORDED],
        signal,
        handler: async (event) => {
          if (event.type !== EVENT_TYPES.AIS_POSITION_RECORDED) return;
          const previous = event.data.previous;
          if (previous === null || event.data.mmsi !== job.mmsi) return;
          const start = new Date(previous.time).getTime();
          if (start < from.getTime() || start >= to.getTime()) return;
          replayed += 1;
          if (
            (await this.builder.handlePosition(event.data, 'replace')) ===
            'stored'
          )
            rebuilt.push(new Date(start));
        },
      });
      deleted = await this.segments.deleteRangeExcept(
        job.mmsi,
        from,
        to,
        rebuilt,
      );
      await this.refresher.refreshNow();
      await this.publication.markDirty(job.mmsi);
      await this.jobs.finish(job.id, {
        status: 'succeeded',
        replayed,
        segments: rebuilt.length,
        deleted,
        error: null,
      });
      this.logger.log(
        {
          jobId: job.id,
          mmsi: job.mmsi,
          replayed,
          segments: rebuilt.length,
          deleted,
        },
        'recomputation finished',
      );
    } catch (error) {
      this.logger.error(
        { err: error, jobId: job.id, mmsi: job.mmsi },
        'recomputation failed',
      );
      await this.jobs
        .finish(job.id, {
          status: 'failed',
          replayed,
          segments: rebuilt.length,
          deleted,
          error: error instanceof Error ? error.message : String(error),
        })
        .catch((finishError: unknown) => {
          this.logger.error(
            { err: finishError, jobId: job.id },
            'could not record the failed recomputation',
          );
        });
    }
  }
}
