import { describe, expect, it } from 'vitest';
import * as z from 'zod';

import {
  expectAllClose,
  expectClose,
  loadGolden,
  num,
} from '../../../test/support/golden.js';
import {
  calculateFirstFormulaFuel,
  evaluateFuelFlow,
  MIN_FUEL_FLOW_L_PER_MIN,
  prepareFuelFlowFormula,
} from './first-formula.js';
import {
  FUEL_NAVSTATUS_MULTIPLIERS,
  getFuelByNavStatus,
} from './navstatus-multipliers.js';
import { litresToTonnes } from './units.js';

const FIRST = loadGolden(
  'first-formula.json',
  z.object({
    multipliers: z.record(
      z.string(),
      z.object({ ME: z.number(), AE: z.number() }),
    ),
    navstatus: z.array(
      z.object({
        navstatus: z.number(),
        input: z.object({ fuelMe: z.number(), fuelAe: z.number() }),
        output: z.object({ totalME: num, totalAE: num }),
      }),
    ),
    totalFuelTon: z.array(
      z.object({
        input: z.object({ litres: z.number(), density: z.number() }),
        output: num,
      }),
    ),
    cases: z.array(
      z.object({
        name: z.string(),
        input: z.object({
          navstatus: z.number(),
          fuelDensity: z.number(),
          speedKnot: z.number(),
          formula: z.object({
            mainEngineFormula: z.string(),
            auxiliaryEngineFormula: z.string(),
          }),
          timeDifferenceMinutes: z.number(),
        }),
        flows: z.object({ me: num, ae: num }),
        output: z.object({
          fuelConsumptionMeTon: num,
          fuelConsumptionAeTon: num,
          totalFuelConsumptionTon: num,
        }),
      }),
    ),
  }),
);

describe('fuel navstatus multipliers — golden parity with legacy getFuelByNavStatus', () => {
  it('has the legacy table for every AIS navstatus 0–15', () => {
    const table = Object.fromEntries(
      Object.entries(FUEL_NAVSTATUS_MULTIPLIERS).map(([code, m]) => [
        code,
        { ME: m.me, AE: m.ae },
      ]),
    );
    expect(table).toEqual(FIRST.multipliers);
  });

  it.each(FIRST.navstatus.map((c) => [c.navstatus, c] as const))(
    'navstatus %s',
    (_navstatus, c) => {
      const result = getFuelByNavStatus(
        c.navstatus,
        c.input.fuelMe,
        c.input.fuelAe,
      );
      expectAllClose(
        {
          me: [result.totalMe, c.output.totalME],
          ae: [result.totalAe, c.output.totalAE],
        },
        `nav ${c.navstatus}`,
      );
    },
  );

  it('converts litres to tonnes with the density (legacy calculateTotalFuelTon)', () => {
    for (const c of FIRST.totalFuelTon) {
      expectClose(
        litresToTonnes(c.input.litres, c.input.density),
        c.output,
        `${c.input.litres} L`,
      );
    }
  });
});

describe('calculateFirstFormulaFuel — golden parity with legacy (safe evaluator instead of new Function)', () => {
  it.each(FIRST.cases.map((c) => [c.name, c] as const))('%s', (name, c) => {
    const formula = {
      mainEngine: prepareFuelFlowFormula(c.input.formula.mainEngineFormula),
      auxiliaryEngine: prepareFuelFlowFormula(
        c.input.formula.auxiliaryEngineFormula,
      ),
    };
    expectClose(
      evaluateFuelFlow(formula.mainEngine, c.input.speedKnot),
      c.flows.me,
      `${name} ME flow`,
    );
    expectClose(
      evaluateFuelFlow(formula.auxiliaryEngine, c.input.speedKnot),
      c.flows.ae,
      `${name} AE flow`,
    );
    const result = calculateFirstFormulaFuel({
      navstatus: c.input.navstatus,
      densityKgPerL: c.input.fuelDensity,
      speedKnot: c.input.speedKnot,
      formula,
      durationMinutes: c.input.timeDifferenceMinutes,
    });
    expectAllClose(
      {
        me: [result.meTon, c.output.fuelConsumptionMeTon],
        ae: [result.aeTon, c.output.fuelConsumptionAeTon],
        total: [result.totalTon, c.output.totalFuelConsumptionTon],
      },
      name,
    );
  });

  it('falls back to 0.5 L/min for a formula with a syntax error', () => {
    const formula = prepareFuelFlowFormula('0.5 * speedKnot +');
    expect(formula.valid).toBe(false);
    expect(evaluateFuelFlow(formula, 12)).toBe(MIN_FUEL_FLOW_L_PER_MIN);
  });

  it('floors the flow at 0.5 L/min', () => {
    expect(
      evaluateFuelFlow(prepareFuelFlowFormula('0.01 * speedKnot - 1'), 10),
    ).toBe(0.5);
  });
});
