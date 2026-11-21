import {
  type Database,
  InjectDb,
  InjectPool,
  type Pool,
} from '@darmawanweb/ais-its-nest/db';
import { Injectable } from '@nestjs/common';
import { and, desc, eq, gte, lt, lte, ne, not, sql } from 'drizzle-orm';

import * as schema from '../../db/schema.js';

const { segments } = schema;

/** A stored segment. */
export type SegmentRow = typeof segments.$inferSelect;
/** A segment to store (`computed_at` defaults to now). */
export type NewSegment = Omit<typeof segments.$inferInsert, 'computedAt'>;

/** Telemetry fuel replacing the fuel of a stored segment. */
export interface TelemetryFuelUpdate {
  readonly mmsi: number;
  readonly timeStart: Date;
  readonly fuelMeTon: number;
  readonly fuelAeTon: number;
  readonly co2Ton: number;
  readonly flags: readonly string[];
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

/** Access to the `segments` hypertable. */
@Injectable()
export class SegmentsRepository {
  constructor(
    @InjectDb() private readonly db: Database<typeof schema>,
    @InjectPool() private readonly pool: Pool,
  ) {}

  /** Stores a segment; `false` when `(mmsi, time_start)` exists (idempotent consumer). */
  async insert(segment: NewSegment): Promise<boolean> {
    const rows = await this.db
      .insert(segments)
      .values(segment)
      .onConflictDoNothing({ target: [segments.mmsi, segments.timeStart] })
      .returning({ timeStart: segments.timeStart });
    return rows.length > 0;
  }

  /** Stores or replaces a segment (recomputation). */
  async upsert(segment: NewSegment): Promise<void> {
    await this.db
      .insert(segments)
      .values(segment)
      .onConflictDoUpdate({
        target: [segments.mmsi, segments.timeStart],
        set: {
          timeEnd: sql`excluded.time_end`,
          vesselId: sql`excluded.vessel_id`,
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
      });
  }

  /**
   * Deletes the segments of a vessel starting in `[from, to)` except those
   * starting at one of `keep` (the segments a recomputation rebuilt); returns
   * how many were deleted.
   */
  async deleteRangeExcept(
    mmsi: number,
    from: Date,
    to: Date,
    keep: readonly Date[],
  ): Promise<number> {
    const result = await this.pool.query(
      `DELETE FROM segments
        WHERE mmsi = $1 AND time_start >= $2 AND time_start < $3
          AND NOT (time_start = ANY($4::timestamptz[]))`,
      [mmsi, from, to, keep.map((time) => time.toISOString())],
    );
    return result.rowCount ?? 0;
  }

  /** Segments of a vessel whose window intersects `[from, to]`, gaps excluded. */
  async findOverlapping(
    mmsi: number,
    from: Date,
    to: Date,
  ): Promise<SegmentRow[]> {
    return this.db
      .select()
      .from(segments)
      .where(
        and(
          eq(segments.mmsi, mmsi),
          lte(segments.timeStart, to),
          gte(segments.timeEnd, from),
          not(sql`'gap' = ANY(${segments.flags})`),
        ),
      )
      .orderBy(segments.timeStart);
  }

  /** Replaces the fuel of a segment with telemetry. */
  async updateTelemetryFuel(update: TelemetryFuelUpdate): Promise<void> {
    await this.db
      .update(segments)
      .set({
        method: 'telemetry',
        fuelMeTon: update.fuelMeTon,
        fuelAeTon: update.fuelAeTon,
        co2Ton: update.co2Ton,
        weather: null,
        flags: [...update.flags],
        computedAt: sql`now()`,
      })
      .where(
        and(
          eq(segments.mmsi, update.mmsi),
          eq(segments.timeStart, update.timeStart),
        ),
      );
  }

  /** One page of a vessel's segments in `[from, to)`, newest first, older than `before`. */
  async page(
    mmsi: number,
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
          eq(segments.mmsi, mmsi),
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
  async latestCounted(mmsi: number): Promise<LatestSegment | undefined> {
    const [row] = await this.db
      .select({
        timeStart: segments.timeStart,
        timeEnd: segments.timeEnd,
        method: segments.method,
      })
      .from(segments)
      .where(and(eq(segments.mmsi, mmsi), ne(segments.method, 'none')))
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
    mmsi: number,
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
        WHERE mmsi = $1 AND time_start >= $2 AND time_start < $3 AND method <> 'none'
        GROUP BY fuel_code
        ORDER BY fuel_code`,
      [mmsi, from, to, underWayMinSpeedKn],
    );
    return result.rows;
  }
}
