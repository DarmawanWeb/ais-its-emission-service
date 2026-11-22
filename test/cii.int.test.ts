import { EVENT_TYPES } from '@darmawanweb/ais-its-contracts/events';
import { waitFor } from '@darmawanweb/ais-its-nest/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as z from 'zod';

import { expectClose, loadGolden, num } from './support/golden.js';
import { snapshotOfLegacyShip, testUuid } from './support/legacy-ship.js';
import {
  legacyShip,
  positionOf,
  segmentsOf,
  speedCase,
  speedCases,
  waitForCii,
  waitForProfile,
  waitForSegments,
} from './support/scenario.js';
import { startTestService, type TestService } from './support/test-service.js';

const HOUR_MS = 3_600_000;
const ORG = testUuid(9101);
const OTHER_ORG = testUuid(9102);
const MANAGER = { roles: ['fleet_manager'], orgId: ORG } as const;
const ADMIN = { roles: ['super_admin'], orgId: null } as const;

const MMSI = {
  formula: 525005223,
  holtrop: 525100001,
  telemetry: 525100002,
  empty: 525100003,
  otherOrg: 525100004,
  gap: 525100005,
  unknown: 525199999,
} as const;

const LegacyFuel = z.object({
  fuelConsumptionMeTon: num,
  fuelConsumptionAeTon: num,
  totalFuelConsumptionTon: num,
});
const FIRST = loadGolden(
  'first-formula.json',
  z.object({
    cases: z.array(z.object({ name: z.string(), output: LegacyFuel })),
  }),
);
const HOLTROP = loadGolden(
  'holtrop.json',
  z.object({
    chains: z.array(
      z.object({ name: z.string(), fuel: z.record(z.string(), LegacyFuel) }),
    ),
  }),
);
const CII = loadGolden(
  'cii.json',
  z.object({
    accumulation: z.array(
      z.object({
        ship: z.string(),
        steps: z.array(
          z.object({
            input: z.object({ distance: num }),
            output: z.object({
              ciiRequired: num,
              ciiAttained: num,
              ciiRating: num,
              ciiGrade: z.string(),
              totalDistance: num,
              fuelConsumption: LegacyFuel,
            }),
          }),
        ),
      }),
    ),
  }),
);

function legacyFirstFormula(name: string): z.output<typeof LegacyFuel> {
  const found = FIRST.cases.find((c) => c.name === name)?.output;
  if (found === undefined)
    throw new Error(`no golden first-formula case ${name}`);
  return found;
}

function legacyHoltrop(
  name: string,
  navstatus = 0,
): z.output<typeof LegacyFuel> {
  const found = HOLTROP.chains.find((c) => c.name === name)?.fuel[
    `nav${navstatus}`
  ];
  if (found === undefined) throw new Error(`no golden Holtrop chain ${name}`);
  return found;
}

/** The legacy accumulated CII of ship A after all its golden segments (cii.json). */
const LEGACY_FINAL = (() => {
  const steps = CII.accumulation.find((a) => a.ship === 'A')?.steps;
  const last = steps?.at(-1);
  if (steps === undefined || last === undefined)
    throw new Error('no accumulation for ship A');
  return last.output;
})();

interface CiiSummary {
  year: number;
  source: string;
  distanceNm: number;
  fuelMeTon: number;
  fuelAeTon: number;
  co2Ton: number;
  segments: number;
  methods: { telemetry: number; firstFormula: number; holtrop: number };
  zPercent: number;
  attained: number;
  required: number;
  rating: number;
  grade: string;
  ddVector: { d1: number; d2: number; d3: number; d4: number };
  capacity: number;
  lastMethod: string | null;
  methodIds: string[];
  projection: { attained: number; grade: string; yearFraction: number } | null;
}

