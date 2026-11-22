import {
  type AisPositionRecordedV1,
  EVENT_TYPES,
  parseEnvelope,
  subjects,
} from '@darmawanweb/ais-its-contracts/events';
import { NatsClient } from '@darmawanweb/ais-its-nest/nats';
import { waitFor } from '@darmawanweb/ais-its-nest/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { ProfileDirectory } from '../src/modules/profiles/profile-directory.js';
import { SegmentsRepository } from '../src/modules/segments/segments.repository.js';
import { expectClose } from './support/golden.js';
import { snapshotOfLegacyShip, testUuid } from './support/legacy-ship.js';
import {
  legacyShip,
  segmentsOf,
  waitForProfile,
  waitForSegments,
} from './support/scenario.js';
import { startTestService, type TestService } from './support/test-service.js';

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const ADMIN = { roles: ['super_admin'], orgId: null } as const;
const ORG = testUuid(9501);
const OTHER_ORG = testUuid(9502);
const MANAGER = { roles: ['fleet_manager'], orgId: ORG } as const;
const OTHER_MANAGER = { roles: ['fleet_manager'], orgId: OTHER_ORG } as const;

interface Fix {
  readonly time: Date;
  readonly lat: number;
  readonly lon: number;
}

interface Job {
  id: string;
  status: 'running' | 'succeeded' | 'failed';
  replayed: number;
  segments: number;
  deleted: number;
  error: string | null;
}

/** The `ais.position.recorded.v1` of the segment `previous → current` (navstatus 0, 10 kn reported). */
function position(
  mmsi: number,
  previous: Fix,
  current: Fix,
): AisPositionRecordedV1 {
  const kinematics = { sog: 10, cog: 45, hdg: 45, navstatus: 0 };
  return {
    mmsi,
    time: current.time.toISOString(),
    source: 'primary',
    lat: current.lat,
    lon: current.lon,
    ...kinematics,
    predictedNavstatus: 0,
    coastDistanceM: null,
    previous: {
      time: previous.time.toISOString(),
      lat: previous.lat,
      lon: previous.lon,
      ...kinematics,
      predictedNavstatus: 0,
    },
  };
}

/** `count + 1` fixes 5 s apart ending `endsAgoMs` before now, moving north-east. */
function track(
  count: number,
  endsAgoMs: number,
  origin: Fix['lat'] = 1,
): Fix[] {
  const start = Date.now() - endsAgoMs - count * 5_000;
  return Array.from({ length: count + 1 }, (_, i) => ({
    time: new Date(start + i * 5_000),
    lat: origin + i * 0.0001,
    lon: 104 + i * 0.0001,
  }));
}

async function publishTrack(
  service: TestService,
  mmsi: number,
  fixes: readonly Fix[],
): Promise<void> {
  for (let i = 1; i < fixes.length; i += 1) {
    const previous = fixes[i - 1];
    const current = fixes[i];
    if (previous === undefined || current === undefined) continue;
    await service.publish(
      EVENT_TYPES.AIS_POSITION_RECORDED,
      position(mmsi, previous, current),
    );
  }
}

async function segmentCount(
  service: TestService,
  mmsi: number,
): Promise<number> {
  const { rows } = await service.pool.query<{ n: number }>(
    'SELECT count(*)::int AS n FROM segments WHERE mmsi = $1',
    [mmsi],
  );
  return rows[0]?.n ?? 0;
}

async function jobRow(service: TestService, id: string): Promise<Job> {
  const { rows } = await service.pool.query<Job>(
    'SELECT id, status, replayed, segments, deleted, error FROM recompute_jobs WHERE id = $1',
    [id],
  );
  const row = rows[0];
  if (row === undefined) throw new Error(`no job ${id}`);
  return row;
}

async function finishedJob(service: TestService, id: string): Promise<Job> {
  return waitFor(
    async () => {
      const job = await jobRow(service, id);
      return job.status === 'running' ? undefined : job;
    },
    { timeoutMs: 120_000, message: `recomputation ${id}` },
  );
}

