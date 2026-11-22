import { copyFile, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runMigrations } from '@darmawanweb/ais-its-nest/db';
import { provisionServiceSchema } from '@darmawanweb/ais-its-nest/testing';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

/** The service schema (0001 names it), in a database of its own: the other test files are not disturbed. */
const SCHEMA = 'emission';
const DATABASE = `emission_upgrade_${String(process.pid)}`;
const VESSEL_A = '0190d5c0-0000-7000-8000-0000000a0001';
const VESSEL_B = '0190d5c0-0000-7000-8000-0000000a0002';
const MMSI_A = 525_700_101;
const MMSI_B = 525_700_102;
/** No vessel holds it: its manual record cannot be attributed. */
const MMSI_ORPHAN = 525_700_199;

/** `CALL refresh_continuous_aggregate` retried while a policy job refreshes the same window (55P03). */
async function refresh(pool: pg.Pool, view: string): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await pool.query(`CALL refresh_continuous_aggregate($1, NULL, NULL)`, [
        view,
      ]);
      return;
    } catch (error) {
      const code = (error as { code?: unknown }).code;
      if (code !== '55P03' || attempt >= 40) throw error;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
}

/**
 * Upgrade of a 0.1.0 database (migrations 0001–0003, CII keyed by MMSI) with
 * data, including chunks compressed under the old settings, to the
 * vessel-scoped history of 0004 / 0005.
 */
