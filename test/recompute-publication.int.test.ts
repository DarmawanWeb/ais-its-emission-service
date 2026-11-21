import {
  CiiUpdatedV1Schema,
  EVENT_TYPES,
  parseEnvelope,
  subjects,
} from '@darmawanweb/ais-its-contracts/events';
import { NatsClient } from '@darmawanweb/ais-its-nest/nats';
import { waitFor } from '@darmawanweb/ais-its-nest/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { expectClose } from './support/golden.js';
import { snapshotOfLegacyShip, testUuid } from './support/legacy-ship.js';
import {
  legacyShip,
  positionOf,
  segmentsOf,
  speedCase,
  waitForProfile,
  waitForSegments,
} from './support/scenario.js';
import { startTestService, type TestService } from './support/test-service.js';

const MINUTE_MS = 60_000;
const ORG = testUuid(9301);
const ADMIN = { roles: ['super_admin'], orgId: null } as const;
const MANAGER = { roles: ['fleet_manager'], orgId: ORG } as const;
const PUBLISHED_MMSI = 525300001;
const RECOMPUTED_MMSI = 525300002;
const INTERVAL_S = 3;

interface Job {
  id: string;
  status: 'running' | 'succeeded' | 'failed';
  replayed: number;
  segments: number;
  deleted: number;
  error: string | null;
}

