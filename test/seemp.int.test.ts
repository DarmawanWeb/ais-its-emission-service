import { EVENT_TYPES } from '@darmawanweb/ais-its-contracts/events';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as z from 'zod';

import { expectClose, loadGolden, num } from './support/golden.js';
import { snapshotOfLegacyShip, testUuid } from './support/legacy-ship.js';
import { legacyShip, waitForProfile } from './support/scenario.js';
import { startTestService, type TestService } from './support/test-service.js';

const ORG = testUuid(9201);
const OTHER_ORG = testUuid(9202);
const MANAGER = { roles: ['fleet_manager'], orgId: ORG } as const;
const OTHER = { roles: ['fleet_manager'], orgId: OTHER_ORG } as const;
const MMSI = 525200001;
const OTHER_MMSI = 525200002;

const SEEMP = loadGolden(
  'seemp.json',
  z.object({
    scenarios: z.array(
      z.object({
        name: z.string(),
        input: z.object({
          annual: z.array(
            z.object({
              year: z.number(),
              cii: z.object({
                ciiRequired: num,
                ciiAttained: num,
                ciiRating: num,
                ciiGrade: z.string(),
                totalDistance: num,
                fuelConsumption: z.object({
                  fuelConsumptionMeTon: num,
                  fuelConsumptionAeTon: num,
                }),
              }),
            }),
          ),
          voyagePerYear: z.number(),
          ciiRequired: num,
        }),
        measures: z.record(
          z.string(),
          z.object({
            ciiRatingAfter: num,
            ciiGradeAfter: z.string(),
            cost: num,
            costDisplay: z.string(),
          }),
        ),
        calculateSEEMPbyMMSI: z.array(
          z.object({
            recommendation: z.string(),
            cost: z.string(),
            ciiRatingAfter: num,
            ciiGradeAfter: z.string(),
            ciiRatingBefore: num.optional(),
            ciiGradeBefore: z.string().optional(),
          }),
        ),
      }),
    ),
  }),
);

/** The legacy Postman annual record (2025) and the legacy recommender output for it (current year 2026). */
const POSTMAN = (() => {
  const scenario = SEEMP.scenarios.find(
    (candidate) => candidate.name === 'postman-single-2025',
  );
  const record = scenario?.input.annual[0]?.cii;
  if (scenario === undefined || record === undefined)
    throw new Error('missing golden SEEMP scenario');
  return { scenario, record };
})();

interface Recommendation {
  recommendation: string;
  cost: string;
  ciiRatingAfter: number;
  ciiGradeAfter: string;
  ciiRatingBefore: number | null;
  ciiGradeBefore: string | null;
  code: string;
  costUsdPerYear: number;
  methodIds: string[];
}

interface Simulation {
  measureCodes: string[];
  baselineYear: number;
  targetYear: number;
  before: { attained: number; rating: number; grade: string };
  after: { attained: number; rating: number; grade: string };
  fuelAfter: { meTon: number; aeTon: number; conversionFactor: number };
  costUsdPerYear: number;
  cost: string;
  methodIds: string[];
}

