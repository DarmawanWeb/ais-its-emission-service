import { loadConfig } from '@darmawanweb/ais-its-nest';
import type { Pool } from '@darmawanweb/ais-its-nest/db';
import { describe, expect, it } from 'vitest';

import { configSchema } from '../../config.js';
import { PG_LOCK_NOT_AVAILABLE } from '../../db/errors.js';
import { AggregateRefresher } from './aggregate-refresher.service.js';

/** Records the refresh calls; each takes `delayMs` and may fail once. */
class FakePool {
  readonly calls: {
    sql: string;
    params: unknown[];
    startedAt: number;
    endedAt: number;
  }[] = [];
  failNext = false;
  /** Errors thrown by the next calls, in order (before `failNext`). */
  readonly errors: Error[] = [];
  private active = 0;
  maxActive = 0;

  constructor(private readonly delayMs: number) {}

  async query(sql: string, params: unknown[]): Promise<{ rows: [] }> {
    this.active += 1;
    this.maxActive = Math.max(this.maxActive, this.active);
    const startedAt = Date.now();
    await new Promise((resolve) => setTimeout(resolve, this.delayMs));
    this.active -= 1;
    const error = this.errors.shift();
    if (error !== undefined) throw error;
    if (this.failNext) {
      this.failNext = false;
      throw new Error('lock timeout');
    }
    this.calls.push({ sql, params, startedAt, endedAt: Date.now() });
    return { rows: [] };
  }
}

function refresher(pool: FakePool): AggregateRefresher {
  const config = loadConfig(configSchema, {
    env: { LOG_LEVEL: 'silent' },
    envFile: false,
    output: null,
  });
  // Only `query` is used (see FakePool).
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
    expect(pool.calls.map((call) => call.sql)).toEqual([
      expect.stringContaining("refresh_continuous_aggregate('cii_daily'"),
      expect.stringContaining("refresh_continuous_aggregate('cii_annual'"),
    ]);
    const [dailyFrom, dailyTo] = pool.calls[0]?.params as [Date, Date];
    expect((dailyTo.getTime() - dailyFrom.getTime()) / 86_400_000).toBe(400);
    expect(dailyTo.getUTCHours()).toBe(0);
    const [annualFrom, annualTo] = pool.calls[1]?.params as [Date, Date];
    expect(annualTo.getUTCFullYear() - annualFrom.getUTCFullYear()).toBe(3);
    expect(annualTo.getUTCMonth()).toBe(0);

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
      expect(pool.calls.map((call) => call.sql)).toEqual([
        expect.stringContaining("refresh_continuous_aggregate('cii_daily'"),
        expect.stringContaining("refresh_continuous_aggregate('cii_annual'"),
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
        { code: PG_LOCK_NOT_AVAILABLE },
      );
    pool.errors.push(concurrent());
    await service.refreshNow();
    expect(pool.calls.map((call) => call.sql)).toEqual([
      expect.stringContaining("refresh_continuous_aggregate('cii_daily'"),
      expect.stringContaining("refresh_continuous_aggregate('cii_annual'"),
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
