import type { FuelReadingRecordedV1 } from '@darmawanweb/ais-its-contracts/events';
import { InjectConfig } from '@darmawanweb/ais-its-nest';
import { Injectable } from '@nestjs/common';

import type { Config } from '../../config.js';
import { co2FromFuel } from '../../domain/cii.js';
import {
  isTelemetryActive,
  segmentFuelFromReadings,
} from '../../domain/fuel/telemetry.js';
import type { SegmentFlag } from '../../domain/segment-fuel.js';
import { AggregateRefresher } from './aggregate-refresher.service.js';
import { CiiPublicationRepository } from './cii-publication.repository.js';
import { FuelReadingsRepository } from './fuel-readings.repository.js';
import { SegmentsRepository } from './segments.repository.js';

/** Flags that describe a fuel model replaced by telemetry. */
const MODEL_FLAGS = new Set<string>([
  'no_fuel_model',
  'formula_error',
  'weather_unavailable',
  'fuel_not_finite',
  'fuel_negative',
]);

/** What a fuel reading changed (`duplicate`: the reading was stored already). */
export interface ReadingOutcome {
  readonly kind: 'stored' | 'duplicate';
  /** Segments whose fuel was replaced by telemetry. */
  readonly reattributed: number;
}

/**
 * Stores telemetry readings and re-attributes the segments they concern:
 * readings usually arrive after the positions of the same period, so every
 * stored segment of the vessel within TELEMETRY_ACTIVE_WINDOW_MIN of the
 * reading (or overlapping its period) is recomputed with the telemetry rule
 * (`segmentFuelFromReadings`) when telemetry is active for it, whatever
 * method it had. The result does not depend on the arrival order, and a
 * redelivered or duplicate reading re-runs the (idempotent) attribution, so a
 * failure between storing the reading and updating the segments heals on retry.
 *
 * @method telemetry.fuel_reading_usage
 */
@Injectable()
export class TelemetryAttributionService {
  constructor(
    @InjectConfig() private readonly config: Config,
    private readonly readings: FuelReadingsRepository,
    private readonly segments: SegmentsRepository,
    private readonly publication: CiiPublicationRepository,
    private readonly refresher: AggregateRefresher,
  ) {}

  async onReading(reading: FuelReadingRecordedV1): Promise<ReadingOutcome> {
    const stored = await this.readings.insert(reading);
    const toleranceMs = this.config.TELEMETRY_ACTIVE_WINDOW_MIN * 60_000;
    const time = new Date(reading.time).getTime();
    const start =
      reading.periodStart === null
        ? time
        : new Date(reading.periodStart).getTime();
    const candidates = await this.segments.findOverlapping(
      reading.mmsi,
      new Date(Math.min(start, time) - toleranceMs),
      new Date(time + toleranceMs),
    );
    let reattributed = 0;
    for (const segment of candidates) {
      const window = { start: segment.timeStart, end: segment.timeEnd };
      const nearby = await this.readings.findAround(
        reading.mmsi,
        window.start,
        window.end,
        toleranceMs,
      );
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
      ) {
        continue;
      }
      const flags: SegmentFlag[] = ['telemetry_reattributed'];
      await this.segments.updateTelemetryFuel({
        mmsi: reading.mmsi,
        timeStart: segment.timeStart,
        fuelMeTon: fuel.meTon,
        fuelAeTon: fuel.aeTon,
        co2Ton,
        flags: [
          ...segment.flags.filter(
            (flag) =>
              !MODEL_FLAGS.has(flag) && flag !== 'telemetry_reattributed',
          ),
          ...flags,
        ],
      });
      this.refresher.markChanged(segment.timeStart);
      reattributed += 1;
    }
    if (reattributed > 0) await this.publication.markDirty(reading.mmsi);
    return { kind: stored ? 'stored' : 'duplicate', reattributed };
  }
}
