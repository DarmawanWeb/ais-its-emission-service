import { setTimeout as sleep } from 'node:timers/promises';

import { InjectConfig } from '@darmawanweb/ais-its-nest';
import { InjectPool, type Pool } from '@darmawanweb/ais-its-nest/db';
import {
  type BeforeApplicationShutdown,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
} from '@nestjs/common';

import type { Config } from '../../config.js';
import { isLockNotAvailable } from '../../db/errors.js';

const DAY_MS = 86_400_000;
/**
 * Waits before the retries of a refresh that TimescaleDB rejected because it
 * overlaps a refresh in progress (a policy job, another replica: 55P03).
 */
const CONCURRENT_REFRESH_RETRY_MS: readonly number[] = [250, 500, 1_000, 2_000];

/** Start of the UTC day of `time`. */
function utcDayStart(time: Date): Date {
  return new Date(
    Date.UTC(time.getUTCFullYear(), time.getUTCMonth(), time.getUTCDate()),
  );
}

/**
 * Keeps the CII continuous aggregates fresh after **late** segment changes.
 *
 * `cii_daily` / `cii_annual` are real-time aggregates: buckets after the
 * materialization watermark (the current day, the current year) are always
 * computed from `segments`. A segment written into an older, already
 * materialized day — a late position, a telemetry re-attribution, a
 * recomputation — is only visible after the next refresh of the TimescaleDB
 * policy (every 10 min). This service marks such writes and runs the same
 * refresh windows as the policies (`cii_daily`: 400 days back to the start
 * of the current UTC day; `cii_annual`: 3 years back to 1 January) at most
 * every CII_AGGREGATE_REFRESH_MS, before every CII publication round and at
 * shutdown.
 * Refreshes only re-materialize invalidated ranges, so they are cheap when
 * little changed. A refresh is also pending from boot: TimescaleDB keeps the
 * invalidations of late writes, but the flag of a replica that crashed
 * before refreshing is lost, so a restarted replica catches up at its first
 * tick instead of waiting for the policy.
 */
@Injectable()
export class AggregateRefresher
  implements OnApplicationBootstrap, BeforeApplicationShutdown
{
  private readonly logger = new Logger(AggregateRefresher.name);
  private pending = false;
  /** Tail of the serial refresh queue (never rejects). */
  private queue: Promise<void> = Promise.resolve();
  private timer: NodeJS.Timeout | undefined;

  constructor(
    @InjectConfig() private readonly config: Config,
    @InjectPool() private readonly pool: Pool,
  ) {}

  onApplicationBootstrap(): void {
    // Late writes of a crashed replica (see the class comment).
    this.pending = true;
    this.timer = setInterval(() => {
      this.flush().catch((error: unknown) => {
        this.logger.warn(
          { err: error },
          'CII aggregate refresh failed (retried at the next tick)',
        );
      });
    }, this.config.CII_AGGREGATE_REFRESH_MS);
    this.timer.unref();
  }

  /**
   * Stops the timer and refreshes a pending late change once more, so that
   * a stopping replica does not leave it to the 10-minute TimescaleDB policy
   * (a failure is logged; the policy catches up).
   */
  async beforeApplicationShutdown(): Promise<void> {
    if (this.timer !== undefined) clearInterval(this.timer);
    await this.queue;
    if (!this.pending) return;
    await this.refreshNow().catch((error: unknown) => {
      this.logger.warn(
        { err: error },
        'CII aggregate refresh at shutdown failed (the TimescaleDB policy catches up)',
      );
    });
  }

  /** Records a write of a segment starting at `timeStart` (only days before today need a refresh). */
  markChanged(timeStart: Date, now: Date = new Date()): void {
    if (timeStart.getTime() < utcDayStart(now).getTime()) this.pending = true;
  }

  /**
   * Refreshes when a late change is pending; otherwise waits for a refresh in
   * progress, so that callers (the publisher) read materialized figures.
   */
  async flush(): Promise<void> {
    if (!this.pending) {
      await this.queue;
      return;
    }
    await this.refreshNow();
  }

  /**
   * Refreshes both aggregates over the policy windows now. Refreshes run one
   * after the other (never two concurrent refreshes of the same aggregate);
   * a failed refresh leaves the change pending for the next tick.
   */
  async refreshNow(): Promise<void> {
    this.pending = false;
    const run = this.queue.then(() => this.refresh(new Date()));
    this.queue = run.catch(() => undefined);
    try {
      await run;
    } catch (error) {
      this.pending = true;
      throw error;
    }
  }

  private async refresh(now: Date): Promise<void> {
    const today = utcDayStart(now);
    // Outside a transaction: TimescaleDB refuses refresh_continuous_aggregate inside one.
    await this.call(
      `CALL refresh_continuous_aggregate('cii_daily', $1::timestamptz, $2::timestamptz)`,
      [new Date(today.getTime() - 400 * DAY_MS), today],
    );
    await this.call(
      `CALL refresh_continuous_aggregate('cii_annual', $1::timestamptz, $2::timestamptz)`,
      [
        new Date(Date.UTC(now.getUTCFullYear() - 3, 0, 1)),
        new Date(Date.UTC(now.getUTCFullYear(), 0, 1)),
      ],
    );
  }

  /**
   * Runs one refresh. TimescaleDB rejects a refresh overlapping one in
   * progress instead of waiting for it (SQLSTATE 55P03, "due to a concurrent
   * refresh"), and the policy jobs refresh the same windows: such a refresh
   * is retried after {@link CONCURRENT_REFRESH_RETRY_MS}; other errors and
   * the last rejection are thrown.
   */
  private async call(
    sql: string,
    params: readonly [Date, Date],
  ): Promise<void> {
    for (let attempt = 0; ; attempt += 1) {
      try {
        await this.pool.query(sql, [...params]);
        return;
      } catch (error) {
        const delayMs = CONCURRENT_REFRESH_RETRY_MS[attempt];
        if (delayMs === undefined || !isLockNotAvailable(error)) throw error;
        this.logger.debug(
          { attempt: attempt + 1, delayMs },
          'CII aggregate refresh overlaps a refresh in progress; retrying',
        );
        await sleep(delayMs);
      }
    }
  }
}
