import { knotsToMs } from '@darmawanweb/ais-its-contracts/domain';

import { displacementTonnes } from '../holtrop/hull.js';
import { froudeNumber } from '../holtrop/numbers.js';
import type { HullForm, Speed } from '../holtrop/types.js';
import type { WindCourse } from './types.js';

/**
 * Kwon speed reduction coefficient `C_U` by block-coefficient band (loaded
 * condition), from the Froude number of the AIS speed; `0` outside
 * `0.55 ≤ C_B < 0.9`.
 *
 * Port of `calculateSpeedReductionCoef`
 * (`be-legacy/src/utils/cii/second-formula/coefisien-reduction-calculation.ts`).
 *
 * @method weather.kwon_speed_coefficient
 * @param speedMs AIS segment speed, m/s.
 * @see docs/METHODOLOGY.md#weather.kwon_speed_coefficient
 */
export function speedCoefficient(
  hull: Pick<HullForm, 'cb' | 'lwl'>,
  speedMs: number,
): number {
  const fn = froudeNumber(speedMs, hull.lwl);
  const cb = hull.cb;
  if (cb >= 0.55 && cb < 0.6) return 1.7 - 1.4 * fn - 7.4 * Math.pow(fn, 2);
  if (cb >= 0.6 && cb < 0.65) return 2.2 - 2.5 * fn - 9.7 * Math.pow(fn, 2);
  if (cb >= 0.65 && cb < 0.7) return 2.6 - 3.7 * fn - 11.6 * Math.pow(fn, 2);
  if (cb >= 0.7 && cb < 0.75) return 3.1 - 5.3 * fn - 12.4 * Math.pow(fn, 2);
  if (cb >= 0.75 && cb < 0.8) return 2.4 - 10.6 * fn - 9.5 * Math.pow(fn, 2);
  if (cb >= 0.8 && cb < 0.85) return 2.6 - 13.1 * fn - 15.1 * Math.pow(fn, 2);
  if (cb >= 0.85 && cb < 0.9) return 3.1 - 18.7 * fn + 28 * Math.pow(fn, 2);
  return 0;
}

/**
 * Kwon weather direction reduction coefficient `C_β / 2` by encounter angle
 * (head 0–30°, bow 30–60°, beam 60–150°, following 150–180°) and Beaufort
 * number; `0` outside 0–180°.
 *
 * Port of `calculateWindCourseRedCoef`
 * (`be-legacy/src/utils/cii/second-formula/coefisien-reduction-calculation.ts`).
 *
 * @method weather.kwon_direction_coefficient
 * @see docs/METHODOLOGY.md#weather.kwon_direction_coefficient
 */
export function directionCoefficient(windCourse: WindCourse): number {
  const angle = windCourse.encounterAngleDeg;
  const bn = windCourse.beaufortNumber;
  if (angle >= 0 && angle <= 30) return 2 / 2;
  if (angle > 30 && angle <= 60) return (1.7 - 0.03 * Math.pow(bn - 4, 2)) / 2;
  if (angle > 60 && angle <= 150) return (0.9 - 0.06 * Math.pow(bn - 6, 2)) / 2;
  if (angle > 150 && angle <= 180)
    return (0.4 - 0.03 * Math.pow(bn - 8, 2)) / 2;
  return 0;
}

/**
 * Kwon ship form coefficient (legacy variant):
 * `C_Form = (0.7 · BN + BN^6.5) / (2.2 · Δ^(2/3))` with Δ the displacement, t.
 *
 * Port of `calculateShipShapeCoef`
 * (`be-legacy/src/utils/cii/second-formula/coefisien-reduction-calculation.ts`).
 *
 * @method weather.kwon_form_coefficient
 * @see docs/METHODOLOGY.md#weather.kwon_form_coefficient
 */
export function formCoefficient(
  windCourse: WindCourse,
  hull: HullForm,
): number {
  const displacement = displacementTonnes(hull);
  return (
    (0.7 * windCourse.beaufortNumber +
      Math.pow(windCourse.beaufortNumber, 6.5)) /
    (2.2 * Math.pow(displacement, 2 / 3))
  );
}

/**
 * Weather speed loss, percent: `ΔV/V = C_U · C_Form · C_β/2`.
 *
 * Port of `calculateCoefisienReduction`
 * (`be-legacy/src/utils/cii/second-formula/coefisien-reduction-calculation.ts`).
 *
 * @method weather.speed_loss_correction
 * @param speedMs AIS segment speed, m/s.
 * @see https://doi.org/10.1080/17445302.2007.11706015 (Kwon 2008)
 */
export function speedReductionPercent(
  windCourse: WindCourse,
  speedMs: number,
  hull: HullForm,
): number {
  return (
    speedCoefficient(hull, speedMs) *
    formCoefficient(windCourse, hull) *
    directionCoefficient(windCourse)
  );
}

/**
 * Calm-water-equivalent speed: `V_new = V / (1 − 0.01 · ΔV/V)` kn and its
 * value in m/s (× 0.5144).
 *
 * Port of `calculateNewSpeed`
 * (`be-legacy/src/utils/cii/second-formula/friction-resistance-calculation.ts`).
 *
 * @method weather.speed_loss_correction
 * @param speedKn AIS segment speed, kn.
 * @param reductionPercent weather speed loss, percent.
 */
export function calmWaterSpeed(
  speedKn: number,
  reductionPercent: number,
): Speed {
  const newSpeedKn = speedKn / (1 - 0.01 * reductionPercent);
  return { speedKn: newSpeedKn, speedMs: knotsToMs(newSpeedKn) };
}
