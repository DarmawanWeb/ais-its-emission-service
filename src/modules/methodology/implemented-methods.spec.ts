import { getMethod } from '@darmawanweb/ais-its-contracts/references';
import { describe, expect, it } from 'vitest';

import {
  IMPLEMENTED_METHOD_IDS,
  VESSEL_TYPE_SOURCE_METHOD_IDS,
} from './implemented-methods.js';
import { METHOD_IDS } from './method-ids.js';

/** Every string of a nested record of id lists. */
function idsOf(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap(idsOf);
  if (typeof value === 'object' && value !== null)
    return Object.values(value).flatMap(idsOf);
  return [];
}

describe('IMPLEMENTED_METHOD_IDS', () => {
  it('lists only methods of the contracts catalog, marked implemented', () => {
    const missing = IMPLEMENTED_METHOD_IDS.filter(
      (id) => getMethod(id) === undefined,
    );
    expect(missing).toEqual([]);
    const notImplemented = IMPLEMENTED_METHOD_IDS.filter(
      (id) => getMethod(id)?.status !== 'implemented',
    );
    expect(notImplemented).toEqual([]);
  });

  it('has no duplicates', () => {
    expect(new Set(IMPLEMENTED_METHOD_IDS).size).toBe(
      IMPLEMENTED_METHOD_IDS.length,
    );
  });

  it('covers every id the responses cite (methodIds)', () => {
    const cited = new Set([
      ...idsOf(METHOD_IDS),
      ...VESSEL_TYPE_SOURCE_METHOD_IDS,
    ]);
    const implemented = new Set(IMPLEMENTED_METHOD_IDS);
    expect([...cited].filter((id) => !implemented.has(id))).toEqual([]);
  });
});
