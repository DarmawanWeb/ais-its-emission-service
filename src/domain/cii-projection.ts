/** Totals of a period that scale with time. */
export interface ScalableTotals {
  readonly distanceNm: number;
  readonly fuelMeTon: number;
  readonly fuelAeTon: number;
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
 * the time of the last segment. Ratios such as the attained CII are not
 * changed by this scaling; see {@link projectCumulativeAttained}.
 *
 * @method cii.year_end_projection
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

/** A daily point of the cumulative (year-to-date) attained CII. */
export interface CumulativePoint {
  /** Day (UTC midnight). */
  readonly day: Date;
  /** Year-to-date attained CII at the end of the day. */
  readonly cumulativeAttained: number;
}

/**
 * Year-end attained CII from the least-squares line through the daily
 * cumulative attained values (`y = α + β·x`, x = day index), evaluated on
 * 31 December; the last value when fewer than two days exist. Clamped at 0.
 *
 * @method cii.year_end_projection
 * @param year calendar year of the points.
 */
export function projectCumulativeAttained(
  points: readonly CumulativePoint[],
  year: number,
): number | null {
  const valid = points.filter((point) =>
    Number.isFinite(point.cumulativeAttained),
  );
  const last = valid.at(-1);
  if (last === undefined) return null;
  if (valid.length < 2) return last.cumulativeAttained;
  const dayMs = 86_400_000;
  const origin = Date.UTC(year, 0, 1);
  const xs = valid.map((point) => (point.day.getTime() - origin) / dayMs);
  const ys = valid.map((point) => point.cumulativeAttained);
  const n = valid.length;
  const meanX = xs.reduce((sum, x) => sum + x, 0) / n;
  const meanY = ys.reduce((sum, y) => sum + y, 0) / n;
  let sxx = 0;
  let sxy = 0;
  xs.forEach((x, index) => {
    const y = ys[index] ?? meanY;
    sxx += (x - meanX) ** 2;
    sxy += (x - meanX) * (y - meanY);
  });
  if (sxx === 0) return last.cumulativeAttained;
  const slope = sxy / sxx;
  const yearEnd = (Date.UTC(year, 11, 31) - origin) / dayMs;
  return Math.max(meanY + slope * (yearEnd - meanX), 0);
}
