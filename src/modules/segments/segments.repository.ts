import {
  type Database,
  InjectDb,
  InjectPool,
  type Pool,
} from '@darmawanweb/ais-its-nest/db';
import { Injectable } from '@nestjs/common';
import { and, desc, eq, gte, lt, lte, ne, not, sql } from 'drizzle-orm';

import type { Executor } from '../../db/executor.js';
import * as schema from '../../db/schema.js';

const { segments } = schema;

/** A stored segment. */
export type SegmentRow = typeof segments.$inferSelect;
/** A segment to store (`computed_at` defaults to now). */
export type NewSegment = Omit<typeof segments.$inferInsert, 'computedAt'>;

/** Telemetry fuel replacing the fuel of one stored segment. */
export interface TelemetryFuelUpdate {
  readonly timeStart: Date;
  readonly fuelMeTon: number;
  readonly fuelAeTon: number;
  readonly co2Ton: number;
}

/** Totals of a vessel-year per fuel (DCS). */
export interface FuelTotalsRow {
  readonly fuelCode: string;
  readonly conversionFactor: number;
  readonly fuelMeTon: number;
  readonly fuelAeTon: number;
  readonly co2Ton: number;
  readonly distanceNm: number;
  readonly hours: number;
  readonly hoursUnderWay: number;
  readonly segments: number;
}

/** The most recent counted segment of a vessel. */
export interface LatestSegment {
  readonly timeStart: Date;
  readonly timeEnd: Date;
  readonly method: 'telemetry' | 'first_formula' | 'holtrop';
}

/** Segments of one vessel under one MMSI starting in `[from, to]`, computed before `computedBefore`. */
export interface StaleSegmentsRange {
  readonly mmsi: number;
  readonly vesselId: string;
  readonly from: Date;
  /** Inclusive. */
  readonly to: Date;
  readonly computedBefore: Date;
}

/**
 * Flags of a fuel model that telemetry replaces (dropped when a segment is
 * re-attributed, together with an earlier `telemetry_reattributed`).
 */
export const MODEL_FLAGS: readonly string[] = [
  'no_fuel_model',
  'formula_error',
  'weather_unavailable',
  'fuel_not_finite',
  'fuel_negative',
  'telemetry_reattributed',
];

/**
 * Access to the `segments` hypertable. A segment is identified by
 * `(mmsi, time_start)`; the history of a vessel is read by `vessel_id`
 * (spec §8.5: a re-used MMSI never exposes the previous vessel's segments,
 * and a vessel keeps its history when its MMSI changes).
 */
@Injectable()
export class SegmentsRepository {
  constructor(
    @InjectDb() private readonly db: Database<typeof schema>,
    @InjectPool() private readonly pool: Pool,
  ) {}

  /** Stores a segment; `false` when `(mmsi, time_start)` exists (idempotent consumer). */
  async insert(
    segment: NewSegment,
    executor: Executor = this.db,
  ): Promise<boolean> {
    const rows = await executor
      .insert(segments)
      .values(segment)
      .onConflictDoNothing({ target: [segments.mmsi, segments.timeStart] })
      .returning({ timeStart: segments.timeStart });
    return rows.length > 0;
  }

  /**
   * Stores or replaces a segment (recomputation); `false` when
   * `(mmsi, time_start)` belongs to another vessel (the previous holder of a
   * re-assigned MMSI), whose row is left untouched.
   */
  async upsert(
    segment: NewSegment,
    executor: Executor = this.db,
  ): Promise<boolean> {
    const rows = await executor
      .insert(segments)
      .values(segment)
      .onConflictDoUpdate({
        target: [segments.mmsi, segments.timeStart],
        set: {
          timeEnd: sql`excluded.time_end`,
          distanceNm: sql`excluded.distance_nm`,
          speedKn: sql`excluded.speed_kn`,
          fuelMeTon: sql`excluded.fuel_me_ton`,
          fuelAeTon: sql`excluded.fuel_ae_ton`,
          co2Ton: sql`excluded.co2_ton`,
          method: sql`excluded.method`,
          navstatus: sql`excluded.navstatus`,
          fuelCode: sql`excluded.fuel_code`,
          conversionFactor: sql`excluded.conversion_factor`,
          weather: sql`excluded.weather`,
          flags: sql`excluded.flags`,
          computedAt: sql`now()`,
        },
        // `segments` is the existing row of the conflict, `excluded` the proposed one.
        setWhere: sql`segments.vessel_id = excluded.vessel_id`,
      })
      .returning({ timeStart: segments.timeStart });
    return rows.length > 0;
  }

