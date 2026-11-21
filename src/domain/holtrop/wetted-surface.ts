import type { HullForm } from './types.js';

/**
 * Wetted surface (Holtrop–Mennen 1982), m²:
 * `S = L(2T + B)√C_M (0.453 + 0.4425 C_B − 0.2862 C_M − 0.003467 B/T + 0.3696 C_WP) + 2.38 A_BT / C_B`
 * with the bulb flag (0/1) used as `A_BT` (legacy, kept for parity).
 *
 * Port of `calculateS`
 * (`be-legacy/src/utils/cii/second-formula/total-resistance-calculation.ts`).
 *
 * @method resistance.holtrop.wetted_surface
 * @see docs/METHODOLOGY.md#resistance.holtrop.wetted_surface
 */
export function wettedSurface(hull: HullForm): number {
  const { lwl, t, b, cm, cb, cwp, bulbousBow } = hull;
  const bDivT = b / t;
  return (
    lwl *
      (2 * t + b) *
      Math.pow(cm, 0.5) *
      (0.453 + 0.4425 * cb - 0.2862 * cm - 0.003467 * bDivT + 0.3696 * cwp) +
    2.38 * ((bulbousBow ? 1 : 0) / cb)
  );
}
