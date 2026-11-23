import type { TransformFnParams } from 'class-transformer';
import { describe, expect, it } from 'vitest';

import {
  booleanQuery,
  commaList,
  signedSortKeys,
  sortOrderOf,
  trimString,
  upperCommaList,
} from './query.js';

const params = (value: unknown) => ({ value }) as TransformFnParams;

describe('query transforms', () => {
  it('splits comma lists and repeated keys, dropping empty entries', () => {
    expect(commaList(params('D,E'))).toEqual(['D', 'E']);
    expect(commaList(params(['D', 'E, A']))).toEqual(['D', 'E', 'A']);
    expect(commaList(params(' telemetry , ,holtrop '))).toEqual([
      'telemetry',
      'holtrop',
    ]);
    expect(upperCommaList(params('d,e'))).toEqual(['D', 'E']);
    // Values that are not strings reach the validators unchanged.
    expect(commaList(params(5))).toBe(5);
    expect(commaList(params([1, 'A']))).toEqual([1, 'A']);
  });

  it('parses booleans strictly', () => {
    expect(booleanQuery(params('true'))).toBe(true);
    expect(booleanQuery(params('false'))).toBe(false);
    for (const value of ['1', 'yes', '', 'TRUE'])
      expect(booleanQuery(params(value))).toBe(value);
  });

  it('trims strings only', () => {
    expect(trimString(params('  KM Sinar  '))).toBe('KM Sinar');
    expect(trimString(params(3))).toBe(3);
  });

  it('lists and parses signed sort keys', () => {
    expect(signedSortKeys(['name', 'mmsi'])).toEqual([
      'name',
      '-name',
      'mmsi',
      '-mmsi',
    ]);
    expect(sortOrderOf('-rating')).toEqual({
      key: 'rating',
      descending: true,
    });
    expect(sortOrderOf('name')).toEqual({ key: 'name', descending: false });
  });
});
