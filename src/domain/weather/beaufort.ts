/**
 * Upper wind speed limits of Beaufort numbers 0–7, knots (WMO No. 558 scale
 * as used by the legacy; ≥ 33.4 kn is capped at 8).
 */
// SOURCE: thesis — needs citation (cap at Beaufort 8 for the Kwon method)
const BEAUFORT_UPPER_LIMITS_KN = [
  0.6, 3, 6.4, 10.6, 15.5, 21, 26.9, 33.4,
] as const;

/**
 * Beaufort number of a wind speed: the first class whose upper limit is not
 * exceeded (`≤ 0.6 → 0`, `≤ 3 → 1`, …, `≤ 33.4 → 7`), else 8.
 *
 * Port of `calculateBeafortNumber`
 * (`be-legacy/src/utils/cii/second-formula/course-calculation.ts`).
 *
 * @method weather.beaufort_number
 * @param windSpeedKn wind speed, knots (Open-Meteo `wind_speed_unit=kn`).
 * @see docs/METHODOLOGY.md#weather.beaufort_number
 * @see https://library.wmo.int/idurl/4/41650 (WMO No. 558)
 */
export function beaufortNumber(windSpeedKn: number): number {
  const index = BEAUFORT_UPPER_LIMITS_KN.findIndex(
    (limit) => windSpeedKn <= limit,
  );
  return index === -1 ? 8 : index;
}
