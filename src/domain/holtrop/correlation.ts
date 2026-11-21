import type { HullForm } from './types.js';
import { WAVE_WATER_DENSITY } from './wave.js';
import { wettedSurface } from './wetted-surface.js';

/**
 * `c₄ = T_F / L` capped at 0.04.
 *
 * Port of `calculateC4`
 * (`be-legacy/src/utils/cii/second-formula/total-resistance-calculation.ts`).
 *
 * @method resistance.holtrop.correlation_allowance
 */
export function c4(hull: Pick<HullForm, 't' | 'lwl'>): number {
  const tfDivL = hull.t / hull.lwl;
  return tfDivL <= 0.04 ? tfDivL : 0.04;
}

/**
 * Model-ship correlation allowance (Holtrop–Mennen 1982):
 * `C_A = 0.006 (L + 100)^−0.16 − 0.00205 + 0.003 √(L/7.5) C_B⁴ c₂ (0.04 − c₄)`
 * with `c₂ = 1`.
 *
 * Port of `calculateCa`.
 *
 * @method resistance.holtrop.correlation_allowance
 * @see docs/METHODOLOGY.md#resistance.holtrop.correlation_allowance
 */
export function correlationAllowance(hull: Pick<HullForm, 't' | 'lwl' | 'cb'>): number {
  const { lwl, cb } = hull;
  const C4 = c4(hull);
  return 0.006 * Math.pow(lwl + 100, -0.16) - 0.00205 + 0.003 * (Math.pow(lwl / 7.5, 0.5) * Math.pow(cb, 4) * 1 * (0.04 - C4));
}

/**
 * Correlation resistance, N: `R_A = ½ · 1025 · V² · S · C_A`.
 *
 * Port of `calculateRa`.
 *
 * @method resistance.holtrop.correlation_allowance
 * @param speedMs calm-water-equivalent speed, m/s.
 */
export function correlationResistance(hull: HullForm, speedMs: number): number {
  const s = wettedSurface(hull);
  const ca = correlationAllowance(hull);
  return 0.5 * WAVE_WATER_DENSITY * Math.pow(speedMs, 2) * s * ca;
}
