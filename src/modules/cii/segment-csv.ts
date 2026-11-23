import { csvDocument } from '../../common/csv.js';
import type { SegmentRow } from '../segments/segments.repository.js';

/** Most rows of a segment CSV; a larger range answers `X-Truncated: true`. */
export const SEGMENTS_CSV_MAX_ROWS = 50_000;

/** Columns of the segment CSV (units in the names, as the JSON). */
export const SEGMENT_CSV_COLUMNS = [
  'time_start',
  'time_end',
  'mmsi',
  'vessel_id',
  'distance_nm',
  'speed_kn',
  'fuel_me_t',
  'fuel_ae_t',
  'co2_t',
  'method',
  'navstatus',
  'fuel_code',
  'conversion_factor',
  'weather_source',
  'wind_speed_kn',
  'wind_direction_deg',
  'beaufort_number',
  'encounter_angle_deg',
  'flags',
] as const;

/**
 * CSV of stored segments (RFC 4180, CRLF line ends), one row per segment;
 * the weather columns are empty for segments without weather and the flags
 * are separated by `|`.
 */
export function segmentsCsv(rows: readonly SegmentRow[]): string {
  return csvDocument(
    SEGMENT_CSV_COLUMNS,
    rows.map((row) => [
      row.timeStart.toISOString(),
      row.timeEnd.toISOString(),
      row.mmsi,
      row.vesselId,
      row.distanceNm,
      row.speedKn,
      row.fuelMeTon,
      row.fuelAeTon,
      row.co2Ton,
      row.method,
      row.navstatus,
      row.fuelCode,
      row.conversionFactor,
      row.weather?.source ?? null,
      row.weather?.windSpeedKn ?? null,
      row.weather?.windDirectionDeg ?? null,
      row.weather?.beaufortNumber ?? null,
      row.weather?.encounterAngleDeg ?? null,
      row.flags.join('|'),
    ]),
  );
}
