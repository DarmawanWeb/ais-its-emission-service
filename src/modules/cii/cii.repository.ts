import { InjectPool, type Pool } from '@darmawanweb/ais-its-nest/db';
import { Injectable } from '@nestjs/common';

/** Sums of the counted segments of a period (from the continuous aggregates). */
export interface PeriodTotals {
  readonly distanceNm: number;
  readonly fuelMeTon: number;
  readonly fuelAeTon: number;
  readonly co2Ton: number;
  readonly segments: number;
  readonly telemetrySegments: number;
  readonly firstFormulaSegments: number;
  readonly holtropSegments: number;
  readonly excludedSegments: number;
  /** End of the last counted segment, `null` when none. */
  readonly lastTime: Date | null;
}

/** Totals of a vessel-year (`cii_annual`). */
export interface YearTotals extends PeriodTotals {
  readonly vesselId: string;
  readonly year: number;
}

/** Totals of a vessel-day (`cii_daily`) with the year-to-date sums at its end. */
export interface DayTotals extends PeriodTotals {
  readonly day: Date;
  readonly ytdDistanceNm: number;
  readonly ytdFuelMeTon: number;
  readonly ytdFuelAeTon: number;
  readonly ytdCo2Ton: number;
}

const TOTALS = `
  distance_nm::double precision AS "distanceNm",
  fuel_me_ton::double precision AS "fuelMeTon",
  fuel_ae_ton::double precision AS "fuelAeTon",
  co2_ton::double precision AS "co2Ton",
  segments::int AS "segments",
  telemetry_segments::int AS "telemetrySegments",
  first_formula_segments::int AS "firstFormulaSegments",
  holtrop_segments::int AS "holtropSegments",
  excluded_segments::int AS "excludedSegments",
  last_time AS "lastTime"`;

/**
 * Reads of the continuous aggregates `cii_daily` and `cii_annual` per vessel
 * (`vessel_id`, not MMSI: a re-used MMSI never exposes the previous vessel's
 * CII, spec §8.5); real-time: rows after the last refresh come from `segments`.
 */
@Injectable()
export class CiiRepository {
  constructor(@InjectPool() private readonly pool: Pool) {}

  /** Totals of a vessel-year, `undefined` without counted segments. */
  async yearTotals(
    vesselId: string,
    year: number,
  ): Promise<YearTotals | undefined> {
    const rows = await this.years([vesselId], year);
    return rows[0];
  }

  /** Every year with segments of a vessel. */
  async allYears(vesselId: string): Promise<YearTotals[]> {
    const result = await this.pool.query<YearTotals>(
      `SELECT vessel_id AS "vesselId", extract(year FROM year AT TIME ZONE 'UTC')::int AS "year", ${TOTALS}
         FROM cii_annual WHERE vessel_id = $1 AND segments > 0 ORDER BY year`,
      [vesselId],
    );
    return result.rows;
  }

  /** Totals of several vessels for one year. */
  async years(
    vesselIds: readonly string[],
    year: number,
  ): Promise<YearTotals[]> {
    if (vesselIds.length === 0) return [];
    const result = await this.pool.query<YearTotals>(
      `SELECT vessel_id AS "vesselId", extract(year FROM year AT TIME ZONE 'UTC')::int AS "year", ${TOTALS}
         FROM cii_annual
        WHERE vessel_id = ANY($1::uuid[]) AND year = $2 AND segments > 0`,
      [[...vesselIds], new Date(Date.UTC(year, 0, 1))],
    );
    return result.rows;
  }

  /**
   * Totals of the counted segments of several vessels over the UTC days in
   * `[from, to)` (`cii_daily`; e.g. a calendar month), one row per vessel
   * with counted segments.
   */
  async periodTotals(
    vesselIds: readonly string[],
    from: Date,
    to: Date,
  ): Promise<(PeriodTotals & { readonly vesselId: string })[]> {
    if (vesselIds.length === 0) return [];
    const result = await this.pool.query<
      PeriodTotals & { readonly vesselId: string }
    >(
      `SELECT vessel_id AS "vesselId",
              sum(distance_nm)::double precision AS "distanceNm",
              sum(fuel_me_ton)::double precision AS "fuelMeTon",
              sum(fuel_ae_ton)::double precision AS "fuelAeTon",
              sum(co2_ton)::double precision AS "co2Ton",
              sum(segments)::int AS "segments",
              sum(telemetry_segments)::int AS "telemetrySegments",
              sum(first_formula_segments)::int AS "firstFormulaSegments",
              sum(holtrop_segments)::int AS "holtropSegments",
              sum(excluded_segments)::int AS "excludedSegments",
              max(last_time) AS "lastTime"
         FROM cii_daily
        WHERE vessel_id = ANY($1::uuid[]) AND day >= $2 AND day < $3
        GROUP BY vessel_id
       HAVING sum(segments) > 0`,
      [[...vesselIds], from, to],
    );
    return result.rows;
  }

  /**
   * Daily totals of a vessel for days in `[from, to)` with year-to-date sums
   * (the sums restart on 1 January, UTC).
   */
  async days(vesselId: string, from: Date, to: Date): Promise<DayTotals[]> {
    const yearStart = new Date(Date.UTC(from.getUTCFullYear(), 0, 1));
    const result = await this.pool.query<DayTotals>(
      `WITH daily AS (
         SELECT day, ${TOTALS},
                sum(distance_nm) OVER ytd AS ytd_distance_nm,
                sum(fuel_me_ton) OVER ytd AS ytd_fuel_me_ton,
                sum(fuel_ae_ton) OVER ytd AS ytd_fuel_ae_ton,
                sum(co2_ton) OVER ytd AS ytd_co2_ton
           FROM cii_daily
          WHERE vessel_id = $1 AND day >= $2 AND day < $4
         WINDOW ytd AS (PARTITION BY extract(year FROM day AT TIME ZONE 'UTC') ORDER BY day))
       SELECT day, "distanceNm", "fuelMeTon", "fuelAeTon", "co2Ton", "segments", "telemetrySegments",
              "firstFormulaSegments", "holtropSegments", "excludedSegments", "lastTime",
              ytd_distance_nm::double precision AS "ytdDistanceNm",
              ytd_fuel_me_ton::double precision AS "ytdFuelMeTon",
              ytd_fuel_ae_ton::double precision AS "ytdFuelAeTon",
              ytd_co2_ton::double precision AS "ytdCo2Ton"
         FROM daily WHERE day >= $3 ORDER BY day`,
      [
        vesselId,
        yearStart,
        new Date(
          Date.UTC(
            from.getUTCFullYear(),
            from.getUTCMonth(),
            from.getUTCDate(),
          ),
        ),
        to,
      ],
    );
    return result.rows;
  }
}
