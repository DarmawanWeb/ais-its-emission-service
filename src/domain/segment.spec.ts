import { describe, expect, it } from 'vitest';
import * as z from 'zod';

import { expectAllClose, loadGolden, num } from '../../test/support/golden.js';
import {
  calculateSpeed,
  classifySegmentWindow,
  SPEED_CAP_KN,
} from './segment.js';

const FixSchema = z.object({
  lat: z.number(),
  lon: z.number(),
  time: z.string(),
  navstatus: z.number(),
});
const RadSchema = z.object({ lat: num, lon: num });

const SPEED = loadGolden(
  'speed.json',
  z.object({
    cases: z.array(
      z.object({
        name: z.string(),
        input: z.object({ current: FixSchema, previous: FixSchema }),
        output: z.object({
          firstPositionRad: RadSchema,
          secondPositionRad: RadSchema,
          distance: num,
          distanceInMeters: num,
          speedKnot: num,
          speedMs: num,
          timeDifferenceHours: num,
          timeDifferenceMinutes: num,
        }),
      }),
    ),
  }),
);

const fix = (value: z.output<typeof FixSchema>) => ({
  lat: value.lat,
  lon: value.lon,
  time: new Date(value.time),
});

describe('calculateSpeed — golden parity with legacy utils/cii/speed-calculation.ts', () => {
  it.each(SPEED.cases.map((c) => [c.name, c] as const))('%s', (_name, c) => {
    const result = calculateSpeed(fix(c.input.current), fix(c.input.previous));
    const legacy = c.output;
    expectAllClose(
      {
        currentLat: [result.currentRad.lat, legacy.firstPositionRad.lat],
        currentLon: [result.currentRad.lon, legacy.firstPositionRad.lon],
        previousLat: [result.previousRad.lat, legacy.secondPositionRad.lat],
        previousLon: [result.previousRad.lon, legacy.secondPositionRad.lon],
        distanceNm: [result.distanceNm, legacy.distance],
        distanceM: [result.distanceM, legacy.distanceInMeters],
        speedKn: [result.speedKn, legacy.speedKnot],
        speedMs: [result.speedMs, legacy.speedMs],
        durationHours: [result.durationHours, legacy.timeDifferenceHours],
        durationMinutes: [result.durationMinutes, legacy.timeDifferenceMinutes],
      },
      c.name,
    );
  });

  it('caps the speed at 30 kn', () => {
    const capped = SPEED.cases.find((c) => c.name === 'capped-30kn');
    expect(capped?.output.speedKnot).toBe(SPEED_CAP_KN);
  });

  it('gives speed and duration 0 for a zero time difference (legacy branch)', () => {
    const t = new Date('2026-03-10T08:00:00Z');
    const result = calculateSpeed(
      { lat: 1.001, lon: 104.001, time: t },
      { lat: 1, lon: 104, time: t },
    );
    expect(result).toMatchObject({
      speedKn: 0,
      speedMs: 0,
      durationHours: 0,
      durationMinutes: 0,
    });
    expect(result.distanceNm).toBeGreaterThan(0);
  });
});

describe('classifySegmentWindow', () => {
  const t0 = new Date('2026-03-10T08:00:00Z');
  const at = (minutes: number) => ({
    time: new Date(t0.getTime() + minutes * 60_000),
  });

  it('needs a previous fix', () => {
    expect(classifySegmentWindow(at(10), null, 360)).toEqual({
      kind: 'no_previous',
    });
  });

  it('rejects fixes that are not after the previous one', () => {
    expect(classifySegmentWindow(at(0), at(0), 360)).toEqual({
      kind: 'not_after_previous',
    });
    expect(classifySegmentWindow(at(0), at(5), 360)).toEqual({
      kind: 'not_after_previous',
    });
  });

  it('keeps windows up to SEGMENT_MAX_GAP_MIN and flags longer ones as gaps', () => {
    expect(classifySegmentWindow(at(360), at(0), 360)).toEqual({
      kind: 'segment',
      durationMinutes: 360,
    });
    expect(classifySegmentWindow(at(361), at(0), 360)).toEqual({
      kind: 'gap',
      durationMinutes: 361,
    });
  });
});
