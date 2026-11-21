import type { RadianLocation } from '../segment.js';

/**
 * Rhumb-line bearing between two fixes, degrees (0–360), with the legacy
 * quadrant fix-up: `Δψ = ln(tan(φ₂/2 + π/4) / tan(φ₁/2 + π/4))`,
 * `θ = atan2(|λ₁ − λ₂|, Δψ)` in degrees, kept for `Δφ, Δλ` signs (+,+) and
 * (−,+), else `360 − θ`.
 *
 * The legacy passes `first = current`, `second = previous`, so the result is
 * the bearing from the current to the previous fix (the reciprocal of the
 * course made good) — kept for numerical parity (METHODOLOGY §19).
 *
 * Port of `calculateShipCourse`
 * (`be-legacy/src/utils/cii/second-formula/course-calculation.ts`).
 *
 * @method geo.rhumb_line_course
 * @param first the current fix in radians (legacy `firstPositionRad`).
 * @param second the previous fix in radians (legacy `secondPositionRad`).
 * @see docs/METHODOLOGY.md#geo.rhumb_line_course
 * @see https://www.movable-type.co.uk/scripts/latlong.html#rhumblines
 */
export function calculateShipCourse(first: RadianLocation, second: RadianLocation): number {
  const dLat = Math.log(
    Math.tan(second.lat / 2 + Math.PI / 4) / Math.tan(first.lat / 2 + Math.PI / 4),
  );
  const dLong = Math.abs(first.lon - second.lon);
  const bearing = Math.atan2(dLong, dLat);
  const degrees = (bearing * 180) / Math.PI;
  const deltaLat = second.lat - first.lat;
  const deltaLong = second.lon - first.lon;

  if (deltaLat > 0 && deltaLong > 0) return degrees;
  if (deltaLat < 0 && deltaLong > 0) return degrees;
  return 360 - degrees;
}
