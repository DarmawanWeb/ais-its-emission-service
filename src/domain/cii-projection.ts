import { attainedCii } from './cii.js';

/** Totals of a period that scale with time. */
export interface ScalableTotals {
  /** Distance sailed, nm. */
  readonly distanceNm: number;
  /** Main engine fuel, t. */
  readonly fuelMeTon: number;
  /** Auxiliary engine fuel, t. */
  readonly fuelAeTon: number;
  /** CO2, t. */
  readonly co2Ton: number;
}

/** Fraction of the calendar year `year` (UTC) elapsed at `asOf`, in (0, 1]. */
export function elapsedYearFraction(year: number, asOf: Date): number {
  const start = Date.UTC(year, 0, 1);
  const end = Date.UTC(year + 1, 0, 1);
  const clamped = Math.min(Math.max(asOf.getTime(), start), end);
  return Math.max(clamped - start, 1) / (end - start);
}

/**
 * Linear year-end projection of year-to-date totals:
 * `X_year = X_YTD / f` with `f` the elapsed fraction of the calendar year at
 * the time of the last segment (the vessel keeps operating at its
 * year-to-date rate until 31 December).
 *
 * @method cii.year_end_projection
 * @param fraction elapsed fraction of the year, in (0, 1] ({@link elapsedYearFraction}).
 */
export function projectTotals(
  totals: ScalableTotals,
  fraction: number,
): ScalableTotals {
  return {
    distanceNm: totals.distanceNm / fraction,
    fuelMeTon: totals.fuelMeTon / fraction,
    fuelAeTon: totals.fuelAeTon / fraction,
    co2Ton: totals.co2Ton / fraction,
  };
}

/** The year-end projection of a year in progress. */
export interface YearEndProjection {
  /** Projected totals of the whole calendar year. */
  readonly totals: ScalableTotals;
  /** Attained CII of the projected totals, g CO2 / (capacity · nm). */
  readonly attained: number;
}

/**
 * Year-end projection of a year in progress: the totals projected linearly
 * ({@link projectTotals}) and the attained CII they give,
 * `CII_year = CO2_year · 10⁶ / (Capacity · D_year)`.
 *
 * CO2 and distance both scale by `1 / f`, so the projected attained CII — and
 * the rating and grade derived from it — equal the year-to-date values: the
 * linear model projects the annual totals, not a change of carbon intensity.
 * The trend of the daily cumulative (year-to-date) CII is deliberately not
 * extrapolated: that ratio converges over the year and is not linear in time,
 * so extending a short slope to 31 December diverges (to 0, or to many times
 * the year-to-date value).
 *
 * @method cii.year_end_projection
 * @method cii.attained_accumulation
 * @param ytd year-to-date totals (distance nm, fuel and CO2 t).
 * @param fraction elapsed fraction of the year, in (0, 1].
 * @param capacity CII capacity (DWT or GT).
 */
export function projectYearEnd(
  ytd: ScalableTotals,
  fraction: number,
  capacity: number,
): YearEndProjection {
  const totals = projectTotals(ytd, fraction);
  return {
    totals,
    attained: attainedCii(totals.co2Ton, totals.distanceNm, capacity),
  };
}
