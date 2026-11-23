import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { describe, expect, it } from 'vitest';

import {
  FleetFuelQuery,
  FleetSummaryQuery,
  RecomputeJobsQuery,
  SegmentsQuery,
} from './cii-queries.js';

/** Validates like the kit's ValidationPipe (whitelist, forbidNonWhitelisted). */
async function errorsOf(
  type: new () => object,
  input: Record<string, unknown>,
): Promise<Record<string, string[]>> {
  const errors = await validate(plainToInstance(type, input), {
    whitelist: true,
    forbidNonWhitelisted: true,
  });
  return Object.fromEntries(
    errors.map((error) => [
      error.property,
      Object.keys(error.constraints ?? {}).sort(),
    ]),
  );
}

describe('FleetSummaryQuery', () => {
  it('parses grade lists, search and the default sort', async () => {
    const query = plainToInstance(FleetSummaryQuery, {
      grade: 'd,E',
      search: '  Kapal ',
    });
    expect(query.grade).toEqual(['D', 'E']);
    expect(query.search).toBe('Kapal');
    expect(query.sort).toBe('mmsi');
    expect(query.page).toBe(1);
    expect(
      await errorsOf(FleetSummaryQuery, { grade: 'D,E', sort: '-rating' }),
    ).toEqual({});
  });

  it('rejects unknown grades and sort keys and an empty search', async () => {
    expect(
      await errorsOf(FleetSummaryQuery, {
        grade: 'D,F',
        sort: 'speed',
        search: ' ',
      }),
    ).toEqual({ grade: ['isIn'], sort: ['isIn'], search: ['isLength'] });
    expect(await errorsOf(FleetSummaryQuery, { grade: ',' })).toEqual({
      grade: ['arrayMinSize'],
    });
  });
});

describe('FleetFuelQuery', () => {
  it('bounds the month', async () => {
    expect(
      await errorsOf(FleetFuelQuery, { year: '2026', month: '11' }),
    ).toEqual({});
    expect(await errorsOf(FleetFuelQuery, { month: '13' })).toEqual({
      month: ['max'],
    });
    expect(await errorsOf(FleetFuelQuery, { month: '0' })).toEqual({
      month: ['min'],
    });
  });
});

describe('SegmentsQuery', () => {
  it('accepts method lists and known flags only', async () => {
    expect(
      await errorsOf(SegmentsQuery, { method: 'holtrop,none', flag: 'gap' }),
    ).toEqual({});
    expect(
      await errorsOf(SegmentsQuery, { method: 'magic', flag: 'unknown_flag' }),
    ).toEqual({ method: ['isIn'], flag: ['isIn'] });
  });
});

describe('RecomputeJobsQuery', () => {
  it('validates the MMSI and status filters', async () => {
    expect(
      await errorsOf(RecomputeJobsQuery, {
        mmsi: '525005223',
        status: 'running',
      }),
    ).toEqual({});
    expect(
      await errorsOf(RecomputeJobsQuery, { mmsi: '12345', status: 'paused' }),
    ).toEqual({ mmsi: ['min'], status: ['isIn'] });
  });
});