describe('hardening: concurrency, recomputation and tenancy of the history', () => {
  let service: TestService;
  const ship = legacyShip('A');

  beforeAll(async () => {
    // One instance per describe: two instances would both consume every event
    // (separate durable consumers) and race on the shared tables.
    service = await startTestService({
      WEATHER_TIMEOUT_MS: '3000',
      TELEMETRY_MAX_PERIOD_H: '48',
    });
  });

  afterAll(async () => {
    await service.close();
  });

  it('attributes a fuel reading stored while the segment of its window waits for the weather (vessel lock)', async () => {
    const mmsi = 525710001;
    await service.publish(
      EVENT_TYPES.FLEET_VESSEL_UPSERTED,
      snapshotOfLegacyShip(ship, 51, {
        mmsi,
        orgId: ORG,
        firstFuelFormula: false,
      }),
    );
    await waitForProfile(service, mmsi);
    const t0 = new Date(Date.now() - 20 * MINUTE_MS);
    const t1 = new Date(Date.now() - 10 * MINUTE_MS);
    // A cell no other test asks for (no cached weather), and a hanging Open-Meteo:
    // the builder waits WEATHER_TIMEOUT_MS (3 s) for the wind.
    service.weather.answer = () => ({ kind: 'hang' });
    try {
      const asked = service.weather.requests.length;
      await service.publish(
        EVENT_TYPES.AIS_POSITION_RECORDED,
        position(
          mmsi,
          { time: t0, lat: -7.61, lon: 112.93 },
          { time: t1, lat: -7.59, lon: 112.96 },
        ),
      );
      await waitFor(() => service.weather.requests.length > asked, {
        timeoutMs: 10_000,
        message: 'weather request of the segment',
      });
      await service.publish(EVENT_TYPES.FUEL_READING_RECORDED, {
        mmsi,
        time: t1.toISOString(),
        periodStart: t0.toISOString(),
        fuelMeTon: 0.5,
        fuelAeTon: 0.1,
        deviceId: null,
        source: 'api',
      });
      const [segment] = await waitForSegments(service, mmsi, 1);
      expect(segment?.method).toBe('telemetry');
      expectClose(segment?.fuelMeTon ?? Number.NaN, 0.5, 'ME of the period');
      expectClose(segment?.fuelAeTon ?? Number.NaN, 0.1, 'AE of the period');
      expect(segment?.flags).not.toContain('weather_unavailable');
      expect(segment?.weather).toBeNull();
    } finally {
      service.weather.answer = () => ({
        kind: 'wind',
        speedKn: 12,
        directionDeg: 45,
      });
    }
  });

  it('finds period readings up to TELEMETRY_MAX_PERIOD_H long for a segment built after them', async () => {
    const mmsi = 525710002;
    await service.publish(
      EVENT_TYPES.FLEET_VESSEL_UPSERTED,
      snapshotOfLegacyShip(ship, 52, { mmsi, orgId: ORG }),
    );
    await waitForProfile(service, mmsi);
    const end = Date.now() - HOUR_MS;
    // a 46 h period reading (TELEMETRY_MAX_PERIOD_H = 48 in this file) …
    await service.publish(EVENT_TYPES.FUEL_READING_RECORDED, {
      mmsi,
      time: new Date(end).toISOString(),
      periodStart: new Date(end - 46 * HOUR_MS).toISOString(),
      fuelMeTon: 46,
      fuelAeTon: 4.6,
      deviceId: null,
      source: 'api',
    });
    await waitFor(
      async () =>
        (
          await service.pool.query(
            'SELECT 1 FROM fuel_readings WHERE mmsi = $1',
            [mmsi],
          )
        ).rowCount === 1,
      { timeoutMs: 10_000, message: 'stored reading' },
    );
    // … then a 30 min segment 40 h before its end (beyond the former fixed 24 h bound)
    const t0 = new Date(end - 40 * HOUR_MS);
    const t1 = new Date(t0.getTime() + 30 * MINUTE_MS);
    await service.publish(
      EVENT_TYPES.AIS_POSITION_RECORDED,
      position(
        mmsi,
        { time: t0, lat: 1.2, lon: 104.1 },
        { time: t1, lat: 1.25, lon: 104.15 },
      ),
    );
    const [segment] = await waitForSegments(service, mmsi, 1);
    expect(segment?.method).toBe('telemetry');
    // pro rata: 0.5 h of a 46 h period
    expectClose(segment?.fuelMeTon ?? Number.NaN, 46 * (0.5 / 46), 'ME share');
    expectClose(segment?.fuelAeTon ?? Number.NaN, 4.6 * (0.5 / 46), 'AE share');
  });

  it('never lets a stale FLEET snapshot remove the vessel that holds its MMSI now', async () => {
    const mmsiA = 525710011;
    const mmsiB = 525710012;
    const idA = testUuid(9511);
    const idB = testUuid(9512);
    await service.publish(
      EVENT_TYPES.FLEET_VESSEL_UPSERTED,
      snapshotOfLegacyShip(ship, 53, {
        id: idA,
        mmsi: mmsiA,
        orgId: ORG,
        updatedAt: '2026-02-01T00:00:00.000Z',
      }),
    );
    await service.publish(
      EVENT_TYPES.FLEET_VESSEL_UPSERTED,
      snapshotOfLegacyShip(ship, 54, {
        id: idB,
        mmsi: mmsiB,
        orgId: OTHER_ORG,
        updatedAt: '2026-03-01T00:00:00.000Z',
      }),
    );
    await waitForProfile(service, mmsiA);
    await waitForProfile(service, mmsiB);
    // a redelivered snapshot of A from when A held B's current MMSI
    await service.publish(
      EVENT_TYPES.FLEET_VESSEL_UPSERTED,
      snapshotOfLegacyShip(ship, 53, {
        id: idA,
        mmsi: mmsiB,
        orgId: ORG,
        updatedAt: '2026-01-01T00:00:00.000Z',
      }),
    );
    // a later snapshot of A (a marker that the stale one was consumed before it)
    await service.publish(
      EVENT_TYPES.FLEET_VESSEL_UPSERTED,
      snapshotOfLegacyShip(ship, 53, {
        id: idA,
        mmsi: mmsiA,
        orgId: ORG,
        updatedAt: '2026-02-02T00:00:00.000Z',
      }),
    );
    await waitForProfile(service, mmsiA, '2026-02-02T00:00:00.000Z');
    const { rows } = await service.pool.query<{
      vessel_id: string;
      mmsi: number;
    }>(
      'SELECT vessel_id, mmsi FROM vessel_profiles WHERE vessel_id = ANY($1::uuid[]) ORDER BY mmsi',
      [[idA, idB]],
    );
    expect(rows).toEqual([
      { vessel_id: idA, mmsi: mmsiA },
      { vessel_id: idB, mmsi: mmsiB },
    ]);
    const directory = service.app.get(ProfileDirectory);
    expect(directory.get(mmsiB)?.profile.vesselId).toBe(idB);
    expect(directory.get(mmsiA)?.profile.vesselId).toBe(idA);
  });

  describe('the history follows the vessel, not the MMSI (spec §8.5)', () => {
    const reused = 525710021;
    const oldVessel = testUuid(9521);
    const newVessel = testUuid(9522);
    const moving = testUuid(9523);
    const firstMmsi = 525710023;
    const secondMmsi = 525710024;
    const year = new Date().getUTCFullYear();

    beforeAll(async () => {
      await service.publish(
        EVENT_TYPES.FLEET_VESSEL_UPSERTED,
        snapshotOfLegacyShip(ship, 55, {
          id: oldVessel,
          mmsi: reused,
          orgId: ORG,
          updatedAt: '2026-01-01T00:00:00.000Z',
        }),
      );
      await waitForProfile(service, reused);
      const t0 = new Date(Date.now() - 30 * MINUTE_MS);
      const t1 = new Date(Date.now() - 20 * MINUTE_MS);
      await service.publish(
        EVENT_TYPES.AIS_POSITION_RECORDED,
        position(
          reused,
          { time: t0, lat: 1.1, lon: 104 },
          { time: t1, lat: 1.12, lon: 104.03 },
        ),
      );
      await waitForSegments(service, reused, 1);
      const manual = await service.request({
        method: 'PUT',
        url: `/api/v2/cii/vessels/${reused}/annual-manual/2024`,
        as: MANAGER,
        body: { attained: 9.5, distanceNm: 1000, fuelMeTon: 20, fuelAeTon: 2 },
      });
      expect(manual.statusCode).toBe(200);
      // the fleet deletes the vessel and registers the MMSI for another organization's vessel
      await service.publish(EVENT_TYPES.FLEET_VESSEL_DELETED, {
        id: oldVessel,
        mmsi: reused,
        orgId: ORG,
      });
      await service.publish(
        EVENT_TYPES.FLEET_VESSEL_UPSERTED,
        snapshotOfLegacyShip(ship, 56, {
          id: newVessel,
          mmsi: reused,
          orgId: OTHER_ORG,
          updatedAt: '2026-06-01T00:00:00.000Z',
        }),
      );
      await waitForProfile(service, reused, '2026-06-01T00:00:00.000Z');
    });

    it("does not show the previous vessel's segments, CII, manual records or DCS to the new holder of a re-used MMSI", async () => {
      const segments = await service.request({
        url: `/api/v2/cii/vessels/${reused}/segments`,
        as: OTHER_MANAGER,
      });
      expect(segments.statusCode).toBe(200);
      expect(segments.json<{ data: unknown[] }>().data).toEqual([]);
      for (const url of [
        `/api/v2/cii/vessels/${reused}/current?year=${year}`,
        `/api/v2/cii/vessels/${reused}/annual`,
        `/api/v2/emission/vessels/${reused}/dcs?year=${year}`,
        `/api/v2/emission/vessels/${reused}/dcs?year=2024`,
      ]) {
        const response = await service.request({ url, as: OTHER_MANAGER });
        expect(response.statusCode, url).toBe(404);
        expect(response.json<{ code: string }>().code, url).toBe(
          'CII_NOT_AVAILABLE',
        );
      }
      const manual = await service.request({
        url: `/api/v2/cii/vessels/${reused}/annual-manual/2024`,
        as: OTHER_MANAGER,
      });
      expect(manual.statusCode).toBe(404);
      // the former owner has no access to the MMSI any more
      const former = await service.request({
        url: `/api/v2/cii/vessels/${reused}/segments`,
        as: MANAGER,
      });
      expect(former.statusCode).toBe(403);
      // the stored rows of the deleted vessel are untouched (unreachable)
      const [row] = await segmentsOf(service, reused);
      expect(row).toBeDefined();
    });

    it('keeps the history of a vessel whose MMSI changes', async () => {
      await service.publish(
        EVENT_TYPES.FLEET_VESSEL_UPSERTED,
        snapshotOfLegacyShip(ship, 57, {
          id: moving,
          mmsi: firstMmsi,
          orgId: ORG,
          updatedAt: '2026-01-01T00:00:00.000Z',
        }),
      );
      await waitForProfile(service, firstMmsi);
      const t0 = new Date(Date.now() - 40 * MINUTE_MS);
      const t1 = new Date(Date.now() - 35 * MINUTE_MS);
      const t2 = new Date(Date.now() - 30 * MINUTE_MS);
      await service.publish(
        EVENT_TYPES.AIS_POSITION_RECORDED,
        position(
          firstMmsi,
          { time: t0, lat: 1.3, lon: 104.2 },
          { time: t1, lat: 1.31, lon: 104.21 },
        ),
      );
      await waitForSegments(service, firstMmsi, 1);
      await service.publish(
        EVENT_TYPES.FLEET_VESSEL_UPSERTED,
        snapshotOfLegacyShip(ship, 57, {
          id: moving,
          mmsi: secondMmsi,
          orgId: ORG,
          updatedAt: '2026-02-01T00:00:00.000Z',
        }),
      );
      await waitForProfile(service, secondMmsi);
      await service.publish(
        EVENT_TYPES.AIS_POSITION_RECORDED,
        position(
          secondMmsi,
          { time: t1, lat: 1.31, lon: 104.21 },
          { time: t2, lat: 1.32, lon: 104.22 },
        ),
      );
      await waitForSegments(service, secondMmsi, 1);
      const segments = await service.request({
        url: `/api/v2/cii/vessels/${secondMmsi}/segments`,
        as: MANAGER,
      });
      expect(
        segments
          .json<{ data: { mmsi: number }[] }>()
          .data.map((segment) => segment.mmsi),
      ).toEqual([secondMmsi, firstMmsi]);
      const cii = await waitFor(
        async () => {
          const response = await service.request({
            url: `/api/v2/cii/vessels/${secondMmsi}/current?year=${year}`,
            as: MANAGER,
          });
          const body = response.json<{ segments: number }>();
          return response.statusCode === 200 && body.segments === 2
            ? body
            : undefined;
        },
        { timeoutMs: 10_000, message: 'CII over both MMSIs' },
      );
      expect(cii.segments).toBe(2);
    });
  });

  describe('POST /cii/vessels/:mmsi/recompute', () => {
    it('refuses a range ending in the future', async () => {
      const mmsi = 525710031;
      await service.publish(
        EVENT_TYPES.FLEET_VESSEL_UPSERTED,
        snapshotOfLegacyShip(ship, 58, { mmsi, orgId: ORG }),
      );
      await waitForProfile(service, mmsi);
      const response = await service.request({
        method: 'POST',
        url: `/api/v2/cii/vessels/${mmsi}/recompute?from=${new Date(Date.now() - HOUR_MS).toISOString()}&to=${new Date(Date.now() + HOUR_MS).toISOString()}`,
        as: ADMIN,
      });
      expect(response.statusCode).toBe(400);
      expect(response.json<{ code: string }>().code).toBe(
        'RECOMPUTE_RANGE_INVALID',
      );
    });

    it('keeps a live segment written while the replay runs and audits the vessel, not the MMSI', async () => {
      const mmsi = 525710032;
      const vesselId = testUuid(9532);
      await service.publish(
        EVENT_TYPES.FLEET_VESSEL_UPSERTED,
        snapshotOfLegacyShip(ship, 59, { id: vesselId, mmsi, orgId: ORG }),
      );
      await waitForProfile(service, mmsi);
      const fixes = track(400, 2 * MINUTE_MS);
      await publishTrack(service, mmsi, fixes);
      await waitFor(async () => (await segmentCount(service, mmsi)) === 400, {
        timeoutMs: 60_000,
        message: '400 segments',
      });
      const started = await service.request({
        method: 'POST',
        url: `/api/v2/cii/vessels/${mmsi}/recompute`,
        as: ADMIN,
      });
      expect(started.statusCode).toBe(202);
      const job = started.json<Job>();
      // once the replay rebuilds segments, its end in the stream is fixed: the
      // next live position is consumed live only, while the job runs
      await waitFor(
        async () =>
          (
            await service.pool.query(
              `SELECT 1 FROM segments s JOIN recompute_jobs j ON j.id = $2
                WHERE s.mmsi = $1 AND s.computed_at > j.created_at LIMIT 1`,
              [mmsi, job.id],
            )
          ).rowCount === 1,
        { timeoutMs: 30_000, message: 'replay under way' },
      );
      // the next live position: previous = the last fix before `to`
      const lastFix = fixes.at(-1);
      if (lastFix === undefined) throw new Error('empty track');
      await service.publish(
        EVENT_TYPES.AIS_POSITION_RECORDED,
        position(mmsi, lastFix, {
          time: new Date(),
          lat: lastFix.lat + 0.01,
          lon: lastFix.lon + 0.01,
        }),
      );
      await waitFor(async () => (await segmentCount(service, mmsi)) === 401, {
        timeoutMs: 10_000,
        message: 'live segment',
      });
      const finished = await finishedJob(service, job.id);
      expect(finished).toMatchObject({
        status: 'succeeded',
        replayed: 400,
        segments: 400,
        deleted: 0,
        error: null,
      });
      expect(await segmentCount(service, mmsi)).toBe(401);

      const audit = await service.app
        .get(NatsClient)
        .ready()
        .then(({ manager }) =>
          manager.streams.getMessage('AUDIT', {
            last_by_subj: subjects.audit('emission'),
          }),
        );
      const parsed = audit === null ? undefined : parseEnvelope(audit.data);
      expect(
        parsed?.success === true &&
          parsed.envelope.type === EVENT_TYPES.AUDIT_RECORDED
          ? parsed.envelope.data
          : undefined,
      ).toMatchObject({
        action: 'cii.recompute',
        targetType: 'vessel',
        targetId: vesselId,
        orgId: ORG,
        meta: { mmsi, jobId: job.id },
      });
    }, 180_000);

    it('deletes nothing and fails when AIS_POSITION holds no position of the range', async () => {
      const mmsi = 525710033;
      await service.publish(
        EVENT_TYPES.FLEET_VESSEL_UPSERTED,
        snapshotOfLegacyShip(ship, 60, { mmsi, orgId: ORG }),
      );
      await waitForProfile(service, mmsi);
      // segments whose positions are not in the stream (e.g. it was purged or recreated)
      await service.pool.query(
        `INSERT INTO segments (time_start, time_end, mmsi, vessel_id, distance_nm, speed_kn, fuel_me_ton, fuel_ae_ton,
                               co2_ton, method, navstatus, fuel_code, conversion_factor)
         SELECT t, t + interval '5 minutes', mmsi, vessel_id, 1, 6, 0.01, 0.001, 0.035, 'first_formula', 0,
                'diesel_gas_oil', 3.206
           FROM vessel_profiles,
                generate_series(now() - interval '5 hours', now() - interval '1 hour', interval '30 minutes') AS t
          WHERE mmsi = $1`,
        [mmsi],
      );
      const before = await segmentCount(service, mmsi);
      expect(before).toBe(9);
      const started = await service.request({
        method: 'POST',
        url: `/api/v2/cii/vessels/${mmsi}/recompute`,
        as: ADMIN,
      });
      expect(started.statusCode).toBe(202);
      const finished = await finishedJob(service, started.json<Job>().id);
      expect(finished.status).toBe('failed');
      expect(finished.error).toMatch(/^NO_POSITIONS: /);
      expect(finished.deleted).toBe(0);
      expect(await segmentCount(service, mmsi)).toBe(before);
    });

    it('fails a running job without heartbeat instead of blocking the vessel (409 only while it is alive)', async () => {
      const mmsi = 525710034;
      await service.publish(
        EVENT_TYPES.FLEET_VESSEL_UPSERTED,
        snapshotOfLegacyShip(ship, 61, { mmsi, orgId: ORG }),
      );
      await waitForProfile(service, mmsi);
      const insertRunning = (id: string, heartbeatAgo: string) =>
        service.pool.query(
          `INSERT INTO recompute_jobs (id, mmsi, from_time, to_time, status, created_at, heartbeat_at)
           VALUES ($1, $2, now() - interval '2 hours', now() - interval '1 hour', 'running',
                   now() - interval '5 minutes', now() - $3::interval)`,
          [id, mmsi, heartbeatAgo],
        );
      const alive = testUuid(9541);
      await insertRunning(alive, '1 second');
      const blocked = await service.request({
        method: 'POST',
        url: `/api/v2/cii/vessels/${mmsi}/recompute`,
        as: ADMIN,
      });
      expect(blocked.statusCode).toBe(409);
      expect(blocked.json<{ code: string }>().code).toBe(
        'RECOMPUTE_IN_PROGRESS',
      );
      // the instance running it stopped: its heartbeat is older than 60 s
      await service.pool.query(
        "UPDATE recompute_jobs SET heartbeat_at = now() - interval '5 minutes' WHERE id = $1",
        [alive],
      );
      const started = await service.request({
        method: 'POST',
        url: `/api/v2/cii/vessels/${mmsi}/recompute`,
        as: ADMIN,
      });
      expect(started.statusCode).toBe(202);
      const interrupted = await jobRow(service, alive);
      expect(interrupted.status).toBe('failed');
      expect(interrupted.error).toMatch(/^INTERRUPTED: /);
      await finishedJob(service, started.json<Job>().id);
    });
  });

  it('bounds the overlap search of a fuel reading to the chunks of its window (compressed history untouched)', async () => {
    const mmsi = 525710041;
    await service.pool.query(
      `INSERT INTO segments (time_start, time_end, mmsi, vessel_id, distance_nm, speed_kn, fuel_me_ton, fuel_ae_ton,
                             co2_ton, method, navstatus, fuel_code, conversion_factor)
       SELECT t, t + interval '10 minutes', $1, $2, 1, 6, 0.01, 0.001, 0.035, 'first_formula', 0, 'diesel_gas_oil', 3.206
         FROM generate_series(now() - interval '400 days', now() - interval '1 hour', interval '1 day') AS t`,
      [mmsi, testUuid(9551)],
    );
    await service.pool.query(
      `SELECT compress_chunk(c, if_not_compressed => true)
         FROM show_chunks('segments', older_than => interval '30 days') AS c`,
    );
    const to = new Date(Date.now() - 10 * MINUTE_MS);
    const from = new Date(to.getTime() - 20 * MINUTE_MS);
    const query = service.app
      .get(SegmentsRepository)
      .overlappingQuery(
        mmsi,
        from,
        to,
        service.config.SEGMENT_MAX_GAP_MIN * MINUTE_MS,
      )
      .toSQL();
    const { rows } = await service.pool.query<{ 'QUERY PLAN': string }>(
      `EXPLAIN (ANALYZE, BUFFERS) ${query.sql}`,
      query.params,
    );
    const plan = rows.map((row) => row['QUERY PLAN']).join('\n');
    expect(plan).not.toMatch(/DecompressChunk|ColumnarScan/);
    expect(
      (plan.match(/ on _hyper_\d+_\d+_chunk/g) ?? []).length,
    ).toBeLessThanOrEqual(2);
  });
});