describe('migrations: upgrade of a 0.1.0 database to the vessel-scoped history', () => {
  let pool: pg.Pool;
  let oldMigrations: string;
  let admin: pg.Client;

  beforeAll(async () => {
    admin = new pg.Client({ connectionString: inject('infra').adminUrl });
    await admin.connect();
    await admin.query(`CREATE DATABASE "${DATABASE}"`);
    const adminUrl = new URL(inject('infra').adminUrl);
    adminUrl.pathname = `/${DATABASE}`;
    const databaseUrl = await provisionServiceSchema(
      adminUrl.toString(),
      SCHEMA,
    );
    pool = new pg.Pool({
      connectionString: databaseUrl,
      options: `-c search_path=${SCHEMA},public`,
      max: 2,
    });
    oldMigrations = await mkdtemp(join(tmpdir(), 'emission-0.1.0-'));
    for (const file of await readdir('migrations')) {
      if (/^000[1-3]_/.test(file))
        await copyFile(join('migrations', file), join(oldMigrations, file));
    }
    await runMigrations({ pool, schema: SCHEMA, dir: oldMigrations });

    await pool.query(
      `INSERT INTO vessel_profiles (vessel_id, mmsi, org_id, snapshot, snapshot_updated_at)
       VALUES ($1, $2, NULL, '{}', now()), ($3, $4, NULL, '{}', now())`,
      [VESSEL_A, MMSI_A, VESSEL_B, MMSI_B],
    );
    // 90 days of 6-hour segments per vessel, ending yesterday.
    await pool.query(
      `INSERT INTO segments (time_start, time_end, mmsi, vessel_id, distance_nm, speed_kn,
                             fuel_me_ton, fuel_ae_ton, co2_ton, method, navstatus, fuel_code, conversion_factor)
       SELECT t, t + interval '6 hours', v.mmsi, v.id, 60, 10, 1, 0.1, 3.4, 'first_formula', 0, 'HFO', 3.114
         FROM generate_series(date_trunc('day', now()) - interval '90 days',
                              date_trunc('day', now()) - interval '1 day', interval '6 hours') AS t,
              (VALUES ($1::integer, $2::uuid), ($3::integer, $4::uuid)) AS v(mmsi, id)`,
      [MMSI_A, VESSEL_A, MMSI_B, VESSEL_B],
    );
    await pool.query(
      `SELECT compress_chunk(c) FROM show_chunks('segments', older_than => interval '30 days') AS c`,
    );
    await pool.query(
      `INSERT INTO cii_annual_manual (mmsi, year, attained, distance_nm, fuel_me_ton, fuel_ae_ton)
       VALUES ($1, 2024, 5.5, 1000, 10, 1), ($2, 2024, 7.7, 1000, 10, 1)`,
      [MMSI_A, MMSI_ORPHAN],
    );
    await refresh(pool, 'cii_daily');
  });

  afterAll(async () => {
    await pool.end();
    await admin.query(`DROP DATABASE IF EXISTS "${DATABASE}" WITH (FORCE)`);
    await admin.end();
    await rm(oldMigrations, { recursive: true, force: true });
  });

  it('keeps every sum, moves the aggregates and manual records to the vessel and recompresses', async () => {
    const byMmsi = await pool.query<{ mmsi: number; nm: number; co2: number }>(
      `SELECT mmsi, sum(distance_nm)::float AS nm, sum(co2_ton)::float AS co2
         FROM cii_daily GROUP BY mmsi ORDER BY mmsi`,
    );
    expect(byMmsi.rows).toHaveLength(2);

    const result = await runMigrations({
      pool,
      schema: SCHEMA,
      dir: 'migrations',
    });
    expect(result.applied.map((migration) => migration.version)).toEqual([
      4, 5,
    ]);

    const daily = await pool.query<{
      vessel_id: string;
      nm: number;
      co2: number;
    }>(
      `SELECT vessel_id, sum(distance_nm)::float AS nm, sum(co2_ton)::float AS co2
         FROM cii_daily GROUP BY vessel_id ORDER BY vessel_id`,
    );
    expect(daily.rows).toEqual([
      { vessel_id: VESSEL_A, nm: byMmsi.rows[0]?.nm, co2: byMmsi.rows[0]?.co2 },
      { vessel_id: VESSEL_B, nm: byMmsi.rows[1]?.nm, co2: byMmsi.rows[1]?.co2 },
    ]);
    // Materialized (not only real-time) up to today, by the migration itself.
    const materialized = await pool.query<{ watermark: Date | null }>(
      `SELECT _timescaledb_functions.to_timestamp(
                _timescaledb_functions.cagg_watermark(mat_hypertable_id)) AS watermark
         FROM _timescaledb_catalog.continuous_agg WHERE user_view_name = 'cii_daily'
          AND user_view_schema = $1`,
      [SCHEMA],
    );
    expect(materialized.rows[0]?.watermark?.getTime()).toBeGreaterThanOrEqual(
      Date.now() - 2 * 86_400_000,
    );
    const annual = await pool.query<{ vessel_id: string; nm: number }>(
      `SELECT vessel_id, sum(distance_nm)::float AS nm FROM cii_annual GROUP BY vessel_id ORDER BY vessel_id`,
    );
    expect(annual.rows.map((row) => row.nm)).toEqual(
      byMmsi.rows.map((row) => row.nm),
    );

    const manual = await pool.query<{ vessel_id: string; mmsi: number }>(
      `SELECT vessel_id, mmsi FROM cii_annual_manual ORDER BY mmsi`,
    );
    expect(manual.rows).toEqual([{ vessel_id: VESSEL_A, mmsi: MMSI_A }]);

    const policies = await pool.query<{ view: string }>(
      `SELECT hypertable_name::text AS view FROM timescaledb_information.jobs
        WHERE proc_name = 'policy_refresh_continuous_aggregate' AND hypertable_schema = $1`,
      [SCHEMA],
    );
    expect(policies.rows).toHaveLength(2);

    const settings = await pool.query<{ segmentby: string }>(
      `SELECT segmentby FROM timescaledb_information.hypertable_compression_settings
        WHERE hypertable = 'segments'::regclass`,
    );
    expect(settings.rows[0]?.segmentby).toBe('vessel_id,mmsi');
    await pool.query(
      `SELECT decompress_chunk(c) FROM show_chunks('segments', older_than => interval '60 days') AS c`,
    );
    await pool.query(
      `SELECT compress_chunk(c, if_not_compressed => true)
         FROM show_chunks('segments', older_than => interval '30 days') AS c`,
    );
    const segments = await pool.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM segments`,
    );
    expect(segments.rows[0]?.count).toBe(2 * (89 * 4 + 1));
  });
});
