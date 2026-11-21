import { loadConfig } from '@darmawanweb/ais-its-nest';
import type { Pool } from '@darmawanweb/ais-its-nest/db';
import { describe, expect, it } from 'vitest';

import { configSchema } from '../../config.js';
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
  private active = 0;
  maxActive = 0;

  constructor(private readonly delayMs: number) {}

  async query(sql: string, params: unknown[]): Promise<{ rows: [] }> {
    this.active += 1;
    this.maxActive = Math.max(this.maxActive, this.active);
    const startedAt = Date.now();
    await new Promise((resolve) => setTimeout(resolve, this.delayMs));
    this.active -= 1;
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
