import { describe, expect, it } from 'vitest';

import type { SegmentRow } from '../segments/segments.repository.js';
import { SEGMENT_CSV_COLUMNS, segmentsCsv } from './segment-csv.js';

const base = {
  timeStart: new Date('2026-03-10T08:00:00.000Z'),
  timeEnd: new Date('2026-03-10T08:10:00.000Z'),
  mmsi: 525005223,
  vesselId: '0190d5c0-0000-7000-8000-000000000001',
  distanceNm: 2.1,
  speedKn: 12.6,
  fuelMeTon: 0.05,
  fuelAeTon: 0.01,
  co2Ton: 0.19236,
  navstatus: 0,
  fuelCode: 'mgo',
  conversionFactor: 3.206,
  computedAt: new Date('2026-03-10T08:10:01.000Z'),
} as const;

describe('segmentsCsv', () => {
  it('writes one row per segment with the weather columns and |-joined flags', () => {
    const rows = [
      {
        ...base,
        method: 'holtrop',
        weather: {
          windSpeedKn: 14,
          windDirectionDeg: 270,
          beaufortNumber: 4,
          encounterAngleDeg: 35,
          source: 'calm_fallback',
          hour: '2026-03-10T08:00',
          cell: { lat: 1.25, lon: 104 },
        },
        flags: ['weather_unavailable', 'telemetry_reattributed'],
      },
      { ...base, method: 'none', weather: null, flags: ['gap'] },
    ] as unknown as SegmentRow[];
    const lines = segmentsCsv(rows).split('\r\n');
    expect(lines[0]).toBe(SEGMENT_CSV_COLUMNS.join(','));
    expect(lines[1]).toBe(
      '2026-03-10T08:00:00.000Z,2026-03-10T08:10:00.000Z,525005223,0190d5c0-0000-7000-8000-000000000001,2.1,12.6,0.05,0.01,0.19236,holtrop,0,mgo,3.206,calm_fallback,14,270,4,35,weather_unavailable|telemetry_reattributed',
    );
    expect(lines[2]?.endsWith(',none,0,mgo,3.206,,,,,,gap')).toBe(true);
    expect(lines).toHaveLength(4);
    expect(lines[3]).toBe('');
  });

  it('writes the header alone for no segments', () => {
    expect(segmentsCsv([])).toBe(`${SEGMENT_CSV_COLUMNS.join(',')}\r\n`);
  });
});
