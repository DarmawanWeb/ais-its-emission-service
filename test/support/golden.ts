import { readFileSync } from 'node:fs';

import { expect } from 'vitest';
import * as z from 'zod';

/**
 * Golden fixtures: inputs and outputs of the ORIGINAL legacy TypeScript
 * functions (be-legacy, run unchanged with tsx; Mongo repositories and the
 * Open-Meteo call stubbed with fixed data, "now" fixed at 2026-06-15T12:00Z),
 * recorded under `test/fixtures/golden/*.json`. Ported functions must
 * reproduce them within {@link RELATIVE_TOLERANCE}.
 */
export const RELATIVE_TOLERANCE = 1e-9;

/** A number of a fixture; non-finite values are stored as strings by the harness. */
export const num = z.union([
  z.number(),
  z.enum(['NaN', 'Infinity', '-Infinity']).transform((value) => Number(value)),
]);

/** Reads and validates `test/fixtures/golden/<name>`. */
export function loadGolden<Schema extends z.ZodType>(
  name: string,
  schema: Schema,
): z.output<Schema> {
  const url = new URL(`../fixtures/golden/${name}`, import.meta.url);
  return schema.parse(JSON.parse(readFileSync(url, 'utf8')));
}

/**
 * `|actual − expected| ≤ 1e-9 · |expected|` (exact for 0, NaN and ±∞).
 *
 * @param label shown when the assertion fails (fixture case and quantity).
 */
export function expectClose(
  actual: number,
  expected: number,
  label: string,
): void {
  if (Number.isNaN(expected)) {
    expect(actual, label).toBeNaN();
    return;
  }
  if (!Number.isFinite(expected) || expected === 0) {
    expect(actual === expected, `${label}: ${actual} !== ${expected}`).toBe(
      true,
    );
    return;
  }
  const relative = Math.abs(actual - expected) / Math.abs(expected);
  expect(
    relative,
    `${label}: ${actual} vs legacy ${expected}`,
  ).toBeLessThanOrEqual(RELATIVE_TOLERANCE);
}

/** {@link expectClose} on every pair `[actual, expected]` of a record. */
export function expectAllClose(
  pairs: Readonly<Record<string, readonly [number, number]>>,
  label: string,
): void {
  for (const [name, [actual, expected]] of Object.entries(pairs))
    expectClose(actual, expected, `${label} ${name}`);
}
