import type { FuelReadingRecordedV1 } from '@darmawanweb/ais-its-contracts/events';
import { InjectConfig } from '@darmawanweb/ais-its-nest';
import { type Database, InjectDb } from '@darmawanweb/ais-its-nest/db';
import { Injectable, Logger } from '@nestjs/common';

import type { Config } from '../../config.js';
import { lockVesselSegments } from '../../db/executor.js';
import type * as schema from '../../db/schema.js';
import { co2FromFuel } from '../../domain/cii.js';
import {
  isTelemetryActive,
  segmentFuelFromReadings,
} from '../../domain/fuel/telemetry.js';
import { AggregateRefresher } from './aggregate-refresher.service.js';
import { CiiPublicationRepository } from './cii-publication.repository.js';
import { FuelReadingsRepository } from './fuel-readings.repository.js';
import {
  SegmentsRepository,
  type TelemetryFuelUpdate,
} from './segments.repository.js';

/** What a fuel reading changed (`duplicate`: the reading was stored already). */
export interface ReadingOutcome {
  readonly kind: 'stored' | 'duplicate';
  /** Segments whose fuel was replaced by telemetry. */
  readonly reattributed: number;
}

/**
 * Stores telemetry readings and re-attributes the segments they concern:
 * readings usually arrive after the positions of the same period, so every
 * stored segment of the MMSI within TELEMETRY_ACTIVE_WINDOW_MIN of the
 * reading (or overlapping its period) is recomputed with the telemetry rule
 * (`segmentFuelFromReadings`) when telemetry is active for it, whatever
 * method it had.
 *
 * The reading is stored and the segments are updated in one transaction
 * under the vessel's advisory lock, which the segment builder also takes
 * while it reads the readings and writes a segment: whichever runs second
 * sees the other's write, so the result does not depend on the arrival order
 * of a position and a reading of the same window. A redelivered or duplicate
 * reading re-runs the (idempotent) attribution.
 *
 * @method telemetry.fuel_reading_usage
 */
@Injectable()
export class TelemetryAttributionService {
  private readonly logger = new Logger(TelemetryAttributionService.name);

  constructor(
    @InjectConfig() private readonly config: Config,
    @InjectDb() private readonly db: Database<typeof schema>,
    private readonly readings: FuelReadingsRepository,
    private readonly segments: SegmentsRepository,
    private readonly publication: CiiPublicationRepository,
    private readonly refresher: AggregateRefresher,
  ) {}

  async onReading(reading: FuelReadingRecordedV1): Promise<ReadingOutcome> {
    const toleranceMs = this.config.TELEMETRY_ACTIVE_WINDOW_MIN * 60_000;
    const maxPeriodMs = this.config.TELEMETRY_MAX_PERIOD_H * 3_600_000;
    const time = new Date(reading.time).getTime();
    const start =
      reading.periodStart === null
        ? time
        : new Date(reading.periodStart).getTime();
    if (time - start > maxPeriodMs) {
      this.logger.warn(
        {
          mmsi: reading.mmsi,
          time: reading.time,
          periodStart: reading.periodStart,
        },
        'fuel reading period exceeds TELEMETRY_MAX_PERIOD_H: segments built later in its period do not see it',
      );
    }
    const { stored, changed } = await this.db.transaction(async (tx) => {
      await lockVesselSegments(tx, reading.mmsi);
      const inserted = await this.readings.insert(reading, tx);
      const candidates = await this.segments.findOverlapping(
        reading.mmsi,
        new Date(Math.min(start, time) - toleranceMs),
        new Date(time + toleranceMs),
        this.config.SEGMENT_MAX_GAP_MIN * 60_000,
        tx,
      );
      const first = candidates[0];
      const last = candidates.at(-1);
      if (first === undefined || last === undefined)
        return { stored: inserted, changed: [] };
      // One read for every candidate: the telemetry rules ignore readings
      // that neither overlap a window nor lie within the tolerance of it.
      const nearby = await this.readings.findAround(
        reading.mmsi,
        first.timeStart,
        last.timeEnd,
        { toleranceMs, maxPeriodMs },
        tx,
      );
      const updates: TelemetryFuelUpdate[] = [];
      for (const segment of candidates) {
        const window = { start: segment.timeStart, end: segment.timeEnd };
        if (
          !isTelemetryActive(
            nearby,
            window,
            this.config.TELEMETRY_ACTIVE_WINDOW_MIN,
          )
        )
          continue;
        const fuel = segmentFuelFromReadings(nearby, window);
        const co2Ton = co2FromFuel(fuel.totalTon, segment.conversionFactor);
        if (
          segment.method === 'telemetry' &&
          segment.fuelMeTon === fuel.meTon &&
          segment.fuelAeTon === fuel.aeTon &&
          segment.co2Ton === co2Ton
        )
          continue;
        updates.push({
          timeStart: segment.timeStart,
          fuelMeTon: fuel.meTon,
          fuelAeTon: fuel.aeTon,
          co2Ton,
        });
      }
      await this.segments.applyTelemetryFuel(reading.mmsi, updates, tx);
      return { stored: inserted, changed: updates };
    });
    for (const update of changed) this.refresher.markChanged(update.timeStart);
    if (changed.length > 0) await this.publication.markDirty(reading.mmsi);
    return {
      kind: stored ? 'stored' : 'duplicate',
      reattributed: changed.length,
    };
  }
}
