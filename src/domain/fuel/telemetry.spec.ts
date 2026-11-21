import { describe, expect, it } from 'vitest';

import { selectFuelMethod } from './method.js';
import {
  type FuelReading,
  isTelemetryActive,
  readingShare,
  segmentFuelFromReadings,
} from './telemetry.js';

const t = (minutes: number): Date =>
  new Date(Date.UTC(2026, 2, 10, 8, 0) + minutes * 60_000);
const reading = (
  time: number,
  periodStart: number | null,
  fuelMeTon: number,
  fuelAeTon: number,
): FuelReading => ({
  time: t(time),
  periodStart: periodStart === null ? null : t(periodStart),
  fuelMeTon,
  fuelAeTon,
});
const window = (start: number, end: number) => ({
  start: t(start),
  end: t(end),
});

describe('telemetry attribution rule', () => {
  it('counts a period reading pro rata of its overlap with the segment', () => {
    // reading over [0, 20] min, segment (10, 30] → 10 of 20 minutes
    expect(readingShare(reading(20, 0, 1, 1), window(10, 30))).toBe(0.5);
    expect(readingShare(reading(20, 0, 1, 1), window(0, 20))).toBe(1);
    expect(readingShare(reading(20, 0, 1, 1), window(20, 30))).toBe(0);
    expect(readingShare(reading(20, 5, 1, 1), window(0, 10))).toBeCloseTo(
      5 / 15,
      15,
    );
  });

  it('counts an instantaneous reading once, in the segment (start, end] containing its time', () => {
    const instant = reading(10, null, 1, 1);
    expect(readingShare(instant, window(0, 10))).toBe(1);
    expect(readingShare(instant, window(10, 20))).toBe(0);
    // periodStart ≥ time is treated as instantaneous
    expect(readingShare(reading(10, 12, 1, 1), window(5, 10))).toBe(1);
  });

  it('sums ME and AE fuel of the overlapping readings', () => {
    const readings = [
      reading(10, 0, 0.2, 0.1),
      reading(20, 10, 0.4, 0.2),
      reading(25, null, 0.05, 0.01),
    ];
    const fuel = segmentFuelFromReadings(readings, window(5, 25));
    expect(fuel.readings).toBe(3);
    expect(fuel.meTon).toBeCloseTo(0.1 + 0.4 + 0.05, 15);
    expect(fuel.aeTon).toBeCloseTo(0.05 + 0.2 + 0.01, 15);
    expect(fuel.totalTon).toBe(fuel.meTon + fuel.aeTon);
  });

  it('a sequence of segments attributes every reading exactly once', () => {
    const readings = [
      reading(10, 0, 0.3, 0.1),
      reading(20, 10, 0.3, 0.1),
      reading(30, null, 0.2, 0.05),
    ];
    const segments = [window(0, 7), window(7, 15), window(15, 30)];
    const total = segments.reduce(
      (sum, w) => sum + segmentFuelFromReadings(readings, w).totalTon,
      0,
    );
    expect(total).toBeCloseTo(0.4 + 0.4 + 0.25, 12);
  });

  it('a period reading activates telemetry only for the segments its period overlaps', () => {
    expect(isTelemetryActive([reading(5, 0, 1, 1)], window(0, 10), 10)).toBe(
      true,
    );
    expect(isTelemetryActive([reading(20, 12, 1, 1)], window(0, 10), 10)).toBe(
      false,
    );
    expect(isTelemetryActive([], window(0, 10), 10)).toBe(false);
  });

  it('an instantaneous reading activates telemetry for segments ending within the active window of it', () => {
    expect(isTelemetryActive([reading(8, null, 1, 1)], window(0, 10), 10)).toBe(
      true,
    );
    expect(
      isTelemetryActive([reading(18, null, 1, 1)], window(0, 10), 10),
    ).toBe(true);
    expect(
      isTelemetryActive([reading(21, null, 1, 1)], window(0, 10), 10),
    ).toBe(false);
    // its whole amount goes to the segment containing it, the neighbours get 0
    expect(
      segmentFuelFromReadings([reading(18, null, 1, 1)], window(0, 10))
        .totalTon,
    ).toBe(0);
    expect(
      segmentFuelFromReadings([reading(18, null, 1, 1)], window(10, 20))
        .totalTon,
    ).toBe(2);
  });
});

describe('fuel method priority (telemetry → first formula → Holtrop)', () => {
  it.each([
    [
      { telemetryActive: true, hasFirstFormula: true, hasMainEngine: true },
      'telemetry',
    ],
    [
      { telemetryActive: false, hasFirstFormula: true, hasMainEngine: true },
      'first_formula',
    ],
    [
      { telemetryActive: false, hasFirstFormula: false, hasMainEngine: true },
      'holtrop',
    ],
    [
      { telemetryActive: false, hasFirstFormula: false, hasMainEngine: false },
      null,
    ],
  ] as const)('%j → %s', (inputs, method) => {
    expect(selectFuelMethod(inputs)).toBe(method);
  });
});
