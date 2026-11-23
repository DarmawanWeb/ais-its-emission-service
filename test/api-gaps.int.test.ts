import {
  EVENT_TYPES,
  parseEnvelope,
  subjects,
} from '@darmawanweb/ais-its-contracts/events';
import { NatsClient } from '@darmawanweb/ais-its-nest/nats';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { rateAttained, referenceCii, requiredCii } from '../src/domain/cii.js';
import { ciiRatingProfileOf } from '../src/modules/profiles/vessel-profile.js';
import { AggregateRefresher } from '../src/modules/segments/aggregate-refresher.service.js';
import { snapshotOfLegacyShip, testUuid } from './support/legacy-ship.js';
import { legacyShip, waitForProfile } from './support/scenario.js';
import { startTestService, type TestService } from './support/test-service.js';

/**
 * The endpoints, filters and fields added in 0.2.0 for the web app (fleet
 * fuel totals, fleet summary filters and trend, manual record and reduction
 * factor removal, recomputation job list, SEEMP figures and scenarios,
 * segment filters and CSV, fleet DCS, embedded vessel identity).
 */
const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const ORG = testUuid(9801);
const OTHER_ORG = testUuid(9802);
const MANAGER = { roles: ['fleet_manager'], orgId: ORG } as const;
const VIEWER = { roles: ['viewer'], orgId: ORG } as const;
const ADMIN = { roles: ['super_admin'], orgId: null } as const;
const ORIGIN = 'http://localhost:5173';

/** The vessels of the scenario (ORG unless noted). */
const V = {
  good: { mmsi: 525720001, name: 'Anggrek', index: 81 },
  bad: { mmsi: 525720002, name: 'Bakung', index: 82 },
  manual: { mmsi: 525720003, name: 'Cendana', index: 83 },
  empty: { mmsi: 525720004, name: 'Dahlia', index: 84 },
  other: { mmsi: 525720005, name: 'Edelweiss', index: 85, orgId: OTHER_ORG },
} as const;
type VesselKey = keyof typeof V;

const ship = legacyShip('A');
const now = new Date();
const year = now.getUTCFullYear();
const dayStart = Date.UTC(year, now.getUTCMonth(), now.getUTCDate());
/** Today's segments: all in the same UTC day (hence month and year). */
const todayStart = new Date(
  Math.max(now.getTime() - 5 * HOUR_MS, dayStart + MINUTE_MS),
);
/** Previous-year segments: inside the 400-day refresh window of cii_daily. */
const previousStart = new Date(Date.UTC(year - 1, 11, 10, 6));
const SEGMENTS = 10;
const SEGMENT_NM = 10;

interface Problem {
  code: string;
}
interface FleetItem {
  mmsi: number;
  name: string;
  typeCode: string;
  grade: string | null;
  rating: number | null;
  required: number | null;
  zPercent: number | null;
  source: string | null;
  previousYear: {
    source: string;
    rating: number | null;
    grade: string | null;
  } | null;
}
interface FleetSummary {
  vessels: number;
  notAvailable: number;
  grades: Record<string, number>;
  items: FleetItem[];
  meta: { total: number; page: number; pageSize: number };
}
interface FuelPeriod {
  from: string;
  fuelMeTon: number;
  fuelAeTon: number;
  totalFuelTon: number;
  co2Ton: number;
  vesselsWithData: number;
  manualVessels: number;
}
interface Job {
  id: string;
  mmsi: number;
  status: string;
}
interface Scenario {
  id: string;
  mmsi: number;
  name: string;
  vesselName: string | null;
  createdAt: string;
  updatedAt: string;
}
/** The parts of an OpenAPI schema object the required-property check reads. */
interface Schema {
  $ref?: string;
  allOf?: Schema[];
  required?: string[];
  properties?: Record<string, Schema>;
  items?: Schema;
}

/**
 * Paths of `value` that lack a property `schema` requires, following `$ref`,
 * `allOf`, properties and array items: what a client generated from the
 * published document relies on.
 */
function missingRequired(
  schemas: Readonly<Record<string, Schema>>,
  schema: Schema,
  value: unknown,
  path = '$',
): string[] {
  if (schema.$ref !== undefined) {
    const target = schemas[schema.$ref.replace('#/components/schemas/', '')];
    if (target === undefined) return [`${path}: unknown ${schema.$ref}`];
    return missingRequired(schemas, target, value, path);
  }
  const parts = (schema.allOf ?? []).flatMap((part) =>
    missingRequired(schemas, part, value, path),
  );
  if (value === null || typeof value !== 'object') return parts;
  const { items } = schema;
  if (Array.isArray(value)) {
    return items === undefined
      ? parts
      : value.flatMap((item: unknown, index: number) =>
          missingRequired(schemas, items, item, `${path}[${index}]`),
        );
  }
  const record = value as Record<string, unknown>;
  return [
    ...parts,
    ...(schema.required ?? [])
      .filter((key) => !(key in record))
      .map((key) => `${path}.${key}`),
    ...Object.entries(schema.properties ?? {}).flatMap(([key, property]) =>
      key in record
        ? missingRequired(schemas, property, record[key], `${path}.${key}`)
        : [],
    ),
  ];
}

