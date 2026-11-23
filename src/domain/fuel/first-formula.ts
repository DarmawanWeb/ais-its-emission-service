import {
  evaluateFuelFormula,
  type FuelFormulaNode,
  FuelFormulaSyntaxError,
  parseFuelFormula,
} from '@darmawanweb/ais-its-contracts/domain';

import type { FuelConsumption } from './types.js';
import { getFuelByNavStatus } from './navstatus-multipliers.js';
import { litresToTonnes } from './units.js';

/** Floor of an evaluated fuel flow, L/min (legacy `Math.max(…, 0.5)`). */
// SOURCE: thesis — needs citation (minimum flow of the MVP, also applied at 0 kn)
export const MIN_FUEL_FLOW_L_PER_MIN = 0.5;

/**
 * A fuel flow formula, parsed once when valid: the contracts grammar of the
 * first fuel formula (`parseFuelFormula`, the same one fleet validates
 * with, spec §13.5 and §15.4), evaluated without `new Function`.
 */
export type FuelFlowFormula =
  | {
      readonly valid: true;
      readonly source: string;
      readonly ast: FuelFormulaNode;
    }
  | {
      readonly valid: false;
      readonly source: string;
      readonly error: FuelFormulaSyntaxError;
    };

/** Parses a formula string once; an invalid one is kept with its error. */
export function prepareFuelFlowFormula(source: string): FuelFlowFormula {
  try {
    return { valid: true, source, ast: parseFuelFormula(source) };
  } catch (error) {
    if (error instanceof FuelFormulaSyntaxError)
      return { valid: false, source, error };
    throw error;
  }
}

/**
 * Fuel flow of a formula at `speedKnot`, L/min: `max(f(V), 0.5)`; an invalid
 * formula yields 0.5 (legacy `evaluateFormula` returns 0.5 when evaluation
 * throws). As in the legacy, `NaN` is **not** clamped (`Math.max(NaN, 0.5)`).
 * The contracts evaluator is bit-identical to the formula evaluated as
 * JavaScript.
 *
 * @method fuel.first_formula
 * @param speedKnot segment speed, kn.
 */
export function evaluateFuelFlow(
  formula: FuelFlowFormula,
  speedKnot: number,
): number {
  if (!formula.valid) return MIN_FUEL_FLOW_L_PER_MIN;
  return Math.max(
    evaluateFuelFormula(formula.ast, { speedKnot }),
    MIN_FUEL_FLOW_L_PER_MIN,
  );
}

/** The vessel's first fuel formula (fleet `fuel_formulas`). */
export interface FirstFuelFormula {
  readonly mainEngine: FuelFlowFormula;
  readonly auxiliaryEngine: FuelFlowFormula;
}

/** Inputs of {@link calculateFirstFormulaFuel}. */
export interface FirstFormulaInput {
  /** AIS navstatus reported at the previous fix. */
  readonly navstatus: number;
  /** Fuel density, kg/L. */
  readonly densityKgPerL: number;
  /** Segment speed, kn (capped at 30). */
  readonly speedKnot: number;
  readonly formula: FirstFuelFormula;
  /** Segment duration, minutes. */
  readonly durationMinutes: number;
}

/**
 * First fuel formula: `q_x = max(f_x(V), 0.5)` L/min for x ∈ {ME, AE},
 * multiplied by the navstatus factor `k_x(n_prev)`, the segment minutes and
 * `ρ / 1000` to get tonnes; the total is `(q*_ME + q*_AE) × Δt × ρ / 1000`.
 *
 * Port of `calculateFirstFormulaFuel` (`be-legacy/src/utils/cii/fuel-calculation.ts`)
 * with the contracts' safe evaluator instead of `new Function` (spec §15.4).
 *
 * @method fuel.first_formula
 * @method fuel.navstatus_multipliers
 * @method fuel.density_conversion
 * @see docs/METHODOLOGY.md#fuel.first_formula
 */
export function calculateFirstFormulaFuel(
  input: FirstFormulaInput,
): FuelConsumption {
  const fuelEstimateMe = evaluateFuelFlow(
    input.formula.mainEngine,
    input.speedKnot,
  );
  const fuelEstimateAe = evaluateFuelFlow(
    input.formula.auxiliaryEngine,
    input.speedKnot,
  );
  const fuel = getFuelByNavStatus(
    input.navstatus,
    fuelEstimateMe,
    fuelEstimateAe,
  );
  const totalFuelEstimate =
    (fuel.totalMe + fuel.totalAe) * input.durationMinutes;
  return {
    meTon: litresToTonnes(
      fuel.totalMe * input.durationMinutes,
      input.densityKgPerL,
    ),
    aeTon: litresToTonnes(
      fuel.totalAe * input.durationMinutes,
      input.densityKgPerL,
    ),
    totalTon: litresToTonnes(totalFuelEstimate, input.densityKgPerL),
  };
}
