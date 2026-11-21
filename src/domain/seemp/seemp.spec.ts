import { describe, expect, it } from 'vitest';
import * as z from 'zod';

import {
  expectAllClose,
  expectClose,
  loadGolden,
  num,
} from '../../../test/support/golden.js';
import {
  LegacyShipSchema,
  snapshotOfLegacyShip,
} from '../../../test/support/legacy-ship.js';
import { seempVesselOf } from '../../modules/profiles/vessel-profile.js';
import { referenceCii, requiredCii } from '../cii.js';
import {
  costByPower,
  costPerYear,
  formatCost,
  MissingReductionFactorError,
  yearsUntilInferior,
} from './cost.js';
import { LEGACY_SEEMP_MEASURES, type SeempMeasure } from './measures.js';
import {
  evaluateMeasure,
  recommendMeasures,
  toLegacyRecommendation,
} from './recommendations.js';
import { rateAfter, reductionType1 } from './reduction.js';
import { IncompatibleMeasuresError, simulateMeasures } from './simulation.js';
import type { SeempContext } from './types.js';

const MeasureResultSchema = z.object({
  ciiRatingAfter: num,
  ciiGradeAfter: z.string(),
  cost: num,
  costDisplay: z.string(),
});
const AnnualCiiSchema = z.object({
  ciiRequired: num,
  ciiAttained: num,
  ciiRating: num,
  ciiGrade: z.enum(['A', 'B', 'C', 'D', 'E']),
  totalDistance: num,
  fuelConsumption: z.object({
    fuelConsumptionMeTon: num,
    fuelConsumptionAeTon: num,
    totalFuelConsumptionTon: num,
  }),
});

