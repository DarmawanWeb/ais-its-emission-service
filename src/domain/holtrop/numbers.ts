/** Gravitational acceleration used by the legacy, m/s². */
export const GRAVITY = 9.81;

/** Kinematic viscosity of sea water used by the legacy, m²/s. */
export const SEA_WATER_KINEMATIC_VISCOSITY = 0.000001188;

/**
 * Froude number `Fn = V / √(g · L_WL)` (V in m/s, L_WL in m).
 *
 * Port of `calculateFN` / `calculateNewFn`
 * (`be-legacy/src/utils/cii/second-formula/coefisien-reduction-calculation.ts`,
 * `friction-resistance-calculation.ts`).
 *
 * @method resistance.holtrop.reynolds_froude
 * @see docs/METHODOLOGY.md#resistance.holtrop.reynolds_froude
 */
export function froudeNumber(speedMs: number, lwl: number): number {
  return speedMs / Math.sqrt(GRAVITY * lwl);
}

/**
 * Reynolds number `Re = L_WL · V / ν` with ν = 1.188·10⁻⁶ m²/s.
 *
 * Port of `calculateRenouldNumber`
 * (`be-legacy/src/utils/cii/second-formula/friction-resistance-calculation.ts`).
 *
 * @method resistance.holtrop.reynolds_froude
 * @see https://www.ittc.info/media/4048/75-02-01-03.pdf (ITTC water properties)
 */
export function reynoldsNumber(lwl: number, speedMs: number): number {
  return (lwl * speedMs) / SEA_WATER_KINEMATIC_VISCOSITY;
}
