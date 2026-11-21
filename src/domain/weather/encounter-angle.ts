import { beaufortNumber } from './beaufort.js';
import type { Wind, WindCourse } from './types.js';

/**
 * Encounter angle between the ship course and the wind direction, degrees
 * (0–180), with the legacy branch chain (equal or non-finite inputs → 0).
 *
 * Port of `calculateEncountedAngle`
 * (`be-legacy/src/utils/cii/second-formula/course-calculation.ts`); the
 * explicit chain is kept on purpose (its branches overlap).
 *
 * @method weather.encounter_angle
 * @param shipCourse ship course, degrees (see `calculateShipCourse`).
 * @param windCourse wind direction, degrees.
 * @see docs/METHODOLOGY.md#weather.encounter_angle
 */
export function calculateEncounterAngle(shipCourse: number, windCourse: number): number {
  if (shipCourse <= windCourse && windCourse > shipCourse && windCourse - shipCourse <= 180) {
    return windCourse - shipCourse;
  } else if (shipCourse <= windCourse && windCourse > shipCourse && windCourse - shipCourse > 180) {
    return 360 - windCourse + shipCourse;
  } else if (shipCourse <= 180 && windCourse < shipCourse) {
    return shipCourse - windCourse;
  } else if (shipCourse > 180 && windCourse < shipCourse && shipCourse - windCourse <= 180) {
    return shipCourse - windCourse;
  } else if (shipCourse > 180 && windCourse < shipCourse && shipCourse - windCourse > 180) {
    return 360 - shipCourse + windCourse;
  } else if (shipCourse > 180 && windCourse > shipCourse) {
    return windCourse - shipCourse;
  }
  return 0;
}

/**
 * Beaufort number and encounter angle of the wind for a ship course.
 *
 * Port of `calculateWindCourse`
 * (`be-legacy/src/utils/cii/second-formula/course-calculation.ts`).
 *
 * @method weather.beaufort_number
 * @method weather.encounter_angle
 */
export function calculateWindCourse(shipCourse: number, wind: Wind): WindCourse {
  return {
    beaufortNumber: beaufortNumber(wind.speedKn),
    encounterAngleDeg: calculateEncounterAngle(shipCourse, wind.directionDeg),
  };
}
