import type { FuelConsumption } from './types.js';

/** A stored telemetry fuel reading (`fuel.reading.recorded.v1`). */
export interface FuelReading {
  /** Reading time; end of the measured period when {@link periodStart} is set. */
  readonly time: Date;
  /** Start of the measured period; `null` = an instantaneous report. */
  readonly periodStart: Date | null;
  /** Main engine fuel consumed in the period, t. */
  readonly fuelMeTon: number;
  /** Auxiliary engine fuel consumed in the period, t. */
  readonly fuelAeTon: number;
}

/** A half-open time window `(start, end]` (a segment `previous → current`). */
export interface TimeWindow {
  readonly start: Date;
  readonly end: Date;
}

/**
 * Share of a reading attributed to a segment window `(start, end]`:
 * - a reading with a period `[periodStart, time]` (periodStart < time) counts
 *   pro rata of the overlap: `|[periodStart, time] ∩ [start, end]| / (time − periodStart)`;
 * - an instantaneous reading (no period, or periodStart ≥ time) counts fully
 *   in the window that contains its time (`start < time ≤ end`), so
 *   consecutive segments never count it twice.
 *
 * @method telemetry.fuel_reading_usage
 * @returns a factor in [0, 1].
 */
export function readingShare(reading: FuelReading, window: TimeWindow): number {
  const end = reading.time.getTime();
  const start = reading.periodStart?.getTime() ?? end;
  const windowStart = window.start.getTime();
  const windowEnd = window.end.getTime();
  if (start >= end) return windowStart < end && end <= windowEnd ? 1 : 0;
  const overlap = Math.min(end, windowEnd) - Math.max(start, windowStart);
  return overlap > 0 ? overlap / (end - start) : 0;
}

/**
 * Whether telemetry is active for a segment (v2 rule, spec §13.4 / §15.5 —
 * the legacy compared the last reading with "now" in units of 10 s): at least
 * one reading of the vessel overlaps the segment window, or has its time
 * within `activeWindowMinutes` (TELEMETRY_ACTIVE_WINDOW_MIN, default 10) of
 * the segment end.
 *
 * @method fuel.method_selection
 * @method telemetry.fuel_reading_usage
 */
export function isTelemetryActive(
  readings: readonly FuelReading[],
  window: TimeWindow,
  activeWindowMinutes: number,
): boolean {
  const windowEnd = window.end.getTime();
  const tolerance = activeWindowMinutes * 60_000;
  return readings.some(
    (reading) =>
      readingShare(reading, window) > 0 ||
      Math.abs(reading.time.getTime() - windowEnd) <= tolerance,
  );
}

/** Telemetry fuel of a segment with the number of contributing readings. */
export interface TelemetryFuel extends FuelConsumption {
  readonly readings: number;
}

/**
 * Telemetry fuel of a segment: `FC_x = Σ_r share(r) · r.fuel_x` over the
 * vessel's readings (see {@link readingShare}); no navstatus multipliers (the
 * legacy telemetry path applies none). The legacy took the first log of the
 * latest reading regardless of the segment duration; v2 attributes readings
 * by time so that a period's fuel is counted exactly once.
 *
 * @method telemetry.fuel_reading_usage
 * @see docs/METHODOLOGY.md#telemetry.fuel_reading_usage
 */
export function segmentFuelFromReadings(
  readings: readonly FuelReading[],
  window: TimeWindow,
): TelemetryFuel {
  let meTon = 0;
  let aeTon = 0;
  let count = 0;
  for (const reading of readings) {
    const share = readingShare(reading, window);
    if (share <= 0) continue;
    meTon += reading.fuelMeTon * share;
    aeTon += reading.fuelAeTon * share;
    count += 1;
  }
  return { meTon, aeTon, totalTon: meTon + aeTon, readings: count };
}
