import { correlationResistance } from './correlation.js';
import { onePlusK1 } from './form-factor.js';
import type { HullForm } from './types.js';
import { waveResistance } from './wave.js';

/** Sea margin applied to the calm-water resistance (15 %). */
// SOURCE: thesis — needs citation (sea margin value of the MVP)
export const SEA_MARGIN = 1.15;

/** Total resistance (legacy `ITotalResistance`). */
export interface TotalResistance {
  /** Calm-water total resistance, kN. */
  readonly rt: number;
  /** `rt` with the 15 % sea margin, kN. */
  readonly rtPlusSm: number;
}

/** The speed-dependent resistance components entering the total. */
export interface ResistanceComponents {
  /** Frictional resistance, N. */
  readonly rf: number;
  /** Appendage resistance, N. */
  readonly raap: number;
  /** Froude number at the calm-water-equivalent speed. */
  readonly newFn: number;
  /** Calm-water-equivalent speed, m/s. */
  readonly speedMs: number;
}

/**
 * Total resistance, kN: `R_T = (R_F (1 + k₁) + R_APP + R_W + R_A) / 1000`
 * (R_B and R_TR omitted), with sea margin `R_T · 1.15`.
 *
 * Port of `calculateTotalResistance`
 * (`be-legacy/src/utils/cii/second-formula/total-resistance-calculation.ts`).
 *
 * @method resistance.total_and_sea_margin
 * @see docs/METHODOLOGY.md#resistance.total_and_sea_margin
 */
export function totalResistance(hull: HullForm, components: ResistanceComponents): TotalResistance {
  const rw = waveResistance(hull, components.newFn);
  const ra = correlationResistance(hull, components.speedMs);
  const rt = (components.rf * onePlusK1(hull) + components.raap + rw + ra) / 1000;
  return { rt, rtPlusSm: rt * SEA_MARGIN };
}
