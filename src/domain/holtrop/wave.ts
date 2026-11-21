import { lengthDisplacement } from './hull.js';
import { lcb, lengthOfRun } from './form-factor.js';
import type { HullForm } from './types.js';
import { GRAVITY } from './numbers.js';

/** Sea water density of the wave and correlation terms, kg/m³. */
export const WAVE_WATER_DENSITY = 1025;

/**
 * Half angle of entrance, degrees (Holtrop–Mennen 1982):
 * `iE = 1 + 89 exp(−(L/B)^0.80856 (1 − C_WP)^0.30484 (1 − C_P − 0.0225 lcb)^0.6367 (L_R/B)^0.34574 (100∇/L³)^0.16302)`.
 *
 * Port of `calculateIE`
 * (`be-legacy/src/utils/cii/second-formula/total-resistance-calculation.ts`).
 *
 * @method resistance.holtrop.wave_c1_c7_ie
 * @see docs/METHODOLOGY.md#resistance.holtrop.wave_c1_c7_ie
 */
export function halfAngleOfEntrance(hull: HullForm): number {
  const lr = lengthOfRun(hull);
  const { lwl, b, t, cb, cwp, cp } = hull;
  return (
    1 +
    89 *
      Math.exp(
        -(
          (lwl / b) ** 0.80856 *
          (1 - cwp) ** 0.30484 *
          (1 - cp - 0.0225 * lcb(hull)) ** 0.6367 *
          (lr / b) ** 0.34574 *
          ((100 * t * lwl * b * cb) / lwl ** 3) ** 0.16302
        ),
      )
  );
}

/**
 * `c₇` by `B/L`: `≤ 0.11 → 0.229577 (B/L)^0.33333`, `< 0.25 → B/L`,
 * `≥ 0.25 → 0.5 − 0.0625 B/T` (legacy uses B/T in the last branch).
 *
 * Port of `calculateC7`.
 *
 * @method resistance.holtrop.wave_c1_c7_ie
 */
export function c7(hull: Pick<HullForm, 'b' | 'lwl' | 't'>): number {
  const { b, lwl, t } = hull;
  const bDivLwl = b / lwl;
  const bDivT = b / t;
  if (bDivLwl <= 0.11) return 0.229577 * Math.pow(bDivLwl, 0.33333);
  if (bDivLwl > 0.11 && bDivLwl < 0.25) return bDivLwl;
  if (bDivLwl >= 0.25) return 0.5 - 0.0625 * bDivT;
  return 0;
}

/**
 * `c₁ = 2223105 c₇^3.78613 (T/B)^1.07961 (90 − iE)^−1.37565`.
 *
 * Port of `calculateC1`.
 *
 * @method resistance.holtrop.wave_c1_c7_ie
 */
export function c1(hull: HullForm, c7Value: number = c7(hull)): number {
  const ie = halfAngleOfEntrance(hull);
  return 2223105 * Math.pow(c7Value, 3.78613) * Math.pow(hull.t / hull.b, 1.07961) * Math.pow(90 - ie, -1.37565);
}

/** Bulb and transom terms of the wave resistance. */
export interface BulbTransomTerms {
  /** `c₂ = exp(−1.89 √c₃)` (input `c3` of the vessel, not the bulb formula). */
  readonly c2: number;
  /** `c₅ = 1 − 0.8 A_T / (B T C_M)` with `A_T = 0` (= 1; legacy divides by B·C_B·C_M). */
  readonly c5: number;
}

/**
 * Bulb (`c₂`) and transom (`c₅`) terms as implemented by the legacy (R_B and
 * R_TR omitted).
 *
 * Port of `calculateC2` / `calculateC5`.
 *
 * @method resistance.holtrop.wave_bulb_transom
 * @see docs/METHODOLOGY.md#resistance.holtrop.wave_bulb_transom
 */
export function bulbTransomTerms(hull: Pick<HullForm, 'c3' | 'b' | 'cb' | 'cm'>): BulbTransomTerms {
  const { b, cb, cm } = hull;
  return {
    c2: Math.exp(-1.89 * Math.sqrt(hull.c3)),
    c5: 1 - (0.8 * 0) / (b * cb * cm),
  };
}

/** Exponent terms of the wave resistance. */
export interface WaveExponentTerms {
  readonly c15: number;
  readonly c16: number;
  readonly m1: number;
  readonly lambda: number;
}

/**
 * `c₁₅` by `L³/∇`: `≤ 512 → −1.69385`, `≥ 1727 → L³/∇` (legacy returns the
 * ratio itself where Holtrop–Mennen give 0), else `−1.69385 + (L/∇^⅓ − 8) / 2.36`.
 *
 * Port of `calculateC15`.
 *
 * @method resistance.holtrop.wave_m1_m2_lambda
 */
