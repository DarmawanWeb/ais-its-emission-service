import { type Database, InjectDb } from '@darmawanweb/ais-its-nest/db';
import { Injectable } from '@nestjs/common';
import { and, eq, lt, sql } from 'drizzle-orm';

import { isUniqueViolation } from '../../db/errors.js';
import * as schema from '../../db/schema.js';

const { recomputeJobs } = schema;

/** A recomputation job. */
export type RecomputeJob = typeof recomputeJobs.$inferSelect;

/** Thrown by {@link RecomputeJobsRepository.start} when the vessel has a running job. */
export class RecomputeAlreadyRunning extends Error {
  override readonly name = 'RecomputeAlreadyRunning';
}

/** Drizzle access to `recompute_jobs`. */
@Injectable()
export class RecomputeJobsRepository {
  constructor(@InjectDb() private readonly db: Database<typeof schema>) {}

  /** Creates a running job (one per MMSI, `recompute_jobs_running_idx`). */
  async start(
    job: Pick<
      RecomputeJob,
      'id' | 'mmsi' | 'vesselId' | 'fromTime' | 'toTime' | 'requestedBy'
    >,
  ): Promise<RecomputeJob> {
    try {
      const [row] = await this.db
        .insert(recomputeJobs)
        .values({ ...job, status: 'running' })
        .returning();
      if (row === undefined)
        throw new Error('INSERT … RETURNING returned no row');
      return row;
    } catch (error) {
      if (isUniqueViolation(error, 'recompute_jobs_running_idx'))
        throw new RecomputeAlreadyRunning();
      throw error;
    }
  }

  /** Records the outcome of a job that is still running (a job failed meanwhile as stale keeps its state). */
  async finish(
    id: string,
    outcome: Pick<
      RecomputeJob,
      'status' | 'replayed' | 'segments' | 'deleted' | 'error'
    >,
  ): Promise<void> {
    await this.db
      .update(recomputeJobs)
      .set({ ...outcome, finishedAt: sql`now()`, heartbeatAt: sql`now()` })
      .where(
        and(eq(recomputeJobs.id, id), eq(recomputeJobs.status, 'running')),
      );
  }

  /** Records that a running job is alive (database clock). */
  async heartbeat(id: string): Promise<void> {
    await this.db
      .update(recomputeJobs)
      .set({ heartbeatAt: sql`now()` })
      .where(
        and(eq(recomputeJobs.id, id), eq(recomputeJobs.status, 'running')),
      );
  }

  async find(id: string): Promise<RecomputeJob | undefined> {
    const [row] = await this.db
      .select()
      .from(recomputeJobs)
      .where(eq(recomputeJobs.id, id))
      .limit(1);
    return row;
  }

  /**
   * Fails the running jobs whose heartbeat is older than `staleAfterMs`
   * (database clock): the instance running them stopped without recording
   * an outcome. Returns how many jobs were failed.
   */
  async failStale(staleAfterMs: number): Promise<number> {
    const rows = await this.db
      .update(recomputeJobs)
      .set({
        status: 'failed',
        error:
          'INTERRUPTED: no heartbeat (the instance running the job stopped)',
        finishedAt: sql`now()`,
      })
      .where(
        and(
          eq(recomputeJobs.status, 'running'),
          lt(
            recomputeJobs.heartbeatAt,
            sql`now() - make_interval(secs => ${staleAfterMs / 1000})`,
          ),
        ),
      )
      .returning({ id: recomputeJobs.id });
    return rows.length;
  }
}