describe('SEEMP recommendations, simulation and scenarios (spec §13.5)', () => {
  let service: TestService;

  beforeAll(async () => {
    service = await startTestService();
    const ship = legacyShip('A');
    await service.publish(
      EVENT_TYPES.FLEET_VESSEL_UPSERTED,
      snapshotOfLegacyShip(ship, 21, { mmsi: MMSI, orgId: ORG }),
    );
    await service.publish(
      EVENT_TYPES.FLEET_VESSEL_UPSERTED,
      snapshotOfLegacyShip(ship, 22, { mmsi: OTHER_MMSI, orgId: OTHER_ORG }),
    );
    await waitForProfile(service, MMSI);
    await waitForProfile(service, OTHER_MMSI);
  });

  afterAll(async () => {
    await service.close();
  });

  it('stores the legacy annual CII of 2025 as a manual record (vessel:write, tenant-private)', async () => {
    const { record } = POSTMAN;
    const body = {
      attained: record.ciiAttained,
      required: record.ciiRequired,
      rating: record.ciiRating,
      grade: record.ciiGrade,
      distanceNm: record.totalDistance,
      fuelMeTon: record.fuelConsumption.fuelConsumptionMeTon,
      fuelAeTon: record.fuelConsumption.fuelConsumptionAeTon,
      note: 'Imported from the MVP (Postman sample)',
    };
    const viewer = await service.request({
      method: 'PUT',
      url: `/api/v2/cii/vessels/${MMSI}/annual-manual/2025`,
      as: { roles: ['viewer'], orgId: ORG },
      body,
    });
    expect(viewer.statusCode).toBe(403);
    const other = await service.request({
      method: 'PUT',
      url: `/api/v2/cii/vessels/${MMSI}/annual-manual/2025`,
      as: OTHER,
      body,
    });
    expect(other.statusCode).toBe(403);
    const put = await service.request({
      method: 'PUT',
      url: `/api/v2/cii/vessels/${MMSI}/annual-manual/2025`,
      as: MANAGER,
      body,
    });
    expect(put.statusCode).toBe(200);
    const get = await service.request({
      url: `/api/v2/cii/vessels/${MMSI}/annual-manual/2025`,
      as: MANAGER,
    });
    expect(get.json()).toMatchObject({
      mmsi: MMSI,
      year: 2025,
      attained: record.ciiAttained,
      rating: record.ciiRating,
      grade: 'C',
    });
    expect(
      (
        await service.request({
          url: `/api/v2/cii/vessels/${MMSI}/annual-manual/2024`,
          as: MANAGER,
        })
      ).json<{ code: string }>().code,
    ).toBe('CII_ANNUAL_MANUAL_NOT_FOUND');

    // the year without segments falls back to the manual record
    const annual = await service.request({
      url: `/api/v2/cii/vessels/${MMSI}/annual`,
      as: MANAGER,
    });
    const { years } = annual.json<{
      years: {
        year: number;
        source: string;
        attained: number;
        rating: number;
        grade: string;
        methodIds: string[];
      }[];
    }>();
    expect(years).toHaveLength(1);
    expect(years[0]).toMatchObject({
      year: 2025,
      source: 'manual',
      attained: record.ciiAttained,
      rating: record.ciiRating,
      grade: 'C',
    });
    expect(years[0]?.methodIds).toContain('cii.annual_manual');
  });

  it('GET /seemp/vessels/:mmsi/recommendations reproduces legacy calculateSEEMPbyMMSI (order, texts, ratings, grades)', async () => {
    const response = await service.request({
      url: `/api/v2/seemp/vessels/${MMSI}/recommendations?year=2025&targetYear=2026`,
      as: MANAGER,
    });
    expect(response.statusCode).toBe(200);
    const body = response.json<{
      baselineYear: number;
      baselineSource: string;
      targetYear: number;
      ciiRequired: number;
      recommendations: Recommendation[];
      methodIds: string[];
    }>();
    expect(body).toMatchObject({
      baselineYear: 2025,
      baselineSource: 'manual',
      targetYear: 2026,
    });
    expectClose(
      body.ciiRequired,
      POSTMAN.scenario.input.ciiRequired,
      'required 2026',
    );
    const legacy = POSTMAN.scenario.calculateSEEMPbyMMSI;
    expect(body.recommendations.map((item) => item.recommendation)).toEqual(
      legacy.map((item) => item.recommendation),
    );
    body.recommendations.forEach((item, index) => {
      const expected = legacy[index];
      if (expected === undefined) throw new Error('length mismatch');
      expect(item.cost).toBe(expected.cost);
      expect(item.ciiGradeAfter).toBe(expected.ciiGradeAfter);
      expectClose(
        item.ciiRatingAfter,
        expected.ciiRatingAfter,
        `${expected.recommendation} rating`,
      );
      expect(item.ciiRatingBefore).toBe(expected.ciiRatingBefore ?? null);
      expect(item.ciiGradeBefore).toBe(expected.ciiGradeBefore ?? null);
      expect(item.methodIds).toEqual(
        expect.arrayContaining(['seemp.cost_amortization', 'cii.rating_grade']),
      );
    });
    // sorted by cost per year
    const costs = body.recommendations.map((item) => item.costUsdPerYear);
    expect([...costs].sort((a, b) => a - b)).toEqual(costs);
    expect(body.methodIds).toEqual(
      expect.arrayContaining(['seemp.filter_sort_output', 'cii.annual_manual']),
    );
  });

  it('POST /seemp/vessels/:mmsi/simulate: one measure equals its legacy evaluation', async () => {
    const response = await service.request({
      method: 'POST',
      url: `/api/v2/seemp/vessels/${MMSI}/simulate`,
      as: MANAGER,
      body: { measureCodes: ['biofuel'], year: 2025, targetYear: 2026 },
    });
    expect(response.statusCode).toBe(200);
    const simulation = response.json<Simulation>();
    const legacy = POSTMAN.scenario.measures.bioFuel;
    if (legacy === undefined) throw new Error('missing legacy bioFuel');
    expectClose(simulation.after.rating, legacy.ciiRatingAfter, 'rating after');
    expect(simulation.after.grade).toBe(legacy.ciiGradeAfter);
    expectClose(simulation.costUsdPerYear, legacy.cost, 'cost per year');
    expect(simulation.cost).toBe(legacy.costDisplay);
    expect(simulation.fuelAfter.conversionFactor).toBe(2.45);
  });

  it('POST /seemp/vessels/:mmsi/simulate: combines measures sequentially (fuel side, then operational factors)', async () => {
    const response = await service.request({
      method: 'POST',
      url: `/api/v2/seemp/vessels/${MMSI}/simulate`,
      as: MANAGER,
      body: {
        measureCodes: ['solar', 'hull_coating'],
        year: 2025,
        targetYear: 2026,
      },
    });
    expect(response.statusCode).toBe(200);
    const simulation = response.json<Simulation>();
    const { record } = POSTMAN;
    const voyage = POSTMAN.scenario.input.voyagePerYear;
    const aeAfter = record.fuelConsumption.fuelConsumptionAeTon * (1 - 0.12);
    const fuelSide =
      (((record.fuelConsumption.fuelConsumptionMeTon + aeAfter) * 3.206) /
        (record.totalDistance * 2877)) *
      1e6;
    const expected = fuelSide * (1 - (10 * voyage) / 1e4);
    expect(simulation.measureCodes).toEqual(['hull_coating', 'solar']);
    expectClose(simulation.after.attained, expected, 'attained after');
    expectClose(
      simulation.after.rating,
      expected / POSTMAN.scenario.input.ciiRequired,
      'rating after',
    );
    expectClose(simulation.before.attained, record.ciiAttained, 'baseline');
    expectClose(simulation.fuelAfter.aeTon, aeAfter, 'AE after');
    expect(simulation.methodIds).toEqual(
      expect.arrayContaining([
        'seemp.simulation_combination',
        'seemp.measure.solar',
        'seemp.measure.hull_coating',
      ]),
    );
  });

  it('refuses unknown or incompatible measures and principals without seemp:simulate', async () => {
    const url = `/api/v2/seemp/vessels/${MMSI}/simulate`;
    const unknown = await service.request({
      method: 'POST',
      url,
      as: MANAGER,
      body: { measureCodes: ['warp_drive'], year: 2025, targetYear: 2026 },
    });
    expect(unknown.statusCode).toBe(422);
    expect(unknown.json<{ code: string }>().code).toBe('SEEMP_MEASURE_UNKNOWN');
    const incompatible = await service.request({
      method: 'POST',
      url,
      as: MANAGER,
      body: { measureCodes: ['lng', 'biofuel'], year: 2025, targetYear: 2026 },
    });
    expect(incompatible.statusCode).toBe(422);
    expect(incompatible.json<{ code: string }>().code).toBe(
      'SEEMP_MEASURES_INCOMPATIBLE',
    );
    const invalid = await service.request({
      method: 'POST',
      url,
      as: MANAGER,
      body: { measureCodes: [] },
    });
    expect(invalid.statusCode).toBe(400);
    const viewer = await service.request({
      method: 'POST',
      url,
      as: { roles: ['viewer'], orgId: ORG },
      body: { measureCodes: ['solar'] },
    });
    expect(viewer.statusCode).toBe(403);
    const otherTenant = await service.request({
      url: `/api/v2/seemp/vessels/${OTHER_MMSI}/recommendations`,
      as: MANAGER,
    });
    expect(otherTenant.statusCode).toBe(403);
    const missingZ = await service.request({
      method: 'POST',
      url,
      as: MANAGER,
      body: { measureCodes: ['solar'], year: 2025, targetYear: 2040 },
    });
    expect(missingZ.statusCode).toBe(422);
    expect(missingZ.json<{ code: string }>().code).toBe(
      'REDUCTION_FACTOR_MISSING',
    );
  });

  it('saves, lists, reads and deletes scenarios privately per organization', async () => {
    const created = await service.request({
      method: 'POST',
      url: '/api/v2/seemp/scenarios',
      as: MANAGER,
      body: {
        mmsi: MMSI,
        name: 'Solar + hull coating',
        measureCodes: ['solar', 'hull_coating'],
        year: 2025,
        targetYear: 2026,
      },
    });
    expect(created.statusCode).toBe(201);
    const scenario = created.json<{
      id: string;
      measureCodes: string[];
      baselineYear: number;
      targetYear: number;
      result: Simulation;
    }>();
    expect(scenario).toMatchObject({
      measureCodes: ['hull_coating', 'solar'],
      baselineYear: 2025,
      targetYear: 2026,
    });
    expect(scenario.result.after.grade).toMatch(/^[A-E]$/);

    const forOther = await service.request({
      method: 'POST',
      url: '/api/v2/seemp/scenarios',
      as: OTHER,
      body: {
        mmsi: MMSI,
        name: 'Not mine',
        measureCodes: ['solar'],
        year: 2025,
        targetYear: 2026,
      },
    });
    expect(forOther.statusCode).toBe(403);

    const list = await service.request({
      url: `/api/v2/seemp/scenarios?mmsi=${MMSI}`,
      as: MANAGER,
    });
    expect(
      list.json<{
        data: { id: string }[];
        meta: { total: number; page: number; pageSize: number };
      }>(),
    ).toMatchObject({
      data: [{ id: scenario.id }],
      meta: { total: 1, page: 1, pageSize: 20 },
    });
    expect(
      (
        await service.request({ url: '/api/v2/seemp/scenarios', as: OTHER })
      ).json<{ data: unknown[] }>().data,
    ).toEqual([]);
    expect(
      (
        await service.request({
          url: `/api/v2/seemp/scenarios/${scenario.id}`,
          as: OTHER,
        })
      ).statusCode,
    ).toBe(404);
    expect(
      (
        await service.request({
          url: `/api/v2/seemp/scenarios/${scenario.id}`,
          as: MANAGER,
        })
      ).json(),
    ).toMatchObject({ id: scenario.id });
    expect(
      (
        await service.request({
          method: 'DELETE',
          url: `/api/v2/seemp/scenarios/${scenario.id}`,
          as: OTHER,
        })
      ).statusCode,
    ).toBe(404);
    expect(
      (
        await service.request({
          method: 'DELETE',
          url: `/api/v2/seemp/scenarios/${scenario.id}`,
          as: MANAGER,
        })
      ).statusCode,
    ).toBe(204);
    const gone = await service.request({
      url: `/api/v2/seemp/scenarios/${scenario.id}`,
      as: MANAGER,
    });
    expect(gone.statusCode).toBe(404);
    expect(gone.json<{ code: string }>().code).toBe('SEEMP_SCENARIO_NOT_FOUND');
  });
});
