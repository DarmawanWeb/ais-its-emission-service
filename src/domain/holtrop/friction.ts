/** Sea water density used by the legacy friction terms, kg/m³ (R_F, R_APP). */
// SOURCE: thesis — needs citation (1024 here vs 1025 in R_W / R_A, kept for parity)
export const FRICTION_WATER_DENSITY = 1024;

/**
 * ITTC-1957 model-ship correlation line `C_F = 0.075 / (log₁₀ Re − 2)²`.
 *
 * Port of the `cf` term of `calculateFrictionResistance`
 * (`be-legacy/src/utils/cii/second-formula/friction-resistance-calculation.ts`).
 *
 * @method resistance.holtrop.friction_line
 * @see docs/METHODOLOGY.md#resistance.holtrop.friction_line
 * @see https://www.ittc.info/media/9583/75-02-02-01.pdf
 */
export function frictionCoefficient(reynolds: number): number {
  return 0.075 / Math.pow(Math.log10(reynolds) - 2, 2);
}

/**
 * Frictional resistance as implemented by the legacy, N:
 * `R_F = ½ · 1024 · C_F · (B / T) · V²` — with `B/T` where Holtrop–Mennen use
 * the wetted surface S (kept for parity, METHODOLOGY §19).
 *
 * Port of the `Rf` term of `calculateFrictionResistance`.
 *
 * @method resistance.holtrop.friction
 * @param cf ITTC-1957 friction coefficient.
 * @param speedMs calm-water-equivalent speed, m/s.
 * @see docs/METHODOLOGY.md#resistance.holtrop.friction
 * @see https://repository.tudelft.nl/record/uuid:ee370fed-4b8f-4a5c-8e4e-7b8a1ca7e37a (Holtrop & Mennen 1982)
 */
export function frictionResistance(
  cf: number,
  b: number,
  t: number,
  speedMs: number,
): number {
  return 0.5 * FRICTION_WATER_DENSITY * cf * (b / t) * (speedMs * speedMs);
}
