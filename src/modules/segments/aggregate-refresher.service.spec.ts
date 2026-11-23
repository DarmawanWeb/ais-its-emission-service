import { loadConfig } from '@darmawanweb/ais-its-nest';
import { type Pool, PG_SQLSTATES } from '@darmawanweb/ais-its-nest/db';
import { describe, expect, it } from 'vitest';

import { configSchema } from '../../config.js';
import { AggregateRefresher } from './aggregate-refresher.service.js';

/** A refresh call: the aggregate and its window (ISO strings, as bound). */
interface RefreshCall {
  readonly view: string;
  readonly from: string;
  readonly to: string;
}

/**
 * Pool whose dedicated clients record the refresh calls of the kit's
 * `refreshContinuousAggregate`; each refresh takes `delayMs` and may fail.
 */
class FakePool {
  readonly calls: RefreshCall[] = [];
  /** Session settings issued around the refreshes (statement timeout). */
  readonly settings: string[] = [];
  failNext = false;
  /** Errors thrown by the next refreshes, in order (before `failNext`). */
  readonly errors: Error[] = [];
  released = 0;
  private active = 0;
  maxActive = 0;

  constructor(private readonly delayMs: number) {}

  connect(): Promise<{
    query: (sql: string, params?: unknown[]) => Promise<{ rows: [] }>;
    release: () => void;
  }> {
    return Promise.resolve({
      query: (sql, params) => this.query(sql, params ?? []),
      release: () => {
        this.released += 1;
      },
    });
  }

  private async query(sql: string, params: unknown[]): Promise<{ rows: [] }> {
    if (!sql.includes('refresh_continuous_aggregate')) {
      this.settings.push(sql);
      return { rows: [] };
    }
    this.active += 1;
    this.maxActive = Math.max(this.maxActive, this.active);
    await new Promise((resolve) => setTimeout(resolve, this.delayMs));
    this.active -= 1;
    const error = this.errors.shift();
    if (error !== undefined) throw error;
    if (this.failNext) {
      this.failNext = false;
      throw new Error('lock timeout');
    }
    const [view, from, to] = params as [string, string, string];
    this.calls.push({ view, from, to });
    return { rows: [] };
  }
}

function refresher(pool: FakePool): AggregateRefresher {
  const config = loadConfig(configSchema, {
    env: { LOG_LEVEL: 'silent' },
    envFile: false,
    output: null,
  });
  // Only `connect` is used (see FakePool).
  return new AggregateRefresher(config, pool as unknown as Pool);
}

describe('AggregateRefresher', () => {
  it('refreshes only after a change of a day before today, over the policy windows', async () => {
    const pool = new FakePool(1);
    const service = refresher(pool);
    service.markChanged(new Date());
    await service.flush();
    expect(pool.calls).toHaveLength(0);

    service.markChanged(new Date(Date.now() - 2 * 86_400_000));
    await service.flush();
    expect(pool.calls.map((call) => call.view)).toEqual([
      'cii_daily',
      'cii_annual',
    ]);
    const daily = pool.calls[0];
    const dailyFrom = new Date(daily?.from ?? '');
    const dailyTo = new Date(daily?.to ?? '');
    expect((dailyTo.getTime() - dailyFrom.getTime()) / 86_400_000).toBe(400);
    expect(dailyTo.getUTCHours()).toBe(0);
    const annual = pool.calls[1];
    const annualFrom = new Date(annual?.from ?? '');
    const annualTo = new Date(annual?.to ?? '');
    expect(annualTo.getUTCFullYear() - annualFrom.getUTCFullYear()).toBe(3);
    expect(annualTo.getUTCMonth()).toBe(0);
    // No statement timeout for the 400-day window; restored on the client.
    expect(pool.settings).toEqual([
      'SET statement_timeout = 0',
      'RESET statement_timeout',
      'SET statement_timeout = 0',
      'RESET statement_timeout',
    ]);
    expect(pool.released).toBe(2);

    await service.flush();
    expect(pool.calls).toHaveLength(2);
  });

  it('refreshes a pending late change at shutdown, and nothing without one', async () => {
    const pool = new FakePool(1);
    const service = refresher(pool);
    service.markChanged(new Date(Date.now() - 2 * 86_400_000));
    await service.beforeApplicationShutdown();
    expect(pool.calls).toHaveLength(2);
    await service.beforeApplicationShutdown();
    expect(pool.calls).toHaveLength(2);
  });

  it('refreshes once after boot, for late writes of a replica that crashed before refreshing', async () => {
    const pool = new FakePool(1);
    const service = refresher(pool);
    service.onApplicationBootstrap();
    try {
      await service.flush();
      expect(pool.calls.map((call) => call.view)).toEqual([
        'cii_daily',
        'cii_annual',
      ]);
      await service.flush();
      expect(pool.calls).toHaveLength(2);
    } finally {
      await service.beforeApplicationShutdown();
    }
  });

  it('retries a refresh that overlaps a refresh in progress (55P03), and only that error', async () => {
    const pool = new FakePool(1);
    const service = refresher(pool);
    const concurrent = () =>
      Object.assign(
        new Error(
          'could not refresh continuous aggregate "cii_daily" due to a concurrent refresh',
        ),
        { code: PG_SQLSTATES.LOCK_NOT_AVAILABLE },
      );
    pool.errors.push(concurrent());
    await service.refreshNow();
    expect(pool.calls.map((call) => call.view)).toEqual([
      'cii_daily',
      'cii_annual',
    ]);

    pool.errors.push(
      Object.assign(new Error('permission denied'), { code: '42501' }),
    );
    await expect(service.refreshNow()).rejects.toThrow('permission denied');
    expect(pool.calls).toHaveLength(2);
  });

  it('never runs two refreshes at the same time and keeps a failed change pending', async () => {
    const pool = new FakePool(5);
    const service = refresher(pool);
    await Promise.all([
      service.refreshNow(),
      service.refreshNow(),
      service.flush(),
    ]);
    expect(pool.maxActive).toBe(1);
    expect(pool.calls).toHaveLength(4);

    pool.failNext = true;
    await expect(service.refreshNow()).rejects.toThrow('lock timeout');
    await service.flush();
    expect(pool.calls).toHaveLength(6);
  });
});