const SEEMP = loadGolden(
  'seemp.json',
  z.object({
    zTable: z.array(z.object({ year: z.number(), zValue: z.number() })),
    scenarios: z.array(
      z.object({
        name: z.string(),
        input: z.object({
          ship: z.string(),
          currentYear: z.number(),
          highestZYear: z.number(),
          ciiRequired: num,
          annual: z.array(z.object({ year: z.number(), cii: AnnualCiiSchema })),
          voyagePerYear: z.number(),
        }),
        measures: z.record(z.string(), MeasureResultSchema),
        calculateSemp: z.array(
          MeasureResultSchema.extend({ name: z.string() }),
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
    amortization: z.array(
      z.object({
        input: z.object({
          ship: z.string(),
          rating: z.number(),
          totalCost: z.number(),
        }),
        years: z.number(),
        output: num,
      }),
    ),
    costByPower: z.array(
      z.object({
        input: z.object({
          ship: z.string(),
          costPerKw: z.number(),
          useMe: z.boolean(),
          useAe: z.boolean(),
        }),
        output: num,
      }),
    ),
    formatCost: z.array(z.object({ input: z.number(), output: z.string() })),
    reductions: z.object({
      first: z.array(
        z.object({
          input: z.object({
            ciiAttained: z.number(),
            ciiRequired: z.number(),
            voyagePerYear: z.number(),
            potential: z.number(),
          }),
          output: z.object({ ciiRatingAfter: num, ciiGradeAfter: z.string() }),
        }),
      ),
    }),
  }),
);

const SHIPS = loadGolden(
  'holtrop.json',
  z.object({ ships: z.record(z.string(), LegacyShipSchema) }),
).ships;
const FACTORS = new Map(SEEMP.zTable.map((row) => [row.year, row.zValue]));

/** Legacy result keys of `calculateSemp` → catalog codes. */
const LEGACY_KEYS: Readonly<Record<string, string>> = {
  airLubrication: 'air_lubrication',
  resistanceReduction: 'resistance_reduction_devices',
  hullCoating: 'hull_coating',
  powerSystemMachinery: 'power_system_machinery',
  propEffDevice: 'propulsion_efficiency_devices',
  wasteHeatRecovery: 'waste_heat_recovery',
  lngFuel: 'lng',
  bioFuel: 'biofuel',
  solarPower: 'solar',
  windPower: 'wind',
  coldIroning: 'cold_ironing',
  fuelCells: 'fuel_cells',
};

function measure(code: string): SeempMeasure {
  const found = LEGACY_SEEMP_MEASURES.find(
    (candidate) => candidate.code === code,
  );
  if (found === undefined) throw new Error(`no measure ${code}`);
  return found;
}

function vesselOf(key: string) {
  const ship = SHIPS[key];
  if (ship === undefined) throw new Error(`no legacy ship ${key}`);
  return seempVesselOf(snapshotOfLegacyShip(ship, 1));
}

type Scenario = (typeof SEEMP.scenarios)[number];

/**
 * The context the legacy `calculateSemp` builds: required CII of the current
 * year, attained CII of the LAST annual record (type 1), fuel and distance of
 * the FIRST record `annual.cii[0]` (types 2–3).
 */
function contextOf(scenario: Scenario): SeempContext {
  const first = scenario.input.annual[0];
  const last = scenario.input.annual.at(-1);
  if (first === undefined || last === undefined)
    throw new Error('scenario without annual records');
  return {
    vessel: vesselOf(scenario.input.ship),
    ciiRequired: scenario.input.ciiRequired,
    ciiAttained: last.cii.ciiAttained,
    annual: {
      fuelMeTon: first.cii.fuelConsumption.fuelConsumptionMeTon,
      fuelAeTon: first.cii.fuelConsumption.fuelConsumptionAeTon,
      distanceNm: first.cii.totalDistance,
    },
    currentYear: scenario.input.currentYear,
    highestYear: scenario.input.highestZYear,
    zOf: (year) => FACTORS.get(year),
  };
}

describe('SEEMP measures — golden parity with legacy utils/seemp/{first,second,third}-formula.ts', () => {
  it('rates with the required CII of the current year', () => {
    for (const scenario of SEEMP.scenarios) {
      const vessel = vesselOf(scenario.input.ship);
      const z = FACTORS.get(scenario.input.currentYear) ?? Number.NaN;
      expectClose(
        requiredCii(z, referenceCii(vessel.referenceLine, vessel.capacity)),
        scenario.input.ciiRequired,
        scenario.name,
      );
    }
  });

  for (const scenario of SEEMP.scenarios) {
    describe(scenario.name, () => {
      const context = contextOf(scenario);

      it.each(Object.entries(scenario.measures))('%s', (key, legacy) => {
        const code = LEGACY_KEYS[key];
        if (code === undefined) throw new Error(`unmapped legacy key ${key}`);
        const evaluation = evaluateMeasure(measure(code), context);
        expectAllClose(
          {
            rating: [evaluation.ciiRatingAfter, legacy.ciiRatingAfter],
            cost: [evaluation.cost, legacy.cost],
          },
          `${scenario.name} ${key}`,
        );
        expect(evaluation.ciiGradeAfter).toBe(legacy.ciiGradeAfter);
        expect(evaluation.costDisplay).toBe(legacy.costDisplay);
      });

      it('calculateSemp: keeps grades A–C after and sorts by cost (legacy order on ties)', () => {
        const recommendations = recommendMeasures(
          LEGACY_SEEMP_MEASURES,
          context,
        );
        expect(recommendations.map((item) => item.measure.name)).toEqual(
          scenario.calculateSemp.map((item) => item.name),
        );
        recommendations.forEach((item, index) => {
          const legacy = scenario.calculateSemp[index];
          if (legacy === undefined) throw new Error('length mismatch');
          expectAllClose(
            {
              rating: [item.ciiRatingAfter, legacy.ciiRatingAfter],
              cost: [item.cost, legacy.cost],
            },
            legacy.name,
          );
          expect(item.costDisplay).toBe(legacy.costDisplay);
        });
      });

      it('calculateSEEMPbyMMSI: legacy output items (rating before = record of the previous year)', () => {
        const previous = scenario.input.annual.find(
          (record) => record.year === scenario.input.currentYear - 1,
        );
        const before =
          previous === undefined
            ? null
            : { rating: previous.cii.ciiRating, grade: previous.cii.ciiGrade };
        const items = recommendMeasures(LEGACY_SEEMP_MEASURES, context).map(
          (item) => toLegacyRecommendation(item, before),
        );
        expect(items).toHaveLength(scenario.calculateSEEMPbyMMSI.length);
        items.forEach((item, index) => {
          const legacy = scenario.calculateSEEMPbyMMSI[index];
          if (legacy === undefined) throw new Error('length mismatch');
          expect({ ...item, ciiRatingAfter: 0 }).toEqual({
            recommendation: legacy.recommendation,
            cost: legacy.cost,
            ciiRatingAfter: 0,
            ciiGradeAfter: legacy.ciiGradeAfter,
            ciiRatingBefore: legacy.ciiRatingBefore ?? null,
            ciiGradeBefore: legacy.ciiGradeBefore ?? null,
          });
          expectClose(
            item.ciiRatingAfter,
            legacy.ciiRatingAfter,
            `${legacy.recommendation} rating after (8 decimals)`,
          );
        });
      });
    });
  }
});

describe('SEEMP cost helpers — golden parity with legacy cost-calc.ts / utils.ts', () => {
  it('years until D/E and cost per year', () => {
    for (const c of SEEMP.amortization) {
      const years = yearsUntilInferior(c.input.rating, {
        vessel: vesselOf(c.input.ship),
        currentYear: 2026,
        highestYear: 2030,
        zOf: (year) => FACTORS.get(year),
      });
      expect(years, JSON.stringify(c.input)).toBe(c.years);
      expectClose(
        costPerYear(c.input.totalCost, years),
        c.output,
        JSON.stringify(c.input),
      );
    }
  });

  it('cost by installed power', () => {
    for (const c of SEEMP.costByPower) {
      expectClose(
        costByPower(
          vesselOf(c.input.ship),
          c.input.costPerKw,
          c.input.useMe,
          c.input.useAe,
        ),
        c.output,
        JSON.stringify(c.input),
      );
    }
  });

  it('cost text', () => {
    for (const c of SEEMP.formatCost)
      expect(formatCost(c.input)).toBe(c.output);
  });

  it('type-1 reduction', () => {
    const vessel = vesselOf('A');
    for (const c of SEEMP.reductions.first) {
      const rated = rateAfter(
        reductionType1(
          c.input.ciiAttained,
          c.input.voyagePerYear,
          c.input.potential,
        ),
        c.input.ciiRequired,
        vessel.d,
      );
      expectClose(
        rated.ciiRatingAfter,
        c.output.ciiRatingAfter,
        JSON.stringify(c.input),
      );
      expect(rated.ciiGradeAfter).toBe(c.output.ciiGradeAfter);
    }
  });

  it('refuses a year without a reduction factor', () => {
    expect(() =>
      yearsUntilInferior(0.9, {
        vessel: vesselOf('A'),
        currentYear: 2026,
        highestYear: 2032,
        zOf: (year) => FACTORS.get(year),
      }),
    ).toThrow(MissingReductionFactorError);
  });
});

describe('what-if simulation (sequential multiplicative combination)', () => {
  const scenario = SEEMP.scenarios.find(
    (candidate) => candidate.name === 'postman-single-2025',
  );
  if (scenario === undefined) throw new Error('missing scenario');
  const context = contextOf(scenario);

  it.each(LEGACY_SEEMP_MEASURES.map((m) => [m.code, m] as const))(
    'a single measure reproduces the legacy evaluation: %s',
    (_code, m) => {
      const evaluation = evaluateMeasure(m, context);
      const result = simulateMeasures([m], context);
      expectAllClose(
        {
          attained: [result.after.attained, evaluation.ciiAttainedAfter],
          rating: [result.after.rating, evaluation.ciiRatingAfter],
          cost: [result.costUsdPerYear, evaluation.cost],
        },
        m.code,
      );
      expect(result.after.grade).toBe(evaluation.ciiGradeAfter);
      expect(result.costDisplay).toBe(evaluation.costDisplay);
    },
  );

  it('chains operational measures multiplicatively on the attained CII', () => {
    const v = context.vessel.annualVoyagePercentage;
    const result = simulateMeasures(
      [measure('hull_coating'), measure('air_lubrication')],
      context,
    );
    const expected =
      context.ciiAttained * (1 - (8 * v) / 1e4) * (1 - (10 * v) / 1e4);
    expectClose(
      result.after.attained,
      expected,
      'air lubrication then hull coating',
    );
    expect(result.measures.map((m) => m.code)).toEqual([
      'air_lubrication',
      'hull_coating',
    ]);
  });

  it('re-rates the fuel side first (fuel switch, then auxiliary substitutions on the remaining AE fuel), then the operational factors', () => {
    const { annual, vessel } = context;
    const result = simulateMeasures(
      [
        measure('wind'),
        measure('lng'),
        measure('solar'),
        measure('hull_coating'),
      ],
      context,
    );
    const aeAfter = annual.fuelAeTon * (1 - 0.12) * (1 - 0.15);
    const fuelSide =
      (((annual.fuelMeTon + aeAfter) * 2.75) /
        (annual.distanceNm * vessel.capacity)) *
      1e6;
    const expected =
      fuelSide * (1 - (10 * vessel.annualVoyagePercentage) / 1e4);
    expectAllClose(
      {
        attained: [result.after.attained, expected],
        ae: [result.fuelAfter.aeTon, aeAfter],
      },
      'combined',
    );
    expect(result.fuelAfter.conversionFactor).toBe(2.75);
    expectClose(
      result.reductionPercent,
      (1 - expected / context.ciiAttained) * 100,
      'reduction %',
    );
  });

  it('sums the per-year costs amortized with the combined rating', () => {
    const selected = [
      measure('biofuel'),
      measure('resistance_reduction_devices'),
    ];
    const result = simulateMeasures(selected, context);
    const years = yearsUntilInferior(result.after.rating, context);
    expect(result.yearsUntilInferior).toBe(years);
    const biofuel = costByPower(context.vessel, 20);
    const expected =
      costPerYear(biofuel, years) +
      (costPerYear(300000, years) + costPerYear(700000, years)) / 2;
    expectClose(result.costUsdPerYear, expected, 'cost per year');
    expect(result.costDisplay).toBe(
      `${formatCost(result.costRange.low)} - ${formatCost(result.costRange.high)}`,
    );
  });

  it('refuses two fuel switches and ignores duplicates', () => {
    expect(() =>
      simulateMeasures([measure('lng'), measure('biofuel')], context),
    ).toThrow(IncompatibleMeasuresError);
    expect(
      simulateMeasures([measure('solar'), measure('solar')], context).measures,
    ).toHaveLength(1);
  });
});