export function c15(hull: HullForm): number {
  const VDisplacement = hull.b * hull.t * hull.cb * lengthDisplacement(hull);
  const l3DivVDisp = Math.pow(hull.lwl, 3) / VDisplacement;
  const lDivCubeRootVDisp = hull.lwl / Math.cbrt(VDisplacement);
  if (l3DivVDisp <= 512) return -1.69385;
  if (l3DivVDisp >= 1727) return l3DivVDisp;
  if (l3DivVDisp > 512 && l3DivVDisp < 1727) return -1.69385 + (lDivCubeRootVDisp - 8) / 2.36;
  return 0;
}

/**
 * `c₁₆ = 8.07981 C_P − 13.8673 C_P² + 6.984388 C_P³` for `C_P < 0.8`,
 * `1.73014 − 0.7067 C_P` for `C_P > 0.8`, `0` at exactly 0.8 (legacy).
 *
 * Port of `calculateC16`.
 *
 * @method resistance.holtrop.wave_m1_m2_lambda
 */
export function c16(hull: Pick<HullForm, 'cp'>): number {
  const { cp } = hull;
  if (cp < 0.8) return 8.07981 * cp - 13.8673 * Math.pow(cp, 2) + 6.984388 * Math.pow(cp, 3);
  if (cp > 0.8) return 1.73014 - 0.7067 * cp;
  return 0;
}

/**
 * `m₁ = 0.0140407 L/T − 1.75254 ∇^⅓/L − 4.79323 B/L − c₁₆`.
 *
 * Port of `calculateM1`.
 *
 * @method resistance.holtrop.wave_m1_m2_lambda
 */
export function m1(hull: HullForm): number {
  const { lwl, t, cb, b } = hull;
  const C16 = c16(hull);
  const Vdispl = cb * t * b * lengthDisplacement(hull);
  return 0.0140407 * (lwl / t) - 1.75254 * (Math.pow(Vdispl, 1 / 3) / lwl) - 4.79323 * (b / lwl) - C16;
}

/**
 * `m₂ = c₁₅ C_P² exp(−0.1 Fn⁻²)`.
 *
 * Port of `calculateM2`.
 *
 * @method resistance.holtrop.wave_m1_m2_lambda
 * @param newFn Froude number at the calm-water-equivalent speed.
 */
export function m2(hull: HullForm, newFn: number): number {
  return c15(hull) * Math.pow(hull.cp, 2) * Math.exp(-0.1 * Math.pow(newFn, -2));
}

/**
 * `λ = 1.446 C_P − 0.03 L/B` for `L/B ≤ 12`, else `1.446 C_P − 0.36`.
 *
 * Port of `calculateLamda`.
 *
 * @method resistance.holtrop.wave_m1_m2_lambda
 */
export function lambda(hull: Pick<HullForm, 'lwl' | 'b' | 'cp'>): number {
  const lDivB = hull.lwl / hull.b;
  return lDivB <= 12 ? 1.446 * hull.cp - 0.03 * lDivB : 1.446 * hull.cp - 0.36;
}

/**
 * The speed-independent exponent terms (`c₁₅`, `c₁₆`, `m₁`, `λ`).
 *
 * @method resistance.holtrop.wave_m1_m2_lambda
 * @see docs/METHODOLOGY.md#resistance.holtrop.wave_m1_m2_lambda
 */
export function exponentTerms(hull: HullForm): WaveExponentTerms {
  return { c15: c15(hull), c16: c16(hull), m1: m1(hull), lambda: lambda(hull) };
}

/**
 * Wave-making resistance (Holtrop–Mennen, Fn ≤ 0.4 branch), N:
 * `R_W = c₁ c₂ c₅ ∇ ρ g exp(m₁ Fn^−0.9 + m₂ cos(λ Fn⁻²))`, ∇ = L·B·T·C_B,
 * ρ = 1025 kg/m³, g = 9.81 m/s².
 *
 * Port of `calculateRw`.
 *
 * @method resistance.holtrop.wave
 * @param newFn Froude number at the calm-water-equivalent speed.
 * @see docs/METHODOLOGY.md#resistance.holtrop.wave
 */
export function waveResistance(hull: HullForm, newFn: number): number {
  const C1 = c1(hull, c7(hull));
  const { c2: C2, c5: C5 } = bulbTransomTerms(hull);
  const { lwl, b, t, cb } = hull;
  const M1 = m1(hull);
  const M2 = m2(hull, newFn);
  const lamda = lambda(hull);
  return (
    C1 *
    C2 *
    C5 *
    (lwl * b * t * cb) *
    WAVE_WATER_DENSITY *
    GRAVITY *
    Math.exp(M1 * Math.pow(newFn, -0.9) + M2 * Math.cos(lamda * Math.pow(newFn, -2)))
  );
}
