import type { FuelReadingRecordedV1 } from '@darmawanweb/ais-its-contracts/events';
import { type Database, InjectDb } from '@darmawanweb/ais-its-nest/db';
import { Injectable } from '@nestjs/common';
import { and, asc, eq, gte, lte, sql } from 'drizzle-orm';

import * as schema from '../../db/schema.js';
import type { FuelReading } from '../../domain/fuel/telemetry.js';

const { fuelReadings } = schema;

/** Longest reading period considered when looking for overlapping readings, ms. */
export const MAX_READING_PERIOD_MS = 24 * 3_600_000;

/** Drizzle access to `fuel_readings` (telemetry received from the FUEL stream). */
@Injectable()
export class FuelReadingsRepository {
  constructor(@InjectDb() private readonly db: Database<typeof schema>) {}

  /** Stores a reading; `false` when `(mmsi, time)` is stored already (natural-key dedup). */
  async insert(reading: FuelReadingRecordedV1): Promise<boolean> {
    const rows = await this.db
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
   * Readings of a vessel that may matter for the window `(start, end]`: time
   * within `toleranceMs` of the window, or a period that overlaps it (periods
   * up to {@link MAX_READING_PERIOD_MS}).
   */
  async findAround(
    mmsi: number,
    start: Date,
    end: Date,
    toleranceMs: number,
  ): Promise<FuelReading[]> {
    const from = new Date(start.getTime() - toleranceMs);
    const to = new Date(end.getTime() + toleranceMs + MAX_READING_PERIOD_MS);
    const until = new Date(end.getTime() + toleranceMs);
    return this.db
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
