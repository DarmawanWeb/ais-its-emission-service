import type { FuelReadingRecordedV1 } from '@darmawanweb/ais-its-contracts/events';
import { type Database, InjectDb } from '@darmawanweb/ais-its-nest/db';
import { Injectable } from '@nestjs/common';
import { and, asc, eq, gte, lte, sql } from 'drizzle-orm';

import type { Executor } from '../../db/executor.js';
import * as schema from '../../db/schema.js';
import type { FuelReading } from '../../domain/fuel/telemetry.js';

const { fuelReadings } = schema;

/** How far around a window readings matter. */
export interface ReadingSearch {
  /** TELEMETRY_ACTIVE_WINDOW_MIN in ms: instantaneous readings this close to the window count. */
  readonly toleranceMs: number;
  /**
   * TELEMETRY_MAX_PERIOD_H in ms: the longest measured period of a reading
   * (`time − periodStart`). A period reading ends at most this long after
   * the start of a window it overlaps, which bounds the scan of the
   * `fuel_readings` hypertable by `time`.
   */
  readonly maxPeriodMs: number;
}

/** Drizzle access to `fuel_readings` (telemetry received from the FUEL stream). */
@Injectable()
export class FuelReadingsRepository {
  constructor(@InjectDb() private readonly db: Database<typeof schema>) {}

  /** Stores a reading; `false` when `(mmsi, time)` is stored already (natural-key dedup). */
  async insert(
    reading: FuelReadingRecordedV1,
    executor: Executor = this.db,
  ): Promise<boolean> {
    const rows = await executor
      .insert(fuelReadings)
      .values({
        time: new Date(reading.time),
        mmsi: reading.mmsi,
        periodStart:
          reading.periodStart === null ? null : new Date(reading.periodStart),
        fuelMeTon: reading.fuelMeTon,
        fuelAeTon: reading.fuelAeTon,
        deviceId: reading.deviceId,
        source: reading.source,
      })
      .onConflictDoNothing({ target: [fuelReadings.mmsi, fuelReadings.time] })
      .returning({ time: fuelReadings.time });
    return rows.length > 0;
  }

  /**
   * Readings of a vessel that may matter for the window `(start, end]`: an
   * instantaneous reading within `toleranceMs` of the window, or a period
   * `[periodStart, time]` that overlaps the window widened by `toleranceMs`
   * (`time ≥ start − tol` and `periodStart ≤ end + tol`, with
   * `time ≤ end + tol + maxPeriodMs` as the scan bound). The rules of
   * `domain/fuel/telemetry.ts` pick from these; a superset is harmless.
   */
  async findAround(
    mmsi: number,
    start: Date,
    end: Date,
    search: ReadingSearch,
    executor: Executor = this.db,
  ): Promise<FuelReading[]> {
    const from = new Date(start.getTime() - search.toleranceMs);
    const until = new Date(end.getTime() + search.toleranceMs);
    const to = new Date(until.getTime() + search.maxPeriodMs);
    return executor
      .select({
        time: fuelReadings.time,
        periodStart: fuelReadings.periodStart,
        fuelMeTon: fuelReadings.fuelMeTon,
        fuelAeTon: fuelReadings.fuelAeTon,
      })
      .from(fuelReadings)
      .where(
        and(
          eq(fuelReadings.mmsi, mmsi),
          gte(fuelReadings.time, from),
          lte(fuelReadings.time, to),
          lte(
            sql`coalesce(${fuelReadings.periodStart}, ${fuelReadings.time})`,
            until,
          ),
        ),
      )
      .orderBy(asc(fuelReadings.time));
  }
}