describe('0.2.0 API additions (web app gaps)', () => {
  let service: TestService;
  const vesselIds = {} as Record<VesselKey, string>;
  let snapshot: ReturnType<typeof snapshotOfLegacyShip>;
  let zOf: (year: number) => number;

  /** Required CII of ship A in a year. */
  const required = (y: number) => {
    const rating = ciiRatingProfileOf(snapshot);
    return requiredCii(
      zOf(y),
      referenceCii(rating.referenceLine, rating.capacity),
    );
  };
  /** Total CO2 (t) giving `rating` over `distanceNm` in year `y`. */
  const co2ForRating = (rating: number, y: number, distanceNm: number) =>
    (rating *
      required(y) *
      ciiRatingProfileOf(snapshot).capacity *
      distanceNm) /
    1e6;
  /** Expected rating and grade of an attained CII in year `y`. */
  const rated = (attained: number, y: number) =>
    rateAttained(attained, required(y), snapshot.type.d);

  /** The data of the last audit record of this service (AUDIT stream). */
  async function lastAudit(): Promise<unknown> {
    const { manager } = await service.app.get(NatsClient).ready();
    const message = await manager.streams.getMessage('AUDIT', {
      last_by_subj: subjects.audit('emission'),
    });
    const parsed = message === null ? undefined : parseEnvelope(message.data);
    return parsed?.success === true &&
      parsed.envelope.type === EVENT_TYPES.AUDIT_RECORDED
      ? parsed.envelope.data
      : undefined;
  }

  async function insertSegments(
    key: VesselKey,
    start: Date,
    totalCo2Ton: number,
    options: { method?: string; flags?: string[]; count?: number } = {},
  ): Promise<void> {
    const count = options.count ?? SEGMENTS;
    const cf = snapshot.fuel.conversionFactor;
    const fuel = totalCo2Ton / cf / count;
    await service.pool.query(
      `INSERT INTO segments (time_start, time_end, mmsi, vessel_id, distance_nm, speed_kn, fuel_me_ton,
                             fuel_ae_ton, co2_ton, method, navstatus, fuel_code, conversion_factor, flags)
       SELECT t, t + interval '10 minutes', $1, $2, $3, 6, $4, $5, $6, $7, 0, $8, $9, $10::text[]
         FROM generate_series($11::timestamptz, $11::timestamptz + ($12::int - 1) * interval '20 minutes',
                              interval '20 minutes') AS t`,
      [
        V[key].mmsi,
        vesselIds[key],
        SEGMENT_NM,
        fuel * 0.8,
        fuel * 0.2,
        totalCo2Ton / count,
        options.method ?? 'first_formula',
        snapshot.fuel.code,
        cf,
        `{${(options.flags ?? []).join(',')}}`,
        start,
        count,
      ],
    );
  }

  beforeAll(async () => {
    service = await startTestService({ CORS_ORIGINS: ORIGIN });
    for (const key of Object.keys(V) as VesselKey[]) {
      const vessel = V[key];
      const snap = snapshotOfLegacyShip(ship, vessel.index, {
        mmsi: vessel.mmsi,
        name: vessel.name,
        orgId: 'orgId' in vessel ? vessel.orgId : ORG,
      });
      snapshot = snap;
      vesselIds[key] = snap.id;
      await service.publish(EVENT_TYPES.FLEET_VESSEL_UPSERTED, snap);
    }
    for (const key of Object.keys(V) as VesselKey[])
      await waitForProfile(service, V[key].mmsi);
    const factors = await service.request({
      url: '/api/v2/reduction-factors',
      as: MANAGER,
    });
    const table = new Map(
      factors
        .json<{ data: { year: number; zPercent: number }[] }>()
        .data.map((factor) => [factor.year, factor.zPercent]),
    );
    zOf = (y) => {
      const z = table.get(y);
      if (z === undefined) throw new Error(`no Z for ${y}`);
      return z;
    };
    const distance = SEGMENTS * SEGMENT_NM;
    // good: rating 0.5 this year and 0.95 last year; bad: rating 3 (no history).
    await insertSegments('good', todayStart, co2ForRating(0.5, year, distance));
    await insertSegments(
      'good',
      previousStart,
      co2ForRating(0.95, year - 1, distance),
    );
    await insertSegments('bad', todayStart, co2ForRating(3, year, distance));
    await insertSegments('other', todayStart, co2ForRating(1, year, distance));
    // gap segments (not counted) of the good vessel for the filters and the CSV
    await insertSegments(
      'good',
      new Date(todayStart.getTime() + 5 * MINUTE_MS),
      0,
      {
        method: 'none',
        flags: ['gap'],
        count: 3,
      },
    );
    // a manual record of the current year (no segments) and an older one to remove
    await service.pool.query(
      `INSERT INTO cii_annual_manual (vessel_id, mmsi, year, attained, distance_nm, fuel_me_ton, fuel_ae_ton)
       VALUES ($1, $2, $3, $4, 1000, 80, 20), ($1, $2, $5, 5, 900, 70, 10)`,
      [vesselIds.manual, V.manual.mmsi, year, 1.05 * required(year), year - 2],
    );
    await service.app.get(AggregateRefresher).refreshNow();
  }, 180_000);

  afterAll(async () => {
    await service.close();
  });

  describe('GET /cii/fleet/summary', () => {
    it('filters, sorts and carries required, zPercent, typeCode and the previous year', async () => {
      const response = await service.request({
        url: `/api/v2/cii/fleet/summary?year=${year}&sort=-rating`,
        as: MANAGER,
      });
      expect(response.statusCode).toBe(200);
      const summary = response.json<FleetSummary>();
      expect(summary.vessels).toBe(4);
      expect(summary.notAvailable).toBe(1);
      expect(summary.items.map((item) => item.mmsi)).toEqual([
        V.bad.mmsi,
        V.manual.mmsi,
        V.good.mmsi,
        V.empty.mmsi,
      ]);
      const good = summary.items.find((item) => item.mmsi === V.good.mmsi);
      const expected = rated(0.5 * required(year), year);
      expect(good).toMatchObject({
        name: 'Anggrek',
        typeCode: snapshot.type.code,
        grade: expected.grade,
        source: 'segments',
        zPercent: zOf(year),
      });
      expect(good?.rating).toBeCloseTo(0.5, 9);
      expect(good?.required).toBeCloseTo(required(year), 9);
      expect(good?.previousYear?.source).toBe('segments');
      expect(good?.previousYear?.rating).toBeCloseTo(0.95, 9);
      expect(good?.previousYear?.grade).toBe(
        rated(0.95 * required(year - 1), year - 1).grade,
      );
      expect(
        summary.items.find((item) => item.mmsi === V.bad.mmsi)?.previousYear,
      ).toBeNull();
      expect(
        summary.items.find((item) => item.mmsi === V.manual.mmsi),
      ).toMatchObject({
        source: 'manual',
        grade: rated(1.05 * required(year), year).grade,
      });
      expect(
        summary.items.find((item) => item.mmsi === V.empty.mmsi)?.grade,
      ).toBeNull();
    });

    it('lists only the requested grades and searches names and MMSI prefixes', async () => {
      const badGrade = rated(3 * required(year), year).grade;
      const byGrade = (
        await service.request({
          url: `/api/v2/cii/fleet/summary?year=${year}&grade=${badGrade.toLowerCase()}`,
          as: MANAGER,
        })
      ).json<FleetSummary>();
      expect(byGrade.items.map((item) => item.mmsi)).toEqual([V.bad.mmsi]);
      expect(byGrade.meta.total).toBe(1);
      // The distribution still covers the whole fleet.
      expect(byGrade.vessels).toBe(4);
      expect(Object.values(byGrade.grades).reduce((a, b) => a + b, 0)).toBe(3);
      const byName = (
        await service.request({
          url: `/api/v2/cii/fleet/summary?year=${year}&search=BAK`,
          as: MANAGER,
        })
      ).json<FleetSummary>();
      expect(byName.items.map((item) => item.mmsi)).toEqual([V.bad.mmsi]);
      const byMmsi = (
        await service.request({
          url: `/api/v2/cii/fleet/summary?year=${year}&search=5257200&sort=name&pageSize=2&page=2`,
          as: MANAGER,
        })
      ).json<FleetSummary>();
      expect(byMmsi.meta).toEqual({ page: 2, pageSize: 2, total: 4 });
      expect(byMmsi.items.map((item) => item.name)).toEqual([
        'Cendana',
        'Dahlia',
      ]);
      const invalid = await service.request({
        url: `/api/v2/cii/fleet/summary?grade=F&sort=speed`,
        as: MANAGER,
      });
      expect(invalid.statusCode).toBe(400);
      expect(invalid.json<Problem>().code).toBe('VALIDATION_FAILED');
    });
  });

  describe('GET /cii/fleet/fuel', () => {
    it('sums the fleet per year (with manual records) and per month (segments only)', async () => {
      const month = todayStart.getUTCMonth() + 1;
      const response = await service.request({
        url: `/api/v2/cii/fleet/fuel?year=${year}&month=${month}`,
        as: MANAGER,
      });
      expect(response.statusCode).toBe(200);
      const fuel = response.json<{
        vessels: number;
        year: FuelPeriod;
        month: FuelPeriod;
        methodIds: string[];
      }>();
      const distance = SEGMENTS * SEGMENT_NM;
      const segmentsCo2 =
        co2ForRating(0.5, year, distance) + co2ForRating(3, year, distance);
      const segmentsFuel = segmentsCo2 / snapshot.fuel.conversionFactor;
      expect(fuel.vessels).toBe(4);
      expect(fuel.month.vesselsWithData).toBe(2);
      expect(fuel.month.manualVessels).toBe(0);
      expect(fuel.month.totalFuelTon).toBeCloseTo(segmentsFuel, 6);
      expect(fuel.month.fuelMeTon).toBeCloseTo(segmentsFuel * 0.8, 6);
      expect(fuel.month.co2Ton).toBeCloseTo(segmentsCo2, 6);
      expect(fuel.month.from).toBe(
        new Date(Date.UTC(year, month - 1, 1)).toISOString(),
      );
      expect(fuel.year.vesselsWithData).toBe(3);
      expect(fuel.year.manualVessels).toBe(1);
      expect(fuel.year.totalFuelTon).toBeCloseTo(segmentsFuel + 100, 6);
      // The manual record has no CO2: its fuel × C_F of the vessel's current fuel.
      expect(fuel.year.co2Ton).toBeCloseTo(
        segmentsCo2 + 100 * snapshot.fuel.conversionFactor,
        6,
      );
      expect(fuel.methodIds).toEqual(
        expect.arrayContaining(['fuel.first_formula', 'cii.annual_manual']),
      );
      const all = (
        await service.request({
          url: `/api/v2/cii/fleet/fuel?year=${year}&month=${month}&orgId=${OTHER_ORG}`,
          as: ADMIN,
        })
      ).json<{ vessels: number; month: FuelPeriod }>();
      expect(all.vessels).toBe(1);
      expect(all.month.co2Ton).toBeCloseTo(co2ForRating(1, year, distance), 6);
    });
  });

  describe('vessel identity in CII and SEEMP responses', () => {
    it('embeds the vessel of the FLEET projection', async () => {
      const identity = {
        vesselId: vesselIds.good,
        mmsi: V.good.mmsi,
        name: 'Anggrek',
        imo: snapshot.imo,
        flag: snapshot.flag,
        typeCode: snapshot.type.code,
        typeName: snapshot.type.name,
      };
      for (const url of [
        `/api/v2/cii/vessels/${V.good.mmsi}/current`,
        `/api/v2/cii/vessels/${V.good.mmsi}/annual`,
        `/api/v2/seemp/vessels/${V.good.mmsi}/recommendations`,
      ]) {
        const response = await service.request({ url, as: MANAGER });
        expect(response.statusCode, url).toBe(200);
        expect(response.json<{ vessel: unknown }>().vessel).toEqual(identity);
      }
    });
  });

  describe('segments: filters and CSV', () => {
    const range = `from=${new Date(dayStart).toISOString()}&to=${new Date(dayStart + 24 * HOUR_MS).toISOString()}`;

    it('filters by method and flag', async () => {
      const none = await service.request({
        url: `/api/v2/cii/vessels/${V.good.mmsi}/segments?${range}&method=none`,
        as: MANAGER,
      });
      expect(none.statusCode).toBe(200);
      const rows = none.json<{ data: { method: string; flags: string[] }[] }>()
        .data;
      expect(rows).toHaveLength(3);
      expect(
        rows.every((row) => row.method === 'none' && row.flags.includes('gap')),
      ).toBe(true);
      const flagged = await service.request({
        url: `/api/v2/cii/vessels/${V.good.mmsi}/segments?${range}&flag=gap`,
        as: MANAGER,
      });
      expect(flagged.json<{ data: unknown[] }>().data).toHaveLength(3);
      const counted = await service.request({
        url: `/api/v2/cii/vessels/${V.good.mmsi}/segments?${range}&method=first_formula,holtrop`,
        as: MANAGER,
      });
      expect(counted.json<{ data: unknown[] }>().data).toHaveLength(SEGMENTS);
    });

    it('exports the range as CSV (oldest first) with the exposed headers', async () => {
      const response = await service.request({
        url: `/api/v2/cii/vessels/${V.good.mmsi}/segments?${range}`,
        as: MANAGER,
        headers: { accept: 'text/csv', origin: ORIGIN },
      });
      expect(response.statusCode).toBe(200);
      expect(response.headers['content-type']).toMatch(/^text\/csv/);
      expect(response.headers['x-truncated']).toBe('false');
      expect(response.headers['content-disposition']).toMatch(
        new RegExp(`^attachment; filename="segments-${V.good.mmsi}-`),
      );
      const exposed = String(
        response.headers['access-control-expose-headers'],
      ).toLowerCase();
      expect(exposed).toContain('content-disposition');
      expect(exposed).toContain('x-truncated');
      const lines = response.body.trimEnd().split('\r\n');
      expect(lines[0]?.startsWith('time_start,time_end,mmsi,')).toBe(true);
      expect(lines).toHaveLength(1 + SEGMENTS + 3);
      const starts = lines.slice(1).map((line) => line.split(',')[0] ?? '');
      expect(starts).toEqual([...starts].sort());
    });
  });

  describe('GET /emission/fleet/dcs', () => {
    it('returns the summaries of the fleet (segments, else manual) as JSON and CSV', async () => {
      const response = await service.request({
        url: `/api/v2/emission/fleet/dcs?year=${year}`,
        as: MANAGER,
      });
      expect(response.statusCode).toBe(200);
      const fleet = response.json<{
        vessels: number;
        items: { mmsi: number; source: string; vesselName: string }[];
        withoutData: { mmsi: number }[];
        methodIds: string[];
      }>();
      expect(fleet.vessels).toBe(4);
      expect(fleet.items.map((item) => [item.mmsi, item.source])).toEqual([
        [V.good.mmsi, 'segments'],
        [V.bad.mmsi, 'segments'],
        [V.manual.mmsi, 'manual'],
      ]);
      expect(fleet.withoutData.map((item) => item.mmsi)).toEqual([
        V.empty.mmsi,
      ]);
      expect(fleet.methodIds).toEqual(
        expect.arrayContaining(['emission.dcs_summary', 'cii.annual_manual']),
      );
      const csv = await service.request({
        url: `/api/v2/emission/fleet/dcs?year=${year}`,
        as: MANAGER,
        headers: { accept: 'text/csv' },
      });
      expect(csv.headers['content-type']).toMatch(/^text\/csv/);
      const lines = csv.body.trimEnd().split('\r\n');
      expect(lines[0]?.startsWith('year,mmsi,imo,vessel_name,source,')).toBe(
        true,
      );
      expect(lines.slice(1).map((line) => Number(line.split(',')[1]))).toEqual([
        V.good.mmsi,
        V.bad.mmsi,
        V.manual.mmsi,
      ]);
    });
  });

  describe('JSON / CSV negotiation', () => {
    // `@Header('vary', 'accept')` replaced the `Vary: Origin` of the CORS
    // hook: caches could serve one origin's response (with its
    // Access-Control-Allow-Origin) to another.
    it('varies on Origin and Accept in both representations', async () => {
      const range = `from=${new Date(dayStart).toISOString()}&to=${new Date(dayStart + 24 * HOUR_MS).toISOString()}`;
      const urls = [
        `/api/v2/cii/vessels/${V.good.mmsi}/segments?${range}`,
        `/api/v2/emission/vessels/${V.good.mmsi}/dcs?year=${year}`,
        `/api/v2/emission/fleet/dcs?year=${year}`,
      ];
      for (const url of urls) {
        for (const accept of ['application/json', 'text/csv']) {
          const response = await service.request({
            url,
            as: MANAGER,
            headers: { accept, origin: ORIGIN },
          });
          const label = `${url} (${accept})`;
          expect(response.statusCode, label).toBe(200);
          expect(response.headers['content-type'], label).toContain(accept);
          expect(response.headers['access-control-allow-origin'], label).toBe(
            ORIGIN,
          );
          expect(
            String(response.headers.vary)
              .split(',')
              .map((field) => field.trim().toLowerCase()),
            label,
          ).toEqual(['origin', 'accept']);
        }
      }
    });
  });

  describe('DELETE /cii/vessels/:mmsi/annual-manual/:year', () => {
    it('removes a record of the vessel (vessel:write, audited), then answers 404', async () => {
      const url = `/api/v2/cii/vessels/${V.manual.mmsi}/annual-manual/${year - 2}`;
      const asViewer = await service.request({
        method: 'DELETE',
        url,
        as: VIEWER,
      });
      expect(asViewer.statusCode).toBe(403);
      const removed = await service.request({
        method: 'DELETE',
        url,
        as: MANAGER,
      });
      expect(removed.statusCode).toBe(204);
      const again = await service.request({
        method: 'DELETE',
        url,
        as: MANAGER,
      });
      expect(again.statusCode).toBe(404);
      expect(again.json<Problem>().code).toBe('CII_ANNUAL_MANUAL_NOT_FOUND');
      const read = await service.request({ url, as: MANAGER });
      expect(read.json<Problem>().code).toBe('CII_ANNUAL_MANUAL_NOT_FOUND');
      const foreign = await service.request({
        method: 'DELETE',
        url: `/api/v2/cii/vessels/${V.other.mmsi}/annual-manual/${year}`,
        as: MANAGER,
      });
      // Another organization's vessel: 403 (assertOrgAccess, as every CII route).
      expect(foreign.statusCode).toBe(403);
      expect(await lastAudit()).toMatchObject({
        action: 'cii_annual_manual.delete',
        targetType: 'vessel',
        targetId: vesselIds.manual,
        orgId: ORG,
        meta: { mmsi: V.manual.mmsi, year: year - 2 },
      });
    });
  });

  describe('GET /cii/recompute-jobs', () => {
    it('is reserved to platform administrators and pages newest first with filters', async () => {
      const insert = (
        id: string,
        mmsi: number,
        status: string,
        minutesAgo: number,
      ) =>
        service.pool.query(
          `INSERT INTO recompute_jobs (id, mmsi, from_time, to_time, status, created_at, heartbeat_at)
           VALUES ($1, $2, now() - interval '2 hours', now() - interval '1 hour', $3,
                   now() - $4 * interval '1 minute', now())`,
          [id, mmsi, status, minutesAgo],
        );
      await insert(testUuid(9811), V.good.mmsi, 'failed', 30);
      await insert(testUuid(9812), V.good.mmsi, 'succeeded', 20);
      await insert(testUuid(9813), V.good.mmsi, 'running', 10);
      await insert(testUuid(9814), V.bad.mmsi, 'failed', 5);
      const asManager = await service.request({
        url: '/api/v2/cii/recompute-jobs',
        as: MANAGER,
      });
      expect(asManager.statusCode).toBe(403);
      expect(asManager.json<Problem>().code).toBe('PLATFORM_ADMIN_REQUIRED');
      const ids: string[] = [];
      let cursor: string | null = null;
      do {
        const page: {
          data: Job[];
          page: { nextCursor: string | null; limit: number };
        } = (
          await service.request({
            url: `/api/v2/cii/recompute-jobs?mmsi=${V.good.mmsi}&limit=2${cursor === null ? '' : `&cursor=${encodeURIComponent(cursor)}`}`,
            as: ADMIN,
          })
        ).json();
        ids.push(...page.data.map((job) => job.id));
        cursor = page.page.nextCursor;
      } while (cursor !== null);
      expect(ids).toEqual([testUuid(9813), testUuid(9812), testUuid(9811)]);
      const failed = (
        await service.request({
          url: `/api/v2/cii/recompute-jobs?status=failed&mmsi=${V.bad.mmsi}`,
          as: ADMIN,
        })
      ).json<{ data: Job[] }>();
      expect(failed.data.map((job) => job.id)).toEqual([testUuid(9814)]);
      const invalid = await service.request({
        url: '/api/v2/cii/recompute-jobs?status=paused',
        as: ADMIN,
      });
      expect(invalid.statusCode).toBe(400);
      const job = await service.request({
        url: `/api/v2/cii/recompute-jobs/not-a-uuid`,
        as: ADMIN,
      });
      expect(job.statusCode).toBe(400);
      expect(job.json<{ errors: { field: string }[] }>().errors[0]?.field).toBe(
        'id',
      );
    });
  });

  describe('DELETE /reduction-factors/:year', () => {
    it('removes only an unused first or last year (reference:write, audited)', async () => {
      const remove = (y: number | string, as: object = ADMIN) =>
        service.request({
          method: 'DELETE',
          url: `/api/v2/reduction-factors/${y}`,
          as,
        });
      expect((await remove(2099, MANAGER)).statusCode).toBe(403);
      expect((await remove(1999)).statusCode).toBe(400);
      const missing = await remove(2099);
      expect(missing.statusCode).toBe(404);
      expect(missing.json<Problem>().code).toBe('REDUCTION_FACTOR_NOT_FOUND');
      const used = await remove(year);
      expect(used.statusCode).toBe(409);
      expect(used.json<Problem & { vessels: number }>()).toMatchObject({
        code: 'REDUCTION_FACTOR_IN_USE',
      });
      const table = (
        await service.request({ url: '/api/v2/reduction-factors', as: ADMIN })
      )
        .json<{ data: { year: number }[] }>()
        .data.map((factor) => factor.year);
      const last = Math.max(...table);
      const interior = table.find((y) => y > year && y < last);
      if (interior !== undefined) {
        const gap = await remove(interior);
        expect(gap.statusCode).toBe(409);
        expect(gap.json<Problem>().code).toBe('REDUCTION_FACTOR_TABLE_GAP');
      }
      const added = last + 1;
      const put = await service.request({
        method: 'PUT',
        url: '/api/v2/reduction-factors',
        as: ADMIN,
        body: {
          items: [{ year: added, zPercent: 30, source: 'added by mistake' }],
        },
      });
      expect(put.statusCode).toBe(200);
      expect((await remove(added)).statusCode).toBe(204);
      expect(await lastAudit()).toMatchObject({
        action: 'reduction_factor.delete',
        targetType: 'reduction_factor',
        targetId: String(added),
        meta: { year: added },
      });
      const after = (
        await service.request({ url: '/api/v2/reduction-factors', as: ADMIN })
      )
        .json<{ data: { year: number }[] }>()
        .data.map((factor) => factor.year);
      expect(after).toEqual(table);
    });
  });

  describe('SEEMP', () => {
    it('lists every measure with includeAll and reports the baseline CO2', async () => {
      const legacy = await service.request({
        url: `/api/v2/seemp/vessels/${V.bad.mmsi}/recommendations`,
        as: MANAGER,
      });
      expect(legacy.statusCode).toBe(200);
      const all = await service.request({
        url: `/api/v2/seemp/vessels/${V.bad.mmsi}/recommendations?includeAll=true`,
        as: MANAGER,
      });
      const body = all.json<{
        includeAll: boolean;
        baselineYear: number;
        baselineCo2Ton: number;
        recommendations: {
          code: string;
          recommended: boolean;
          ciiGradeAfter: string;
        }[];
      }>();
      expect(body.includeAll).toBe(true);
      expect(body.recommendations).toHaveLength(12);
      for (const item of body.recommendations)
        expect(item.recommended).toBe(
          ['A', 'B', 'C'].includes(item.ciiGradeAfter),
        );
      expect(
        legacy
          .json<{ recommendations: { code: string }[] }>()
          .recommendations.map((item) => item.code),
      ).toEqual(
        body.recommendations
          .filter((item) => item.recommended)
          .map((item) => item.code),
      );
      expect(body.baselineYear).toBe(year);
      expect(body.baselineCo2Ton).toBeCloseTo(
        co2ForRating(3, year, SEGMENTS * SEGMENT_NM),
        6,
      );
      const badFlag = await service.request({
        url: `/api/v2/seemp/vessels/${V.bad.mmsi}/recommendations?includeAll=yes`,
        as: MANAGER,
      });
      expect(badFlag.statusCode).toBe(400);
    });

    it('reports CO2 avoided and the cost per tonne of a simulation', async () => {
      const response = await service.request({
        method: 'POST',
        url: `/api/v2/seemp/vessels/${V.bad.mmsi}/simulate`,
        as: MANAGER,
        body: { measureCodes: ['hull_coating', 'solar'] },
      });
      expect(response.statusCode).toBe(200);
      const simulation = response.json<{
        baselineCo2Ton: number;
        reductionPercent: number;
        costUsdPerYear: number;
        co2AvoidedTon: number;
        costPerTonneUsd: number | null;
      }>();
      expect(simulation.co2AvoidedTon).toBeGreaterThan(0);
      expect(simulation.co2AvoidedTon).toBeCloseTo(
        (simulation.baselineCo2Ton * simulation.reductionPercent) / 100,
        6,
      );
      expect(simulation.costPerTonneUsd).toBeCloseTo(
        simulation.costUsdPerYear / simulation.co2AvoidedTon,
        6,
      );
      const nullYear = await service.request({
        method: 'POST',
        url: `/api/v2/seemp/vessels/${V.bad.mmsi}/simulate`,
        as: MANAGER,
        body: { measureCodes: ['solar'], year: null },
      });
      expect(nullYear.statusCode).toBe(400);
    });

    it('names, searches, sorts and renames scenarios', async () => {
      const create = async (
        mmsi: number,
        name: string,
        as: object = MANAGER,
      ) => {
        const response = await service.request({
          method: 'POST',
          url: '/api/v2/seemp/scenarios',
          as,
          body: { mmsi, name, measureCodes: ['solar'] },
        });
        expect(response.statusCode).toBe(201);
        return response.json<Scenario>();
      };
      const first = await create(V.good.mmsi, 'zeta plan');
      const second = await create(V.bad.mmsi, 'alpha plan');
      const foreign = await create(V.other.mmsi, 'foreign plan', ADMIN);
      expect(first.vesselName).toBe('Anggrek');
      const list = (query: string) =>
        service.request({
          url: `/api/v2/seemp/scenarios?${query}`,
          as: MANAGER,
        });
      const byVessel = (await list('search=bakung')).json<{
        data: Scenario[];
      }>();
      expect(byVessel.data.map((scenario) => scenario.id)).toEqual([second.id]);
      expect(byVessel.data[0]?.vesselName).toBe('Bakung');
      const byName = (await list('search=PLAN&sort=name')).json<{
        data: Scenario[];
        meta: { total: number };
      }>();
      expect(byName.data.map((scenario) => scenario.id)).toEqual([
        second.id,
        first.id,
      ]);
      expect(byName.meta.total).toBe(2);
      const byVesselName = (await list('sort=-vesselName')).json<{
        data: Scenario[];
      }>();
      expect(byVesselName.data.map((scenario) => scenario.vesselName)).toEqual([
        'Bakung',
        'Anggrek',
      ]);
      const byMmsi = (
        await list(`search=${String(V.good.mmsi).slice(0, 8)}&sort=-mmsi`)
      ).json<{
        data: Scenario[];
      }>();
      expect(byMmsi.data.map((scenario) => scenario.mmsi)).toEqual([
        V.bad.mmsi,
        V.good.mmsi,
      ]);
      const renamed = await service.request({
        method: 'PATCH',
        url: `/api/v2/seemp/scenarios/${first.id}`,
        as: MANAGER,
        body: { name: 'omega plan' },
      });
      expect(renamed.statusCode).toBe(200);
      const scenario = renamed.json<Scenario>();
      expect(scenario).toMatchObject({
        name: 'omega plan',
        vesselName: 'Anggrek',
      });
      expect(Date.parse(scenario.updatedAt)).toBeGreaterThanOrEqual(
        Date.parse(scenario.createdAt),
      );
      expect(await lastAudit()).toMatchObject({
        action: 'seemp_scenario.update',
        targetId: first.id,
        orgId: ORG,
        meta: { mmsi: V.good.mmsi, name: 'omega plan' },
      });
      const empty = await service.request({
        method: 'PATCH',
        url: `/api/v2/seemp/scenarios/${first.id}`,
        as: MANAGER,
        body: { name: '' },
      });
      expect(empty.statusCode).toBe(400);
      const asViewer = await service.request({
        method: 'PATCH',
        url: `/api/v2/seemp/scenarios/${first.id}`,
        as: VIEWER,
        body: { name: 'viewer plan' },
      });
      expect(asViewer.statusCode).toBe(403);
      const otherOrg = await service.request({
        method: 'PATCH',
        url: `/api/v2/seemp/scenarios/${foreign.id}`,
        as: MANAGER,
        body: { name: 'stolen plan' },
      });
      expect(otherOrg.statusCode).toBe(404);
      expect(otherOrg.json<Problem>().code).toBe('SEEMP_SCENARIO_NOT_FOUND');
    });

    // The result of a scenario is the simulation response stored at creation
    // time. 0.1.x stored it without the fields 0.2.0 added to the simulation,
    // and the document typed `result` as SeempSimulationDto, which requires
    // them: generated clients relied on fields old scenarios do not have.
    it('serves scenarios saved before 0.2.0 within the published schema', async () => {
      const since020 = [
        'vessel',
        'baselineCo2Ton',
        'co2AvoidedTon',
        'costPerTonneUsd',
      ];
      const created = await service.request({
        method: 'POST',
        url: '/api/v2/seemp/scenarios',
        as: MANAGER,
        body: {
          mmsi: V.good.mmsi,
          name: 'legacy plan',
          measureCodes: ['solar'],
        },
      });
      expect(created.statusCode).toBe(201);
      const { id, result } = created.json<{
        id: string;
        result: Record<string, unknown>;
      }>();
      expect(since020.filter((field) => !(field in result))).toEqual([]);
      // What a 0.1.x replica stored: the same result without those fields.
      await service.pool.query(
        'UPDATE seemp_scenarios SET result = result - $2::text[] WHERE id = $1',
        [id, since020],
      );
      const document = (
        await service.request({ url: '/openapi.json', as: null })
      ).json<{
        paths: Record<
          string,
          {
            get: {
              responses: Record<
                string,
                { content: Record<string, { schema: Schema }> }
              >;
            };
          }
        >;
        components: { schemas: Record<string, Schema> };
      }>();
      const { schemas } = document.components;
      /** The schema a generated client reads the `200` of `GET path` with. */
      const documented = (path: string): Schema =>
        document.paths[path]?.get.responses['200']?.content['application/json']
          ?.schema ?? { $ref: `missing ${path}` };

      const one = await service.request({
        url: `/api/v2/seemp/scenarios/${id}`,
        as: MANAGER,
      });
      expect(one.statusCode).toBe(200);
      const scenario = one.json<{ result: Record<string, unknown> }>();
      expect(since020.filter((field) => field in scenario.result)).toEqual([]);
      expect(
        missingRequired(
          schemas,
          documented('/api/v2/seemp/scenarios/{id}'),
          scenario,
        ),
      ).toEqual([]);
      const page = await service.request({
        url: '/api/v2/seemp/scenarios?search=legacy',
        as: MANAGER,
      });
      expect(page.json<{ data: { id: string }[] }>().data).toHaveLength(1);
      expect(
        missingRequired(
          schemas,
          documented('/api/v2/seemp/scenarios'),
          page.json(),
        ),
      ).toEqual([]);
      // The simulation schema (the previous type of `result`) requires them.
      expect(
        missingRequired(
          schemas,
          { $ref: '#/components/schemas/SeempSimulationDto' },
          scenario.result,
        ).sort(),
      ).toEqual(since020.map((field) => `$.${field}`).sort());

      const removed = await service.request({
        method: 'DELETE',
        url: `/api/v2/seemp/scenarios/${id}`,
        as: MANAGER,
      });
      expect(removed.statusCode).toBe(204);
    });
  });
});
