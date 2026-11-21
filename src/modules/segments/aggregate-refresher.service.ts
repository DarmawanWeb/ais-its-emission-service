import { InjectConfig } from '@darmawanweb/ais-its-nest';
import { InjectPool, type Pool } from '@darmawanweb/ais-its-nest/db';
import {
  type BeforeApplicationShutdown,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
} from '@nestjs/common';

import type { Config } from '../../config.js';

const DAY_MS = 86_400_000;

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
 * every CII_AGGREGATE_REFRESH_MS, and before every CII publication round.
 * Refreshes only re-materialize invalidated ranges, so they are cheap when
 * little changed.
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

  async beforeApplicationShutdown(): Promise<void> {
    if (this.timer !== undefined) clearInterval(this.timer);
    await this.queue;
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
    await this.pool.query(
      `CALL refresh_continuous_aggregate('cii_daily', $1::timestamptz, $2::timestamptz)`,
      [new Date(today.getTime() - 400 * DAY_MS), today],
    );
    await this.pool.query(
      `CALL refresh_continuous_aggregate('cii_annual', $1::timestamptz, $2::timestamptz)`,
      [
        new Date(Date.UTC(now.getUTCFullYear() - 3, 0, 1)),
        new Date(Date.UTC(now.getUTCFullYear(), 0, 1)),
      ],
    );
  }
}