describe('segments → cii_daily / cii_annual → CII API (spec §13.5)', () => {
  let service: TestService;
  const shipA = legacyShip('A');
  // Golden cases moved to distinct starts (7 h apart from 2026-03-10T08:00Z): one segment each.
  const goldenCases = speedCases();
  const shiftOf = (index: number): number => index * 7 * HOUR_MS;

  beforeAll(async () => {
    service = await startTestService();
    const FAIL_HOUR = '2026-04-02T05:00';
    service.weather.answer = (request) =>
      request.startHour === FAIL_HOUR
        ? { kind: 'error', status: 503 }
        : { kind: 'wind', speedKn: 12, directionDeg: 45 };
    const snapshots = [
      snapshotOfLegacyShip(shipA, 11, { mmsi: MMSI.formula, orgId: ORG }),
      snapshotOfLegacyShip(shipA, 12, {
        mmsi: MMSI.holtrop,
        orgId: ORG,
        firstFuelFormula: false,
      }),
      snapshotOfLegacyShip(shipA, 13, { mmsi: MMSI.telemetry, orgId: ORG }),
      snapshotOfLegacyShip(shipA, 14, { mmsi: MMSI.empty, orgId: ORG }),
      snapshotOfLegacyShip(shipA, 15, {
        mmsi: MMSI.otherOrg,
        orgId: OTHER_ORG,
      }),
      snapshotOfLegacyShip(shipA, 16, { mmsi: MMSI.gap, orgId: ORG }),
    ];
    for (const snapshot of snapshots)
      await service.publish(EVENT_TYPES.FLEET_VESSEL_UPSERTED, snapshot);
    for (const snapshot of snapshots)
      await waitForProfile(service, snapshot.mmsi);
  });

  afterAll(async () => {
    await service.close();
  });

  describe('first fuel formula (Postman sample vessel)', () => {
    beforeAll(async () => {
      await service.publish(
        EVENT_TYPES.AIS_POSITION_RECORDED,
        positionOf(MMSI.unknown, speedCase('due-north')),
      );
      for (const [index, c] of goldenCases.entries()) {
        await service.publish(
          EVENT_TYPES.AIS_POSITION_RECORDED,
          positionOf(MMSI.formula, c, shiftOf(index)),
        );
      }
      // a redelivered / duplicated position (new envelope, same window) is stored once
      await service.publish(
        EVENT_TYPES.AIS_POSITION_RECORDED,
        positionOf(MMSI.formula, goldenCases[0] ?? speedCase('due-north'), 0),
      );
      await waitForSegments(service, MMSI.formula, goldenCases.length - 1);
      await waitForCii(service, MMSI.formula, 2026, {
        telemetry: 0,
        firstFormula: 9,
        holtrop: 0,
      });
    });

    it('stores one segment per position event with the legacy fuel (zero-time pairs and duplicates skipped, unknown vessels ignored)', async () => {
      const segments = await segmentsOf(service, MMSI.formula);
      const expected = goldenCases.filter((c) => c.name !== 'zero-time');
      expect(segments.map((s) => s.method)).toEqual(
        expected.map(() => 'first_formula'),
      );
      for (const [index, segment] of segments.entries()) {
        const c = expected[index];
        if (c === undefined) throw new Error('segment count mismatch');
        const legacy = legacyFirstFormula(
          `postman-sample/${c.name}/nav${c.previous.navstatus}`,
        );
        expectClose(
          segment.fuelMeTon,
          legacy.fuelConsumptionMeTon,
          `${c.name} ME`,
        );
        expectClose(
          segment.fuelAeTon,
          legacy.fuelConsumptionAeTon,
          `${c.name} AE`,
        );
        expectClose(
          segment.co2Ton,
          legacy.totalFuelConsumptionTon * 3.206,
          `${c.name} CO2`,
        );
        expect(segment.navstatus).toBe(c.previous.navstatus);
        expect(segment.flags).toEqual([]);
        expect(segment.weather).toBeNull();
      }
      expect(await segmentsOf(service, MMSI.unknown)).toEqual([]);
    });

    it('GET /cii/vessels/:mmsi/current equals the legacy accumulated CII (calculateCII over the same segments)', async () => {
      const response = await service.request({
        url: `/api/v2/cii/vessels/${MMSI.formula}/current?year=2026`,
        as: MANAGER,
      });
      expect(response.statusCode).toBe(200);
      const cii = response.json<CiiSummary>();
      expectClose(cii.attained, LEGACY_FINAL.ciiAttained, 'attained');
      expectClose(cii.required, LEGACY_FINAL.ciiRequired, 'required');
      expectClose(cii.rating, LEGACY_FINAL.ciiRating, 'rating');
      expect(cii.grade).toBe(LEGACY_FINAL.ciiGrade);
      expectClose(cii.distanceNm, LEGACY_FINAL.totalDistance, 'distance');
      expectClose(
        cii.fuelMeTon,
        LEGACY_FINAL.fuelConsumption.fuelConsumptionMeTon,
        'ME',
      );
      expectClose(
        cii.fuelAeTon,
        LEGACY_FINAL.fuelConsumption.fuelConsumptionAeTon,
        'AE',
      );
      expectClose(
        cii.co2Ton,
        LEGACY_FINAL.fuelConsumption.totalFuelConsumptionTon * 3.206,
        'CO2',
      );
      expect(cii).toMatchObject({
        year: 2026,
        source: 'segments',
        segments: 9,
        zPercent: 11,
        capacity: 2877,
        lastMethod: 'first_formula',
      });
      expect(cii.methods).toEqual({
        telemetry: 0,
        firstFormula: 9,
        holtrop: 0,
      });
      expectClose(
        cii.ddVector.d1,
        0.72 * LEGACY_FINAL.ciiRequired,
        'd1 × required',
      );
      expect(cii.methodIds).toEqual(
        expect.arrayContaining([
          'fuel.first_formula',
          'fuel.navstatus_multipliers',
          'cii.attained_accumulation',
          'cii.required',
          'cii.rating_grade',
        ]),
      );
      expect(cii.methodIds).not.toContain('fuel.second_formula_me');
      // the linear year-end projection scales CO2 and distance alike: same intensity and grade
      expect(cii.projection).not.toBeNull();
      expectClose(
        cii.projection?.attained ?? Number.NaN,
        cii.attained,
        'projected attained = year-to-date attained',
      );
      expect(cii.projection?.grade).toBe(cii.grade);
    });

    it('GET /cii/vessels/:mmsi/daily: daily sums and the cumulative attained CII', async () => {
      const response = await service.request({
        url: `/api/v2/cii/vessels/${MMSI.formula}/daily?from=2026-03-01T00:00:00.000Z&to=2026-04-01T00:00:00.000Z`,
        as: MANAGER,
      });
      expect(response.statusCode).toBe(200);
      const { points } = response.json<{
        points: {
          day: string;
          distanceNm: number;
          segments: number;
          cumulativeAttained: number;
          required: number;
        }[];
      }>();
      expect(points.map((point) => point.day)).toEqual([
        '2026-03-10',
        '2026-03-11',
        '2026-03-12',
      ]);
      expect(points.reduce((sum, point) => sum + point.segments, 0)).toBe(9);
      expectClose(
        points.reduce((sum, point) => sum + point.distanceNm, 0),
        LEGACY_FINAL.totalDistance,
        'Σ daily distance',
      );
      expectClose(
        points.at(-1)?.cumulativeAttained ?? Number.NaN,
        LEGACY_FINAL.ciiAttained,
        'cumulative attained',
      );
      expectClose(
        points[0]?.required ?? Number.NaN,
        LEGACY_FINAL.ciiRequired,
        'required',
      );
    });

    it('GET /cii/vessels/:mmsi/annual: per year with the grade boundaries d_i × required', async () => {
      const response = await service.request({
        url: `/api/v2/cii/vessels/${MMSI.formula}/annual`,
        as: MANAGER,
      });
      expect(response.statusCode).toBe(200);
      const body = response.json<{
        dVector: { d1: number };
        years: {
          year: number;
          attained: number;
          required: number;
          ddVector: { d1: number; d2: number; d3: number; d4: number };
        }[];
      }>();
      expect(body.dVector.d1).toBe(0.72);
      expect(body.years.map((year) => year.year)).toEqual([2026]);
      const year = body.years[0];
      expectClose(
        year?.attained ?? Number.NaN,
        LEGACY_FINAL.ciiAttained,
        'annual attained',
      );
      expectClose(
        year?.ddVector.d4 ?? Number.NaN,
        1.41 * LEGACY_FINAL.ciiRequired,
        'd4 × required',
      );
    });

    it('GET /cii/vessels/:mmsi/segments pages newest first with a cursor', async () => {
      const url = `/api/v2/cii/vessels/${MMSI.formula}/segments?from=2026-03-10T00:00:00.000Z&to=2026-03-14T00:00:00.000Z&limit=4`;
      const seen: string[] = [];
      let next: string | null = null;
      do {
        const response = await service.request({
          url:
            next === null ? url : `${url}&cursor=${encodeURIComponent(next)}`,
          as: MANAGER,
        });
        expect(response.statusCode).toBe(200);
        const page = response.json<{
          data: { timeStart: string; method: string }[];
          page: { nextCursor: string | null; limit: number };
        }>();
        expect(page.page.limit).toBe(4);
        seen.push(...page.data.map((segment) => segment.timeStart));
        next = page.page.nextCursor;
      } while (next !== null);
      expect(seen).toHaveLength(9);
      expect([...seen].sort().reverse()).toEqual(seen);
    });

    it('a changed reduction factor changes the required CII (and nothing else)', async () => {
      const before = (
        await service.request({
          url: `/api/v2/cii/vessels/${MMSI.formula}/current?year=2026`,
          as: MANAGER,
        })
      ).json<CiiSummary>();
      const forbidden = await service.request({
        method: 'PUT',
        url: '/api/v2/reduction-factors',
        as: { roles: ['org_admin'], orgId: ORG },
        body: {
          items: [{ year: 2026, zPercent: 20, source: 'integration test' }],
        },
      });
      expect(forbidden.statusCode).toBe(403);
      try {
        const put = await service.request({
          method: 'PUT',
          url: '/api/v2/reduction-factors',
          as: ADMIN,
          body: {
            items: [{ year: 2026, zPercent: 20, source: 'integration test' }],
          },
        });
        expect(put.statusCode).toBe(200);
        const after = (
          await service.request({
            url: `/api/v2/cii/vessels/${MMSI.formula}/current?year=2026`,
            as: MANAGER,
          })
        ).json<CiiSummary>();
        expectClose(
          after.required,
          before.required * (0.8 / 0.89),
          'required with Z = 20 %',
        );
        expectClose(after.rating, after.attained / after.required, 'rating');
        expect(after.zPercent).toBe(20);
        expectClose(after.attained, before.attained, 'attained unchanged');
      } finally {
        await service.request({
          method: 'PUT',
          url: '/api/v2/reduction-factors',
          as: ADMIN,
          body: {
            items: [
              {
                year: 2026,
                zPercent: 11,
                source:
                  'IMO Resolution MEPC.338(76) (2021), G3 reduction factors',
              },
            ],
          },
        });
      }
    });

    it('IMO DCS summary as JSON and CSV (Accept: text/csv)', async () => {
      const json = await service.request({
        url: `/api/v2/emission/vessels/${MMSI.formula}/dcs?year=2026`,
        as: MANAGER,
      });
      expect(json.statusCode).toBe(200);
      const dcs = json.json<{
        source: string;
        distanceNm: number;
        hoursUnderWay: number;
        co2Ton: number;
        fuel: {
          fuelCode: string;
          fuelMeTon: number;
          fuelAeTon: number;
          co2Ton: number;
        }[];
        methodIds: string[];
      }>();
      expect(dcs.source).toBe('segments');
      expect(dcs.fuel).toHaveLength(1);
      expectClose(
        dcs.fuel[0]?.fuelMeTon ?? Number.NaN,
        LEGACY_FINAL.fuelConsumption.fuelConsumptionMeTon,
        'DCS ME',
      );
      expectClose(dcs.distanceNm, LEGACY_FINAL.totalDistance, 'DCS distance');
      // every golden segment except "tiny-move" (< 1 kn): 10+10+30+46+25+20+20+360 min
      expectClose(dcs.hoursUnderWay, 521 / 60, 'hours under way');
      expect(dcs.methodIds).toContain('emission.dcs_summary');

      const csv = await service.request({
        url: `/api/v2/emission/vessels/${MMSI.formula}/dcs?year=2026`,
        as: MANAGER,
        headers: { accept: 'text/csv' },
      });
      expect(csv.statusCode).toBe(200);
      expect(csv.headers['content-type']).toContain('text/csv');
      expect(csv.headers['content-disposition']).toBe(
        `attachment; filename="dcs-${MMSI.formula}-2026.csv"`,
      );
      const [header, row, end] = csv.body.split('\r\n');
      expect(header).toBe(
        'year,mmsi,imo,vessel_name,source,fuel_code,fuel_name,conversion_factor,fuel_me_t,fuel_ae_t,fuel_total_t,co2_t,distance_nm,hours_under_way,total_co2_t',
      );
      expect(row?.split(',').slice(0, 8)).toEqual([
        '2026',
        String(MMSI.formula),
        '9037941',
        'Dharma Ferry VIII',
        'segments',
        'diesel_gas_oil',
        'Diesel/Gas Oil',
        '3.206',
      ]);
      expect(Number(row?.split(',')[12])).toBe(dcs.distanceNm);
      expect(end).toBe('');
    });
  });

  describe('Holtrop path with Open-Meteo weather', () => {
    beforeAll(async () => {
      // previous fix 2026-04-01T08:00 → wind 12 kn from 45°; previous fix 2026-04-02T05:00 → Open-Meteo 503
      const ok = speedCase('northeast-13kn');
      const failing = speedCase('southwest-8kn');
      await service.publish(
        EVENT_TYPES.AIS_POSITION_RECORDED,
        positionOf(
          MMSI.holtrop,
          ok,
          Date.parse('2026-04-01T08:00:00Z') - Date.parse(ok.previous.time),
        ),
      );
      await service.publish(
        EVENT_TYPES.AIS_POSITION_RECORDED,
        positionOf(
          MMSI.holtrop,
          failing,
          Date.parse('2026-04-02T05:00:00Z') -
            Date.parse(failing.previous.time),
        ),
      );
      await waitForSegments(service, MMSI.holtrop, 2);
      await waitForCii(service, MMSI.holtrop, 2026, {
        telemetry: 0,
        firstFormula: 0,
        holtrop: 2,
      });
    });

    it('uses the hourly wind of the 0.25° cell of the previous fix and reproduces the legacy Holtrop fuel', async () => {
      const [segment] = await segmentsOf(service, MMSI.holtrop);
      const legacy = legacyHoltrop('A/northeast-13kn/moderate-bow');
      expect(segment?.method).toBe('holtrop');
      expect(segment?.flags).toEqual([]);
      expect(segment?.weather).toMatchObject({
        source: 'open-meteo',
        windSpeedKn: 12,
        windDirectionDeg: 45,
        cell: { lat: 1, lon: 104 },
        hour: '2026-04-01T08:00',
      });
      expectClose(
        segment?.fuelMeTon ?? Number.NaN,
        legacy.fuelConsumptionMeTon,
        'ME',
      );
      expectClose(
        segment?.fuelAeTon ?? Number.NaN,
        legacy.fuelConsumptionAeTon,
        'AE',
      );
      expect(
        service.weather.requests.some(
          (request) =>
            request.latitude === '1.00' &&
            request.longitude === '104.00' &&
            request.startHour === '2026-04-01T08:00',
        ),
      ).toBe(true);
    });

    it('falls back to calm weather and flags the segment when Open-Meteo fails', async () => {
      const segment = (await segmentsOf(service, MMSI.holtrop))[1];
      const legacy = legacyHoltrop('A/southwest-8kn/calm');
      expect(segment?.method).toBe('holtrop');
      expect(segment?.flags).toEqual(['weather_unavailable']);
      expect(segment?.weather).toMatchObject({
        source: 'calm_fallback',
        windSpeedKn: 0,
      });
      expectClose(
        segment?.fuelMeTon ?? Number.NaN,
        legacy.fuelConsumptionMeTon,
        'ME (calm)',
      );
      expectClose(
        segment?.fuelAeTon ?? Number.NaN,
        legacy.fuelConsumptionAeTon,
        'AE (calm)',
      );
    });

    it('names the Holtrop and weather methods in the CII methodIds', async () => {
      const cii = (
        await service.request({
          url: `/api/v2/cii/vessels/${MMSI.holtrop}/current?year=2026`,
          as: MANAGER,
        })
      ).json<CiiSummary>();
      expect(cii.lastMethod).toBe('holtrop');
      expect(cii.methods).toEqual({
        telemetry: 0,
        firstFormula: 0,
        holtrop: 2,
      });
      expect(cii.methodIds).toEqual(
        expect.arrayContaining([
          'fuel.second_formula_me',
          'weather.open_meteo_current',
          'resistance.holtrop.wave',
        ]),
      );
    });
  });

  describe('telemetry attribution', () => {
    const first = speedCase('northeast-13kn');
    const second = speedCase('southwest-8kn');
    const firstShift =
      Date.parse('2026-05-01T08:00:00Z') - Date.parse(first.previous.time);
    const secondShift =
      Date.parse('2026-05-03T08:00:00Z') - Date.parse(second.previous.time);
    const firstPosition = positionOf(MMSI.telemetry, first, firstShift);
    const secondPosition = positionOf(MMSI.telemetry, second, secondShift);

    it('a reading received before the positions makes the segment a telemetry segment (no navstatus factors)', async () => {
      await service.publish(EVENT_TYPES.FUEL_READING_RECORDED, {
        mmsi: MMSI.telemetry,
        time: firstPosition.time,
        periodStart: firstPosition.previous?.time ?? null,
        fuelMeTon: 0.05,
        fuelAeTon: 0.01,
        deviceId: null,
        source: 'api',
      });
      await waitFor(
        async () =>
          (
            await service.pool.query(
              'SELECT 1 FROM fuel_readings WHERE mmsi = $1',
              [MMSI.telemetry],
            )
          ).rowCount === 1,
        { timeoutMs: 10_000, message: 'reading stored' },
      );
      await service.publish(EVENT_TYPES.AIS_POSITION_RECORDED, firstPosition);
      const [segment] = await waitForSegments(service, MMSI.telemetry, 1);
      expect(segment).toMatchObject({
        method: 'telemetry',
        fuelMeTon: 0.05,
        fuelAeTon: 0.01,
        flags: [],
      });
      expectClose(segment?.co2Ton ?? Number.NaN, 0.06 * 3.206, 'CO2');
    });

    it('a reading received after the positions re-attributes the stored segment (flag telemetry_reattributed)', async () => {
      await service.publish(EVENT_TYPES.AIS_POSITION_RECORDED, secondPosition);
      const segments = await waitForSegments(service, MMSI.telemetry, 2);
      expect(segments[1]?.method).toBe('first_formula');
      await service.publish(EVENT_TYPES.FUEL_READING_RECORDED, {
        mmsi: MMSI.telemetry,
        time: secondPosition.time,
        periodStart: secondPosition.previous?.time ?? null,
        fuelMeTon: 0.2,
        fuelAeTon: 0.04,
        deviceId: null,
        source: 'device',
      });
      const reattributed = await waitFor(
        async () => {
          const rows = await segmentsOf(service, MMSI.telemetry);
          return rows[1]?.method === 'telemetry' ? rows[1] : undefined;
        },
        { timeoutMs: 10_000, message: 're-attribution' },
      );
      expect(reattributed).toMatchObject({
        fuelMeTon: 0.2,
        fuelAeTon: 0.04,
        flags: ['telemetry_reattributed'],
      });
    });

    it('the CII of telemetry segments: Σ(fuel × C_F) / (capacity × Σ distance) × 10⁶', async () => {
      await waitForCii(service, MMSI.telemetry, 2026, {
        telemetry: 2,
        firstFormula: 0,
        holtrop: 0,
      });
      const segments = await segmentsOf(service, MMSI.telemetry);
      const distance = segments.reduce(
        (sum, segment) => sum + segment.distanceNm,
        0,
      );
      const cii = (
        await service.request({
          url: `/api/v2/cii/vessels/${MMSI.telemetry}/current?year=2026`,
          as: MANAGER,
        })
      ).json<CiiSummary>();
      expectClose(
        cii.attained,
        (((0.05 + 0.01 + 0.2 + 0.04) * 3.206) / (2877 * distance)) * 1e6,
        'attained',
      );
      expect(cii.lastMethod).toBe('telemetry');
      expect(cii.methods).toEqual({
        telemetry: 2,
        firstFormula: 0,
        holtrop: 0,
      });
      expect(cii.methodIds).toEqual(
        expect.arrayContaining([
          'telemetry.fuel_reading_usage',
          'fuel.method_selection',
        ]),
      );
    });
  });

  describe('gaps, missing data and tenancy', () => {
    beforeAll(async () => {
      const normal = speedCase('due-east');
      const t0 = Date.parse('2026-06-01T00:00:00Z');
      await service.publish(EVENT_TYPES.AIS_POSITION_RECORDED, {
        ...positionOf(MMSI.gap, normal, t0 - Date.parse(normal.previous.time)),
        time: new Date(t0 + 7 * HOUR_MS).toISOString(),
      });
      await service.publish(
        EVENT_TYPES.AIS_POSITION_RECORDED,
        positionOf(
          MMSI.gap,
          normal,
          t0 + 8 * HOUR_MS - Date.parse(normal.previous.time),
        ),
      );
      await waitForSegments(service, MMSI.gap, 2);
      await waitForCii(service, MMSI.gap, 2026, {
        telemetry: 0,
        firstFormula: 1,
        holtrop: 0,
      });
    });

    it('records a gap longer than SEGMENT_MAX_GAP_MIN as a flagged, not counted segment', async () => {
      const [gap, normal] = await segmentsOf(service, MMSI.gap);
      expect(gap).toMatchObject({
        method: 'none',
        fuelMeTon: 0,
        fuelAeTon: 0,
        co2Ton: 0,
        flags: ['gap'],
      });
      expect(normal?.method).toBe('first_formula');
      const cii = (
        await service.request({
          url: `/api/v2/cii/vessels/${MMSI.gap}/current?year=2026`,
          as: MANAGER,
        })
      ).json<CiiSummary>();
      expect(cii.segments).toBe(1);
      expectClose(
        cii.distanceNm,
        normal?.distanceNm ?? Number.NaN,
        'only the counted segment',
      );
    });

    it('answers 404 CII_NOT_AVAILABLE without data — no default CII (spec §15.2)', async () => {
      for (const url of [
        `/api/v2/cii/vessels/${MMSI.empty}/current?year=2026`,
        `/api/v2/cii/vessels/${MMSI.empty}/annual`,
        `/api/v2/emission/vessels/${MMSI.empty}/dcs?year=2026`,
        `/api/v2/seemp/vessels/${MMSI.empty}/recommendations`,
        `/api/v2/cii/vessels/${MMSI.formula}/current?year=2025`,
      ]) {
        const response = await service.request({ url, as: MANAGER });
        expect(response.statusCode, url).toBe(404);
        expect(response.headers['content-type']).toContain(
          'application/problem+json',
        );
        expect(response.json<{ code: string }>().code, url).toBe(
          'CII_NOT_AVAILABLE',
        );
      }
      const unknown = await service.request({
        url: `/api/v2/cii/vessels/${MMSI.unknown}/current`,
        as: MANAGER,
      });
      expect(unknown.statusCode).toBe(404);
      expect(unknown.json<{ code: string }>().code).toBe('VESSEL_NOT_FOUND');
    });

    it('keeps CII tenant-private: other organizations get 403, super_admin reads everything', async () => {
      const other = await service.request({
        url: `/api/v2/cii/vessels/${MMSI.otherOrg}/annual`,
        as: MANAGER,
      });
      expect(other.statusCode).toBe(403);
      const notMember = await service.request({
        url: `/api/v2/cii/vessels/${MMSI.formula}/current?year=2026`,
        as: { roles: ['viewer'], orgId: OTHER_ORG },
      });
      expect(notMember.statusCode).toBe(403);
      const admin = await service.request({
        url: `/api/v2/cii/vessels/${MMSI.formula}/current?year=2026`,
        as: ADMIN,
      });
      expect(admin.statusCode).toBe(200);
      const authority = await service.request({
        url: `/api/v2/cii/vessels/${MMSI.formula}/current?year=2026`,
        as: { roles: ['authority'], orgId: ORG },
      });
      expect(authority.statusCode).toBe(403);
      const viewer = await service.request({
        url: `/api/v2/cii/vessels/${MMSI.formula}/current?year=2026`,
        as: { roles: ['viewer'], orgId: ORG },
      });
      expect(viewer.statusCode).toBe(200);
    });

    it('GET /cii/fleet/summary: the grade distribution of the own organization only', async () => {
      const response = await service.request({
        url: '/api/v2/cii/fleet/summary?year=2026',
        as: MANAGER,
      });
      expect(response.statusCode).toBe(200);
      const summary = response.json<{
        orgId: string;
        vessels: number;
        notAvailable: number;
        grades: Record<string, number>;
        items: { mmsi: number; grade: string | null }[];
      }>();
      expect(summary.orgId).toBe(ORG);
      expect(summary.items.map((item) => item.mmsi).sort()).toEqual(
        [
          MMSI.formula,
          MMSI.holtrop,
          MMSI.telemetry,
          MMSI.empty,
          MMSI.gap,
        ].sort(),
      );
      expect(summary.notAvailable).toBe(1);
      expect(
        Object.values(summary.grades).reduce((sum, count) => sum + count, 0),
      ).toBe(4);
      const formula = summary.items.find((item) => item.mmsi === MMSI.formula);
      expect(formula?.grade).toBe(LEGACY_FINAL.ciiGrade);

      // `items` is paginated; the distribution always covers the whole fleet
      const paged = (
        await service.request({
          url: '/api/v2/cii/fleet/summary?year=2026&page=2&pageSize=2',
          as: MANAGER,
        })
      ).json<{
        vessels: number;
        notAvailable: number;
        grades: Record<string, number>;
        items: { mmsi: number }[];
        meta: { page: number; pageSize: number; total: number };
      }>();
      const ordered = summary.items.map((item) => item.mmsi).sort();
      expect(paged.items.map((item) => item.mmsi)).toEqual(ordered.slice(2, 4));
      expect(paged.meta).toEqual({ page: 2, pageSize: 2, total: 5 });
      expect(paged.vessels).toBe(5);
      expect(paged.grades).toEqual(summary.grades);
      expect(paged.notAvailable).toBe(1);
      const tooLarge = await service.request({
        url: '/api/v2/cii/fleet/summary?year=2026&pageSize=101',
        as: MANAGER,
      });
      expect(tooLarge.statusCode).toBe(400);
    });

    it('validates path parameters (400 VALIDATION_FAILED)', async () => {
      const response = await service.request({
        url: '/api/v2/cii/vessels/12345/current',
        as: MANAGER,
      });
      expect(response.statusCode).toBe(400);
      expect(response.json<{ code: string }>().code).toBe('VALIDATION_FAILED');
    });
  });
});
