import { describe, expect, it } from 'vitest';
import * as z from 'zod';

import { expectClose, loadGolden } from '../../test/support/golden.js';
import {
  LegacyShipSchema,
  snapshotOfLegacyShip,
} from '../../test/support/legacy-ship.js';
import { segmentFuelProfileOf } from '../modules/profiles/vessel-profile.js';
import { calculateSpeed } from './segment.js';
import {
  chooseFuelMethod,
  computeSegmentFuel,
  excludedSegment,
  type SegmentFuelInput,
} from './segment-fuel.js';

const SHIPS = loadGolden(
  'holtrop.json',
  z.object({ ships: z.record(z.string(), LegacyShipSchema) }),
).ships;
const shipA = SHIPS.A;
if (shipA === undefined) throw new Error('missing legacy ship A');

const FIRST = loadGolden(
  'first-formula.json',
  z.object({
    cases: z.array(
      z.object({
        name: z.string(),
        output: z.object({
          fuelConsumptionMeTon: z.number(),
          fuelConsumptionAeTon: z.number(),
          totalFuelConsumptionTon: z.number(),
        }),
      }),
    ),
  }),
);

const start = new Date('2026-03-10T08:00:00.000Z');
const end = new Date('2026-03-10T08:10:00.000Z');
// legacy speed case "northeast-13kn"
const kinematics = calculateSpeed(
  { lat: 1.12, lon: 104.03, time: end },
  { lat: 1.1, lon: 104.0, time: start },
);

function inputFor(
  withFormula: boolean,
  readings: SegmentFuelInput['readings'] = [],
): SegmentFuelInput {
  if (shipA === undefined) throw new Error('missing legacy ship A');
  return {
    kinematics,
    window: { start, end },
    navstatus: 0,
    profile: segmentFuelProfileOf(
      snapshotOfLegacyShip(shipA, 1, { firstFuelFormula: withFormula }),
    ),
    readings,
    telemetryActiveWindowMinutes: 10,
  };
}

describe('computeSegmentFuel', () => {
  it('first formula: legacy calculateFirstFormulaFuel, CO2 = total × C_F', () => {
    const input = inputFor(true);
    expect(chooseFuelMethod(input)).toBe('first_formula');
    const result = computeSegmentFuel(input, 'first_formula', null);
    const golden = FIRST.cases.find(
      (c) => c.name === 'postman-sample/northeast-13kn/nav0',
    )?.output;
    if (golden === undefined) throw new Error('missing golden case');
    expect(result.method).toBe('first_formula');
    expect(result.flags).toEqual([]);
    expectClose(result.fuelMeTon, golden.fuelConsumptionMeTon, 'ME');
    expectClose(result.fuelAeTon, golden.fuelConsumptionAeTon, 'AE');
    expectClose(result.co2Ton, golden.totalFuelConsumptionTon * 3.206, 'CO2');
  });

  it('telemetry: attributed readings win over the formula, without navstatus multipliers', () => {
    const readings = [
      { time: end, periodStart: start, fuelMeTon: 0.12, fuelAeTon: 0.03 },
    ];
    const input = { ...inputFor(true, readings), navstatus: 1 };
    expect(chooseFuelMethod(input)).toBe('telemetry');
    const result = computeSegmentFuel(input, 'telemetry', null);
    expect(result).toMatchObject({
      method: 'telemetry',
      fuelMeTon: 0.12,
      fuelAeTon: 0.03,
      telemetryReadings: 1,
      flags: [],
    });
    expectClose(result.co2Ton, (0.12 + 0.03) * 3.206, 'CO2');
  });

  it('Holtrop without a formula; nothing without any fuel model', () => {
    const input = inputFor(false);
    expect(chooseFuelMethod(input)).toBe('holtrop');
    const withoutEngine = {
      ...input,
      profile: { ...input.profile, mainEngineSfoc: null },
    };
    expect(chooseFuelMethod(withoutEngine)).toBeNull();
    expect(computeSegmentFuel(withoutEngine, null, null)).toEqual(
      excludedSegment('no_fuel_model'),
    );
  });

  it('flags a formula that does not compile (legacy 0.5 L/min fallback)', () => {
    const snapshot = {
      ...snapshotOfLegacyShip(shipA, 1),
      firstFuelFormula: {
        id: '0190d5c0-0000-7000-8000-000000000999',
        mainEngineFormula: '1 +',
        auxiliaryEngineFormula: '1',
      },
    };
    const result = computeSegmentFuel(
      { ...inputFor(true), profile: segmentFuelProfileOf(snapshot) },
      'first_formula',
      null,
    );
    expect(result.flags).toEqual(['formula_error']);
    // 0.5 L/min × 10 min × 0.86 kg/L / 1000
    expect(result.fuelMeTon).toBeCloseTo((0.5 * 10 * 0.86) / 1000, 15);
  });
});