  /**
   * Deletes the segments of a recomputed range that the replay did not
   * produce again: rows of the vessel under the replayed MMSI starting in
   * `[from, to]` and computed before the job started. Rebuilt rows, live
   * inserts and telemetry re-attributions during the job carry a later
   * `computed_at` and are kept. Returns how many rows were deleted.
   */
  async deleteStale(
    range: StaleSegmentsRange,
    executor: Executor = this.db,
  ): Promise<number> {
    const rows = await executor
      .delete(segments)
      .where(staleCondition(range))
      .returning({ timeStart: segments.timeStart });
    return rows.length;
  }

  /** Number of segments matching {@link deleteStale}'s condition. */
  async countStale(range: StaleSegmentsRange): Promise<number> {
    const [row] = await this.db
      .select({ count: sql<number>`count(*)::int` })
      .from(segments)
      .where(staleCondition(range));
    return row?.count ?? 0;
  }

  /**
   * The query of {@link findOverlapping}: segments stored under an MMSI whose
   * window intersects `[from, to]`, gaps excluded, oldest first. Segments are
   * never longer than `maxSegmentMs` (SEGMENT_MAX_GAP_MIN: longer windows are
   * gaps), so `time_start ≥ from − maxSegmentMs` bounds the scan to the
   * hypertable chunks of the window instead of the vessel's whole history.
   */
  overlappingQuery(
    mmsi: number,
    from: Date,
    to: Date,
    maxSegmentMs: number,
    executor: Executor = this.db,
  ) {
    return executor
      .select()
      .from(segments)
      .where(
        and(
          eq(segments.mmsi, mmsi),
          gte(segments.timeStart, new Date(from.getTime() - maxSegmentMs)),
          lte(segments.timeStart, to),
          gte(segments.timeEnd, from),
          not(sql`'gap' = ANY(${segments.flags})`),
        ),
      )
      .orderBy(segments.timeStart);
  }

  /** Segments stored under an MMSI whose window intersects `[from, to]` (see {@link overlappingQuery}). */
  async findOverlapping(
    mmsi: number,
    from: Date,
    to: Date,
    maxSegmentMs: number,
    executor: Executor = this.db,
  ): Promise<SegmentRow[]> {
    return this.overlappingQuery(mmsi, from, to, maxSegmentMs, executor);
  }

  /**
   * Replaces the fuel of segments stored under an MMSI with telemetry, in one
   * statement: method `telemetry`, no weather, the model flags dropped and
   * `telemetry_reattributed` added.
   */
  async applyTelemetryFuel(
    mmsi: number,
    updates: readonly TelemetryFuelUpdate[],
    executor: Executor = this.db,
  ): Promise<number> {
    if (updates.length === 0) return 0;
    const starts = updates.map((update) => update.timeStart.getTime());
    const result = await executor.execute(sql`
      UPDATE ${segments} AS s
         SET method = 'telemetry',
             fuel_me_ton = u.fuel_me_ton,
             fuel_ae_ton = u.fuel_ae_ton,
             co2_ton = u.co2_ton,
             weather = NULL,
             flags = array_append(
               ARRAY(SELECT f FROM unnest(s.flags) AS f WHERE NOT (f = ANY(${toTextArray(MODEL_FLAGS)}))),
               'telemetry_reattributed'),
             computed_at = now()
        FROM unnest(
               ${toTimestampArray(updates.map((update) => update.timeStart))},
               ${toFloatArray(updates.map((update) => update.fuelMeTon))},
               ${toFloatArray(updates.map((update) => update.fuelAeTon))},
               ${toFloatArray(updates.map((update) => update.co2Ton))}
             ) AS u(time_start, fuel_me_ton, fuel_ae_ton, co2_ton)
       WHERE s.mmsi = ${mmsi}
         AND s.time_start = u.time_start
         AND s.time_start >= ${new Date(Math.min(...starts))}
         AND s.time_start <= ${new Date(Math.max(...starts))}`);
    return result.rowCount ?? 0;
  }