describe('emission.cii.updated.v1 publication and recomputation by replay', () => {
  let service: TestService;
  const ship = legacyShip('A');
  const cases = [
    'northeast-13kn',
    'southwest-8kn',
    'due-north',
    'due-east',
  ].map(speedCase);
  /** Each case moved to start at `base + index × 30 min`. */
  const positionsAt = (mmsi: number, base: number) =>
    cases.map((c, index) =>
      positionOf(
        mmsi,
        c,
        base + index * 30 * MINUTE_MS - Date.parse(c.previous.time),
      ),
    );

  beforeAll(async () => {
    service = await startTestService({
      CII_PUBLISH_INTERVAL_S: String(INTERVAL_S),
      CII_PUBLISH_POLL_MS: '100',
    });
    await service.publish(
      EVENT_TYPES.FLEET_VESSEL_UPSERTED,
      snapshotOfLegacyShip(ship, 31, { mmsi: PUBLISHED_MMSI, orgId: ORG }),
    );
    await service.publish(
      EVENT_TYPES.FLEET_VESSEL_UPSERTED,
      snapshotOfLegacyShip(ship, 32, { mmsi: RECOMPUTED_MMSI, orgId: ORG }),
    );
    await waitForProfile(service, PUBLISHED_MMSI);
    await waitForProfile(service, RECOMPUTED_MMSI);
  });

  afterAll(async () => {
    await service.close();
  });

  describe('throttled publication (CII_PUBLISH_INTERVAL_S)', () => {
    const subject = subjects.ciiUpdated(PUBLISHED_MMSI);
    let firstPublishedAt = 0;

    async function publishedCount(): Promise<number> {
      const info = await service.app
        .get(NatsClient)
        .manager.streams.info('EMISSION', { subjects_filter: subject });
      return info.state.subjects?.[subject] ?? 0;
    }

    async function lastPublished() {
      const message = await service.app
        .get(NatsClient)
        .manager.streams.getMessage('EMISSION', { last_by_subj: subject });
      if (message === null) throw new Error(`no message on ${subject}`);
      const parsed = parseEnvelope(message.data);
      if (
        !parsed.success ||
        parsed.envelope.type !== EVENT_TYPES.EMISSION_CII_UPDATED
      )
        throw new Error('not a CII event');
      return parsed.envelope;
    }

    it('publishes the year-to-date CII after the first segments', async () => {
      const base = Date.now() - 6 * 60 * MINUTE_MS;
      for (const position of positionsAt(PUBLISHED_MMSI, base).slice(0, 2))
        await service.publish(EVENT_TYPES.AIS_POSITION_RECORDED, position);
      await waitForSegments(service, PUBLISHED_MMSI, 2);
      await waitFor(async () => (await publishedCount()) === 1, {
        timeoutMs: 10_000,
        message: 'first publication',
      });
      const envelope = await lastPublished();
      firstPublishedAt = Date.parse(envelope.time);
      expect(envelope.source).toBe('emission');
      expect(CiiUpdatedV1Schema.safeParse(envelope.data).success).toBe(true);
      const year = new Date().getUTCFullYear();
      const cii = (
        await service.request({
          url: `/api/v2/cii/vessels/${PUBLISHED_MMSI}/current?year=${year}`,
          as: MANAGER,
        })
      ).json<{
        attained: number;
        required: number;
        rating: number;
        grade: string;
        distanceNm: number;
        vesselId: string;
      }>();
      expect(envelope.data).toMatchObject({
        mmsi: PUBLISHED_MMSI,
        vesselId: cii.vesselId,
        orgId: ORG,
        year,
        grade: cii.grade,
        lastMethod: 'first_formula',
      });
      expectClose(envelope.data.attained, cii.attained, 'published attained');
      expectClose(envelope.data.required, cii.required, 'published required');
      expectClose(
        envelope.data.distanceNm,
        cii.distanceNm,
        'published distance',
      );
    });

    it('publishes changes within the interval once, when the interval has elapsed', async () => {
      const base = Date.now() - 4 * 60 * MINUTE_MS;
      for (const position of positionsAt(PUBLISHED_MMSI, base))
        await service.publish(EVENT_TYPES.AIS_POSITION_RECORDED, position);
      await waitForSegments(service, PUBLISHED_MMSI, 6);
      // still throttled while the first publication is less than CII_PUBLISH_INTERVAL_S old
      const count = await publishedCount();
      if (Date.now() - firstPublishedAt < (INTERVAL_S - 0.5) * 1000)
        expect(count).toBe(1);
      await waitFor(async () => (await publishedCount()) === 2, {
        timeoutMs: (INTERVAL_S + 5) * 1000,
        message: 'second publication',
      });
      const envelope = await lastPublished();
      const segments = await segmentsOf(service, PUBLISHED_MMSI);
      expectClose(
        envelope.data.distanceNm,
        segments.reduce((sum, segment) => sum + segment.distanceNm, 0),
        'all six segments',
      );
      // nothing changed since: no further event, even after another interval
      await new Promise((resolve) =>
        setTimeout(resolve, (INTERVAL_S + 1) * 1000),
      );
      expect(await publishedCount()).toBe(2);
    });
  });

  describe('POST /cii/vessels/:mmsi/recompute', () => {
    const base = Date.now() - 3 * 60 * MINUTE_MS;
    const strayStart = new Date(base - 20 * MINUTE_MS);

    beforeAll(async () => {
      for (const position of positionsAt(RECOMPUTED_MMSI, base))
        await service.publish(EVENT_TYPES.AIS_POSITION_RECORDED, position);
      const segments = await waitForSegments(service, RECOMPUTED_MMSI, 4);
      expect(segments.map((segment) => segment.method)).toEqual([
        'first_formula',
        'first_formula',
        'first_formula',
        'first_formula',
      ]);
      // a segment the replay will not produce again (e.g. from an earlier, corrected position)
      await service.pool.query(
        `INSERT INTO segments (time_start, time_end, mmsi, vessel_id, distance_nm, speed_kn, fuel_me_ton, fuel_ae_ton, co2_ton,
                               method, navstatus, fuel_code, conversion_factor)
         SELECT $1, $2, mmsi, vessel_id, 1, 6, 0.01, 0.001, 0.035, 'first_formula', 0, 'diesel_gas_oil', 3.206
           FROM vessel_profiles WHERE mmsi = $3`,
        [
          strayStart,
          new Date(strayStart.getTime() + 10 * MINUTE_MS),
          RECOMPUTED_MMSI,
        ],
      );
      // the fleet removes the first fuel formula: live segments keep their old method until recomputed
      const updatedAt = new Date().toISOString();
      await service.publish(
        EVENT_TYPES.FLEET_VESSEL_UPSERTED,
        snapshotOfLegacyShip(ship, 32, {
          mmsi: RECOMPUTED_MMSI,
          orgId: ORG,
          firstFuelFormula: false,
          updatedAt,
        }),
      );
      await waitForProfile(service, RECOMPUTED_MMSI, updatedAt);
    });

    it('is reserved to platform administrators and limited to the stream retention', async () => {
      const from = new Date(base - 30 * MINUTE_MS).toISOString();
      const asManager = await service.request({
        method: 'POST',
        url: `/api/v2/cii/vessels/${RECOMPUTED_MMSI}/recompute?from=${from}`,
        as: MANAGER,
      });
      expect(asManager.statusCode).toBe(403);
      expect(asManager.json<{ code: string }>().code).toBe(
        'SUPER_ADMIN_REQUIRED',
      );
      const tooOld = await service.request({
        method: 'POST',
        url: `/api/v2/cii/vessels/${RECOMPUTED_MMSI}/recompute?from=${new Date(Date.now() - 9 * 86_400_000).toISOString()}&to=${new Date(Date.now() - 8 * 86_400_000).toISOString()}`,
        as: ADMIN,
      });
      expect(tooOld.statusCode).toBe(400);
      expect(tooOld.json<{ code: string }>().code).toBe(
        'RECOMPUTE_RANGE_INVALID',
      );
    });

    it('replays AIS_POSITION with an ephemeral consumer and rebuilds the segments of the range', async () => {
      const from = new Date(base - 30 * MINUTE_MS).toISOString();
      const to = new Date().toISOString();
      const started = await service.request({
        method: 'POST',
        url: `/api/v2/cii/vessels/${RECOMPUTED_MMSI}/recompute?from=${from}&to=${to}`,
        as: ADMIN,
      });
      expect(started.statusCode).toBe(202);
      const job = started.json<Job>();
      expect(job.status).toBe('running');
      const finished = await waitFor(
        async () => {
          const current = (
            await service.request({
              url: `/api/v2/cii/recompute-jobs/${job.id}`,
              as: ADMIN,
            })
          ).json<Job>();
          return current.status === 'running' ? undefined : current;
        },
        { timeoutMs: 30_000, message: 'recomputation' },
      );
      expect(finished).toMatchObject({
        status: 'succeeded',
        replayed: 4,
        segments: 4,
        deleted: 1,
        error: null,
      });

      const segments = await segmentsOf(service, RECOMPUTED_MMSI);
      expect(segments).toHaveLength(4);
      expect(segments.map((segment) => segment.method)).toEqual([
        'holtrop',
        'holtrop',
        'holtrop',
        'holtrop',
      ]);
      expect(
        segments.every((segment) => segment.weather?.source === 'open-meteo'),
      ).toBe(true);
      expect(
        segments.some(
          (segment) => segment.timeStart.getTime() === strayStart.getTime(),
        ),
      ).toBe(false);

      const year = new Date().getUTCFullYear();
      const cii = (
        await service.request({
          url: `/api/v2/cii/vessels/${RECOMPUTED_MMSI}/current?year=${year}`,
          as: MANAGER,
        })
      ).json<{
        lastMethod: string;
        methods: { holtrop: number; firstFormula: number };
        segments: number;
      }>();
      expect(cii).toMatchObject({
        lastMethod: 'holtrop',
        segments: 4,
        methods: { holtrop: 4, firstFormula: 0 },
      });

      const again = await service.request({
        url: `/api/v2/cii/recompute-jobs/${testUuid(1)}`,
        as: ADMIN,
      });
      expect(again.statusCode).toBe(404);
    });
  });
});
