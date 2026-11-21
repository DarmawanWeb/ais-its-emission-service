import type { SegmentKinematics } from '../segment.js';
import { calculateShipCourse } from '../weather/course.js';
import { calculateWindCourse } from '../weather/encounter-angle.js';
import { calmWaterSpeed, speedReductionPercent } from '../weather/kwon.js';
import type { Wind, WindCourse } from '../weather/types.js';
import { APPENDAGE_FORM_FACTOR, appendageArea, appendageResistance } from './appendage.js';
import { frictionCoefficient, frictionResistance } from './friction.js';
import { froudeNumber, reynoldsNumber } from './numbers.js';
import { deliveredPower, effectivePower, mcrPower, shaftPower } from './power.js';
import { type TotalResistance, totalResistance } from './total.js';
import type { HullForm, Speed } from './types.js';

/** Friction-side terms at the calm-water-equivalent speed (legacy `IFrictionResistance`). */
export interface HoltropFriction {
  /** Calm-water-equivalent speed. */
  readonly newSpeed: Speed;
  /** Froude number at {@link newSpeed}. */
  readonly newFn: number;
  /** Sailing time of the segment at {@link newSpeed}, h (`distance / V_new`). */
  readonly newTimeHours: number;
  /** Reynolds number at {@link newSpeed}. */
  readonly reynolds: number;
  /** ITTC-1957 friction coefficient. */
  readonly cf: number;
  /** Appendage wetted area, m². */
  readonly appendageArea: number;
  /** Appendage form factor `1 + k₂`. */
  readonly onePlusK2: number;
  /** Appendage resistance, N. */
  readonly raap: number;
  /** Frictional resistance, N. */
  readonly rf: number;
}

/**
 * Friction-side terms of the Holtrop chain: calm-water-equivalent speed
 * (Kwon), `Fn`, sailing time, `Re`, `C_F`, appendage area and resistance,
 * frictional resistance.
 *
 * Port of `calculateFrictionResistance`
 * (`be-legacy/src/utils/cii/second-formula/friction-resistance-calculation.ts`).
 *
 * @method weather.speed_loss_correction
 * @method resistance.holtrop.reynolds_froude
 * @method resistance.holtrop.friction_line
 * @method resistance.holtrop.friction
 * @method resistance.holtrop.appendage
 * @param reductionPercent weather speed loss, percent.
 */
export function calculateFrictionResistance(
  kinematics: Pick<SegmentKinematics, 'speedKn' | 'distanceNm'>,
  reductionPercent: number,
  hull: HullForm,
): HoltropFriction {
  const newSpeed = calmWaterSpeed(kinematics.speedKn, reductionPercent);
  const newFn = froudeNumber(newSpeed.speedMs, hull.lwl);
  const newTimeHours = kinematics.distanceNm / newSpeed.speedKn;
  const reynolds = reynoldsNumber(hull.lwl, newSpeed.speedMs);
  const cf = frictionCoefficient(reynolds);
  const area = appendageArea(hull);
  return {
    newSpeed,
    newFn,
    newTimeHours,
    reynolds,
    cf,
    appendageArea: area,
    onePlusK2: APPENDAGE_FORM_FACTOR,
    raap: appendageResistance(newSpeed.speedMs, cf, area),
    rf: frictionResistance(cf, hull.b, hull.t, newSpeed.speedMs),
  };
}

/** Every intermediate of the Holtrop power chain of a segment. */
export interface HoltropChainResult {
  /** Legacy ship course (current → previous bearing), degrees. */
  readonly shipCourseDeg: number;
  readonly windCourse: WindCourse;
  /** Weather speed loss, percent. */
  readonly speedReductionPercent: number;
  readonly friction: HoltropFriction;
  readonly totalResistance: TotalResistance;
  /** Effective power, kW. */
  readonly effectivePowerKw: number;
  /** Delivered power, kW. */
  readonly deliveredPowerKw: number;
  /** Shaft power, kW. */
  readonly shaftPowerKw: number;
  /** Brake power at MCR, kW. */
  readonly bhpMcrKw: number;
}

/**
 * The Holtrop–Mennen / Kwon chain of a segment for a given wind: course and
 * wind course, speed loss, friction terms, total resistance and the power
 * chain `P_E → P_D → P_S → P_B,MCR`.
 *
 * Port of `perCalculateSecondFormulaFuel`
 * (`be-legacy/src/utils/cii/second-formula/index.ts`) without the weather
 * request (the caller supplies the wind; see the weather module).
 *
 * @method geo.rhumb_line_course
 * @method weather.encounter_angle
 * @method weather.speed_loss_correction
 * @method resistance.total_and_sea_margin
 * @method resistance.power.effective_power
 * @method resistance.power.propulsive_efficiency
 * @method resistance.power.transmission_mcr
 * @see docs/METHODOLOGY.md#7-konsumsi-bahan-bakar-emission
 */
export function holtropChain(kinematics: SegmentKinematics, wind: Wind, hull: HullForm): HoltropChainResult {
  const shipCourseDeg = calculateShipCourse(kinematics.currentRad, kinematics.previousRad);
  const windCourse = calculateWindCourse(shipCourseDeg, wind);
  const reduction = speedReductionPercent(windCourse, kinematics.speedMs, hull);
  const friction = calculateFrictionResistance(kinematics, reduction, hull);
  const total = totalResistance(hull, {
    rf: friction.rf,
    raap: friction.raap,
    newFn: friction.newFn,
    speedMs: friction.newSpeed.speedMs,
  });
  const effectivePowerKw = effectivePower(friction.newSpeed.speedMs, total.rtPlusSm);
  const deliveredPowerKw = deliveredPower(effectivePowerKw, hull);
  const shaftPowerKw = shaftPower(deliveredPowerKw);
  return {
    shipCourseDeg,
    windCourse,
    speedReductionPercent: reduction,
    friction,
    totalResistance: total,
    effectivePowerKw,
    deliveredPowerKw,
    shaftPowerKw,
    bhpMcrKw: mcrPower(shaftPowerKw),
  };
}
