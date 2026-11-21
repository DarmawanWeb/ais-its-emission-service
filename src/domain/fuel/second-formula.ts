import type { FuelConsumption } from './types.js';
import { getFuelByNavStatus } from './navstatus-multipliers.js';
import { litresToTonnes } from './units.js';

/**
 * Auxiliary engine fuel flow regression of the Holtrop path, L/min:
 * `q_AE = 1.5103 · exp(−0.064 · V)` with V the calm-water-equivalent speed, kn.
 *
 * Port of the AE term of `calculateSecondFormulaFuel`
 * (`be-legacy/src/utils/cii/fuel-calculation.ts`).
 *
 * @method fuel.ae_regression
 * @see docs/METHODOLOGY.md#fuel.ae_regression
 */
// SOURCE: thesis — needs citation (regression fitted on the sample vessel)
export function auxiliaryFlowLMin(speedKnot: number): number {
  return 1.5103 * Math.exp(-0.064 * speedKnot);
}

/** Inputs of {@link calculateSecondFormulaFuel}. */
export interface SecondFormulaInput {
  /** Brake power at MCR from the Holtrop chain, kW. */
  readonly bhpMcrKw: number;
  /** Main engine specific fuel oil consumption, g/kWh. */
  readonly sfocGPerKwh: number;
  /** Sailing time at the calm-water-equivalent speed, h (`t_new = d / V_new`). */
  readonly newTimeHours: number;
  /** Calm-water-equivalent speed, kn. */
  readonly newSpeedKnot: number;
  /** Fuel density, kg/L. */
  readonly densityKgPerL: number;
  /** AIS navstatus reported at the previous fix. */
  readonly navstatus: number;
}

/**
 * Fuel of the Holtrop path (second formula):
 * `FC_ME = P_MCR · SFOC · t_new / 10⁶` t and
 * `FC_AE = 1.5103 · exp(−0.064 · V_new) · ρ / 1000` t — **not** multiplied by
 * the segment duration (legacy behaviour kept for parity) — then the navstatus
 * multipliers of the previous fix; total `FC*_ME + FC*_AE`.
 *
 * Port of `calculateSecondFormulaFuel` (`be-legacy/src/utils/cii/fuel-calculation.ts`).
 *
 * @method fuel.second_formula_me
 * @method fuel.second_formula_ae
 * @method fuel.navstatus_multipliers
 * @see docs/METHODOLOGY.md#fuel.second_formula_me
 * @see docs/METHODOLOGY.md#fuel.second_formula_ae
 */
export function calculateSecondFormulaFuel(
  input: SecondFormulaInput,
): FuelConsumption {
  const fuelEstimateMe =
    (input.bhpMcrKw * input.sfocGPerKwh * input.newTimeHours) / 1000000;
  const fuelEstimateAe = litresToTonnes(
    auxiliaryFlowLMin(input.newSpeedKnot),
    input.densityKgPerL,
  );
  const fuel = getFuelByNavStatus(
    input.navstatus,
    fuelEstimateMe,
    fuelEstimateAe,
  );
  return {
    meTon: fuel.totalMe,
    aeTon: fuel.totalAe,
    totalTon: fuel.totalMe + fuel.totalAe,
  };
}