describe('hardening: shutdown during a recomputation', () => {
  it('cancels the job, records it as failed and keeps every segment; the next instance can recompute', async () => {
    const mmsi = 525710051;
    const first = await startTestService();
    let second: TestService | undefined;
    try {
      await first.publish(
        EVENT_TYPES.FLEET_VESSEL_UPSERTED,
        snapshotOfLegacyShip(legacyShip('A'), 62, { mmsi, orgId: ORG }),
      );
      await waitForProfile(first, mmsi);
      await publishTrack(first, mmsi, track(1500, 5 * MINUTE_MS, 2));
      await waitFor(async () => (await segmentCount(first, mmsi)) === 1500, {
        timeoutMs: 120_000,
        message: '1500 segments',
      });
      const started = await first.request({
        method: 'POST',
        url: `/api/v2/cii/vessels/${mmsi}/recompute`,
        as: ADMIN,
      });
      expect(started.statusCode).toBe(202);
      const job = started.json<Job>();
      await new Promise((resolve) => setTimeout(resolve, 400));
      await first.close(); // SIGTERM of a rolling deploy while the job runs
      const next = await startTestService();
      second = next;
      expect(await segmentCount(next, mmsi)).toBe(1500);
      const interrupted = await jobRow(next, job.id);
      expect(interrupted.status).toBe('failed');
      expect(interrupted.error).toMatch(/^INTERRUPTED: /);
      expect(interrupted.deleted).toBe(0);
      const again = await next.request({
        method: 'POST',
        url: `/api/v2/cii/vessels/${mmsi}/recompute`,
        as: ADMIN,
      });
      expect(again.statusCode).toBe(202);
      const finished = await finishedJob(next, again.json<Job>().id);
      expect(finished).toMatchObject({
        status: 'succeeded',
        replayed: 1500,
        segments: 1500,
        deleted: 0,
      });
      expect(await segmentCount(next, mmsi)).toBe(1500);
    } finally {
      await second?.close();
    }
  }, 300_000);
});
