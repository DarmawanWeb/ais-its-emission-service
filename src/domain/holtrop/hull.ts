import type { HullForm } from './types.js';

/**
 * Length used for displacement and form factors, m: `L_d = (L_WL + L_PP) / 2`.
 *
 * Port of `calculateLengthDisplacement`
 * (`be-legacy/src/utils/cii/second-formula/size-calculation.ts`).
 *
 * @method resistance.hull_volumes_and_lengths
 */
export function lengthDisplacement(hull: Pick<HullForm, 'lwl' | 'lpp'>): number {
  return (hull.lwl + hull.lpp) / 2;
}

/**
 * Displacement (mass) at service draught, t:
 * `Δ = L_d · B · T · C_B,nsp · 1.025` (sea water 1.025 t/m³).
 *
 * Port of `calculateDisplacement`
 * (`be-legacy/src/utils/cii/second-formula/size-calculation.ts`).
 *
 * @method resistance.hull_volumes_and_lengths
 * @see docs/METHODOLOGY.md#resistance.hull_volumes_and_lengths
 */
export function displacementTonnes(hull: HullForm): number {
  return lengthDisplacement(hull) * hull.b * hull.t * hull.cbnsp * 1.025;
}

/**
 * Displaced volume, m³: `∇ = B · T · C_B · L_d` (operand order of the legacy
 * `calculateC15` / `calculateOnePlusK1`, kept for bit-identical results).
 *
 * @method resistance.hull_volumes_and_lengths
 */
export function displacementVolume(hull: HullForm): number {
  return hull.b * hull.t * hull.cb * lengthDisplacement(hull);
}
