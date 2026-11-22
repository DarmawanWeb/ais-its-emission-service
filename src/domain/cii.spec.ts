import { assignCiiGrade } from '@darmawanweb/ais-its-contracts/domain';
import { describe, expect, it } from 'vitest';
import * as z from 'zod';

import {
  expectAllClose,
  expectClose,
  loadGolden,
  num,
} from '../../test/support/golden.js';
import {
  LegacyShipSchema,
  snapshotOfLegacyShip,
} from '../../test/support/legacy-ship.js';
import { ciiRatingProfileOf } from '../modules/profiles/vessel-profile.js';
import {
  attainedCii,
  co2FromFuel,
  DEFAULT_HIGHEST_REDUCTION_YEAR,
  gradeAgainstRequired,
  highestReductionFactorYear,
  rateCii,
  reductionFactorOf,
  referenceCii,
  requiredCii,
} from './cii.js';
import {
  elapsedYearFraction,
  projectYearEnd,
  projectTotals,
} from './cii-projection.js';

const DSchema = z.object({
  d1: z.number(),
  d2: z.number(),
  d3: z.number(),
  d4: z.number(),
});
const LegacyFuelSchema = z.object({
  fuelConsumptionMeTon: num,
  fuelConsumptionAeTon: num,
  totalFuelConsumptionTon: num,
});

const CII = loadGolden(
  'cii.json',
  z.object({
    zTable: z.array(z.object({ year: z.number(), zValue: z.number() })),
    required: z.array(
      z.object({
        input: z.object({
          ship: z.string(),
          a: z.number(),
          c: z.number(),
          capacity: z.number(),
          year: z.number().nullable(),
          zPercent: z.number(),
        }),
        output: num,
      }),
    ),
    accumulation: z.array(
      z.object({
        ship: z.string(),
        year: z.number(),
        steps: z.array(
          z.object({
            input: z.object({ segmentFuel: LegacyFuelSchema, distance: num }),
            output: z.object({
              ciiRequired: num,
              ciiAttained: num,
              ciiRating: num,
              ciiGrade: z.string(),
              totalDistance: num,
              fuelConsumption: LegacyFuelSchema,
            }),
          }),
        ),
      }),
    ),
    grades: z.array(
      z.object({
        input: z.object({ d: DSchema, rating: num }),
        output: z.string(),
      }),
    ),
    gradesNew: z.array(
      z.object({
        input: z.object({
          d: DSchema,
          attained: z.number(),
          required: z.number(),
        }),
        output: z.string(),
      }),
    ),
  }),
);

const SHIPS = loadGolden(
  'holtrop.json',
  z.object({ ships: z.record(z.string(), LegacyShipSchema) }),
).ships;

const FACTORS = CII.zTable.map((row) => ({
  year: row.year,
  zPercent: row.zValue,
  source: 'MEPC.338(76) / MEPC.400(83)',
}));

function profileOf(key: string) {
  const ship = SHIPS[key];
  if (ship === undefined) throw new Error(`no legacy ship ${key}`);
  return ciiRatingProfileOf(snapshotOfLegacyShip(ship, 1));
}

describe('required CII — golden parity with legacy calculateCIIRequired', () => {
  it.each(
    CII.required.map(
      (c) => [`${c.input.ship}/${c.input.year ?? 'current'}`, c] as const,
    ),
  )('%s', (label, c) => {
    const z = reductionFactorOf(FACTORS, c.input.year ?? 2026);
    expect(z).toBe(c.input.zPercent);
    const profile = profileOf(c.input.ship);
    expect(profile.capacity).toBe(c.input.capacity);
    expectAllClose(
      {
        required: [
          requiredCii(
            c.input.zPercent,
            referenceCii(profile.referenceLine, profile.capacity),
          ),
          c.output,
        ],
      },
      label,
    );
  });
});

describe('attained CII accumulation — golden parity with legacy calculateCII (one calendar year)', () => {
  it.each(CII.accumulation.map((a) => [a.ship, a] as const))(
    'ship %s',
    (ship, a) => {
      const profile = profileOf(ship);
      const conversionFactor =
        SHIPS[ship]?.fuelType.conversionFactor ?? Number.NaN;
      const z = reductionFactorOf(FACTORS, a.year) ?? Number.NaN;
      let fuel = 0;
      let fuelMe = 0;
      let fuelAe = 0;
      let distance = 0;
      a.steps.forEach((step, index) => {
        fuel += step.input.segmentFuel.totalFuelConsumptionTon;
        fuelMe += step.input.segmentFuel.fuelConsumptionMeTon;
        fuelAe += step.input.segmentFuel.fuelConsumptionAeTon;
        distance += step.input.distance;
        const figures = rateCii(
          { co2Ton: co2FromFuel(fuel, conversionFactor), distanceNm: distance },
          profile,
          z,
        );
        const legacy = step.output;
        expectAllClose(
          {
            attained: [figures.attained, legacy.ciiAttained],
            required: [figures.required, legacy.ciiRequired],
            rating: [figures.rating, legacy.ciiRating],
            distance: [distance, legacy.totalDistance],
            fuel: [fuel, legacy.fuelConsumption.totalFuelConsumptionTon],
            fuelMe: [fuelMe, legacy.fuelConsumption.fuelConsumptionMeTon],
            fuelAe: [fuelAe, legacy.fuelConsumption.fuelConsumptionAeTon],
          },
          `${ship} step ${index}`,
        );
        expect(figures.grade).toBe(legacy.ciiGrade);
        expectAllClose(
          {
            d1: [figures.boundaries.d1, profile.d.d1 * legacy.ciiRequired],
            d4: [figures.boundaries.d4, profile.d.d4 * legacy.ciiRequired],
          },
          `${ship} step ${index} boundaries`,
        );
      });
    },
  );
});

