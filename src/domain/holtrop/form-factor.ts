import { lengthDisplacement } from './hull.js';
import type { HullForm } from './types.js';

/**
 * Longitudinal centre of buoyancy as used by the legacy:
 * `lcb = 0.25 · L_d / 100` (metres, where Holtrop expects percent of L).
 *
 * Port of `calculateLCB`
 * (`be-legacy/src/utils/cii/second-formula/total-resistance-calculation.ts`).
 *
 * @method resistance.holtrop.lcb_length_of_run
 * @see docs/METHODOLOGY.md#resistance.holtrop.lcb_length_of_run
 */
export function lcb(hull: Pick<HullForm, 'lwl' | 'lpp'>): number {
  return (lengthDisplacement(hull) * 0.25) / 100;
}

/**
 * Length of run, m: `L_R = L_PP (1 − C_P + 0.06 C_P lcb / (4 C_P − 1))`.
 *
 * Port of `calculateLr`.
 *
 * @method resistance.holtrop.lcb_length_of_run
 */
export function lengthOfRun(
  hull: Pick<HullForm, 'lwl' | 'lpp' | 'cp'>,
): number {
  return (
    hull.lpp * (1 - hull.cp + 0.06 * hull.cp * (lcb(hull) / (4 * hull.cp - 1)))
  );
}

/**
 * Hull form factor (Holtrop 1984):
 * `1 + k₁ = 0.93 + 0.487118 c₁₄ (B/L_R)^1.06806 (T/L)^0.46106 (L/L_R)^0.121563 (L³/∇)^0.36486 (1 − C_P)^−0.604247`
 * with `c₁₄ = 1 + 0.011 C_stern` (legacy uses B/L_R where Holtrop has B/L).
 *
 * Port of `calculateOnePlusK1`.
 *
 * @method resistance.holtrop.form_factor
 * @see docs/METHODOLOGY.md#resistance.holtrop.form_factor
 */
export function onePlusK1(hull: HullForm): number {
  const VDisplacement = hull.b * hull.t * hull.cb * lengthDisplacement(hull);
  const lr = lengthOfRun(hull);
  const c14 = 1 + 0.011 * hull.cstern;
  const bDivLr = hull.b / lr;
  const tDivL = hull.t / hull.lwl;
  const lDivLr = hull.lwl / lr;
  const l3DivVDisp = Math.pow(hull.lwl, 3) / VDisplacement;
  const oneMinCp = 1 - hull.cp;
  return (
    0.93 +
    0.487118 *
      c14 *
      Math.pow(bDivLr, 1.06806) *
      Math.pow(tDivL, 0.46106) *
      Math.pow(lDivLr, 0.121563) *
      Math.pow(l3DivVDisp, 0.36486) *
      Math.pow(oneMinCp, -0.604247)
  );
}