  /** One page of a vessel's segments in `[from, to)`, newest first, older than `before`. */
  async page(
    vesselId: string,
    from: Date,
    to: Date,
    before: Date | undefined,
    limit: number,
  ): Promise<SegmentRow[]> {
    return this.db
      .select()
      .from(segments)
      .where(
        and(
          eq(segments.vesselId, vesselId),
          gte(segments.timeStart, from),
          lt(
            segments.timeStart,
            before === undefined
              ? to
              : new Date(Math.min(before.getTime(), to.getTime())),
          ),
        ),
      )
      .orderBy(desc(segments.timeStart))
      .limit(limit);
  }

  /** The most recent counted segment of a vessel, if any. */
  async latestCounted(vesselId: string): Promise<LatestSegment | undefined> {
    const [row] = await this.db
      .select({
        timeStart: segments.timeStart,
        timeEnd: segments.timeEnd,
        method: segments.method,
      })
      .from(segments)
      .where(and(eq(segments.vesselId, vesselId), ne(segments.method, 'none')))
      .orderBy(desc(segments.timeStart))
      .limit(1);
    if (row === undefined || row.method === 'none') return undefined;
    return {
      timeStart: row.timeStart,
      timeEnd: row.timeEnd,
      method: row.method,
    };
  }

  /**
   * Totals of the counted segments of a vessel starting in `[from, to)` per
   * fuel, with the hours under way (segments at ≥ `underWayMinSpeedKn`).
   */
  async fuelTotals(
    vesselId: string,
    from: Date,
    to: Date,
    underWayMinSpeedKn: number,
  ): Promise<FuelTotalsRow[]> {
    const result = await this.pool.query<FuelTotalsRow>(
      `SELECT fuel_code AS "fuelCode",
              max(conversion_factor)::double precision AS "conversionFactor",
              sum(fuel_me_ton)::double precision AS "fuelMeTon",
              sum(fuel_ae_ton)::double precision AS "fuelAeTon",
              sum(co2_ton)::double precision AS "co2Ton",
              sum(distance_nm)::double precision AS "distanceNm",
              (sum(extract(epoch FROM time_end - time_start)) / 3600)::double precision AS "hours",
              coalesce(sum(extract(epoch FROM time_end - time_start)) FILTER (WHERE speed_kn >= $4) / 3600, 0)::double precision AS "hoursUnderWay",
              count(*)::int AS "segments"
         FROM segments
        WHERE vessel_id = $1 AND time_start >= $2 AND time_start < $3 AND method <> 'none'
        GROUP BY fuel_code
        ORDER BY fuel_code`,
      [vesselId, from, to, underWayMinSpeedKn],
    );
    return result.rows;
  }
}

function staleCondition(range: StaleSegmentsRange) {
  return and(
    eq(segments.mmsi, range.mmsi),
    eq(segments.vesselId, range.vesselId),
    gte(segments.timeStart, range.from),
    lte(segments.timeStart, range.to),
    lt(segments.computedAt, range.computedBefore),
  );
}

const toTextArray = (values: readonly string[]) =>
  sql`${`{${values.map((value) => `"${value}"`).join(',')}}`}::text[]`;

const toTimestampArray = (values: readonly Date[]) =>
  sql`${`{${values.map((value) => `"${value.toISOString()}"`).join(',')}}`}::timestamptz[]`;

const toFloatArray = (values: readonly number[]) =>
  sql`${`{${values.map((value) => String(value)).join(',')}}`}::double precision[]`;