describe('grade assignment — golden parity with legacy assignGradeBasedOnDdVector(New)', () => {
  it('grades the rating by the d-vector (A < d1 ≤ B < d2 ≤ C < d3 ≤ D < d4 ≤ E)', () => {
    for (const c of CII.grades)
      expect(
        assignCiiGrade(c.input.rating, c.input.d),
        String(c.input.rating),
      ).toBe(c.output);
  });

  it('grades an attained CII against d_i × required', () => {
    for (const c of CII.gradesNew) {
      expect(
        gradeAgainstRequired(c.input.d, c.input.attained, c.input.required),
        JSON.stringify(c.input),
      ).toBe(c.output);
    }
  });
});

describe('CII helpers', () => {
  it('attained CII = CO2 / (distance × capacity) × 10⁶', () => {
    expect(attainedCii(3.206, 10, 2877)).toBeCloseTo(
      (3.206 / (10 * 2877)) * 1e6,
      12,
    );
  });

  it('reduction factor lookups', () => {
    expect(reductionFactorOf(FACTORS, 2027)).toBe(13.625);
    expect(reductionFactorOf(FACTORS, 2031)).toBeUndefined();
    expect(highestReductionFactorYear(FACTORS)).toBe(2030);
    expect(highestReductionFactorYear([])).toBe(DEFAULT_HIGHEST_REDUCTION_YEAR);
  });
});

describe('year-end projection', () => {
  it('elapsed fraction of the calendar year', () => {
    expect(
      elapsedYearFraction(2026, new Date('2026-01-01T00:00:00Z')),
    ).toBeGreaterThan(0);
    expect(
      elapsedYearFraction(2026, new Date('2026-07-02T12:00:00Z')),
    ).toBeCloseTo(0.5, 2);
    expect(elapsedYearFraction(2026, new Date('2027-03-01T00:00:00Z'))).toBe(1);
  });

  it('scales the year-to-date totals linearly', () => {
    expect(
      projectTotals(
        { distanceNm: 100, fuelMeTon: 2, fuelAeTon: 1, co2Ton: 9 },
        0.25,
      ),
    ).toEqual({
      distanceNm: 400,
      fuelMeTon: 8,
      fuelAeTon: 4,
      co2Ton: 36,
    });
  });

  it('rates the projected totals: attained, rating and grade equal the year-to-date values', () => {
    const ytd = {
      distanceNm: 1234.5,
      fuelMeTon: 21.5,
      fuelAeTon: 3.25,
      co2Ton: 79.3,
    };
    const capacity = 2877;
    const projection = projectYearEnd(ytd, 0.13, capacity);
    expect(projection.totals).toEqual(projectTotals(ytd, 0.13));
    expectClose(
      projection.attained,
      attainedCii(ytd.co2Ton, ytd.distanceNm, capacity),
      'projected attained',
    );
  });

  it('does not diverge for converging or rising cumulative values (the extrapolated trend did)', () => {
    // Five January days whose cumulative attained CII falls 30 → 22 (the
    // former least-squares projection gave 0, grade A) or rises 10 → 16
    // (it gave 538): the projection stays at the year-to-date value.
    const capacity = 1000;
    for (const ytdAttained of [22, 16]) {
      const distanceNm = 500;
      const co2Ton = (ytdAttained * capacity * distanceNm) / 1e6;
      const fraction = elapsedYearFraction(
        2026,
        new Date('2026-01-05T00:00:00Z'),
      );
      const projection = projectYearEnd(
        { distanceNm, fuelMeTon: 1, fuelAeTon: 0.1, co2Ton },
        fraction,
        capacity,
      );
      expectClose(projection.attained, ytdAttained, `attained ${ytdAttained}`);
      expect(projection.totals.distanceNm).toBeCloseTo(
        distanceNm / fraction,
        6,
      );
    }
  });
});
