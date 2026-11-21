import type { HullForm } from './types.js';
import { FRICTION_WATER_DENSITY } from './friction.js';

/** Appendage form factor `1 + k₂` used by the legacy. */
// SOURCE: thesis — needs citation (single value 4.3 for all appendages)
export const APPENDAGE_FORM_FACTOR = 4.3;

/**
 * Wetted area of the appendages, m²:
 * `S_APP = c₁ · c₂ · c₃ · c₅ · (1.75 · L_WL · T / 100)` (rudder-area rule).
 *
 * Port of `calculateSaap`
 * (`be-legacy/src/utils/cii/second-formula/friction-resistance-calculation.ts`).
 *
 * @method resistance.holtrop.appendage
 * @see docs/METHODOLOGY.md#resistance.holtrop.appendage
 */
export function appendageArea(hull: Pick<HullForm, 'c1' | 'c2' | 'c3' | 'c5' | 'lwl' | 't'>): number {
  return hull.c1 * hull.c2 * hull.c3 * hull.c5 * ((1.75 * hull.lwl * hull.t) / 100);
}

/**
 * Appendage resistance, N: `R_APP = ½ · 1024 · V² · C_F · S_APP · (1 + k₂)`.
 *
 * Port of the `Raap` term of `calculateFrictionResistance`.
 *
 * @method resistance.holtrop.appendage
 * @param speedMs calm-water-equivalent speed, m/s.
 */
export function appendageResistance(speedMs: number, cf: number, area: number): number {
  return 0.5 * FRICTION_WATER_DENSITY * Math.pow(speedMs, 2) * cf * area * APPENDAGE_FORM_FACTOR;
}
