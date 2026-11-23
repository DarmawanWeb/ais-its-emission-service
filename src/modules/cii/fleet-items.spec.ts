import type { CiiGrade } from '@darmawanweb/ais-its-contracts/domain';
import { describe, expect, it } from 'vitest';

import {
  type FleetItemView,
  filterFleetItems,
  matchesFleetSearch,
  sortFleetItems,
} from './fleet-items.js';

function item(
  mmsi: number,
  name: string,
  figures: {
    grade: CiiGrade | null;
    rating: number | null;
    attained: number;
  } | null,
  imo: string | null = null,
): FleetItemView {
  return { vessel: { mmsi, name, imo }, figures };
}

const ITEMS = [
  item(525000003, 'Kapal Cendana', { grade: 'D', rating: 1.2, attained: 9 }),
  item(
    525000001,
    'banda Express',
    { grade: 'B', rating: 0.92, attained: 6 },
    'IMO 9234567',
  ),
  item(525000004, 'Delima', null),
  item(525000002, 'Anggrek', { grade: 'E', rating: 1.5, attained: 12 }),
  item(525000005, 'Cempaka', { grade: 'D', rating: 1.15, attained: 8 }),
  item(525000006, 'Manual Only', { grade: null, rating: null, attained: 7 }),
];

const mmsis = (items: readonly FleetItemView[]) =>
  items.map((entry) => entry.vessel.mmsi);

describe('fleet summary items', () => {
  it('filters by grade (vessels without a grade never match) and search', () => {
    expect(mmsis(filterFleetItems(ITEMS, { grades: ['D', 'E'] }))).toEqual([
      525000003, 525000002, 525000005,
    ]);
    expect(mmsis(filterFleetItems(ITEMS, { search: 'kapal' }))).toEqual([
      525000003,
    ]);
    expect(
      mmsis(filterFleetItems(ITEMS, { grades: ['D'], search: 'cem' })),
    ).toEqual([525000005]);
    expect(filterFleetItems(ITEMS, {})).toHaveLength(ITEMS.length);
  });

  it('searches names, MMSI and IMO prefixes', () => {
    const banda = ITEMS[1]?.vessel;
    if (banda === undefined) throw new Error('fixture');
    expect(matchesFleetSearch(banda, 'EXPRESS')).toBe(true);
    expect(matchesFleetSearch(banda, '52500000')).toBe(true);
    expect(matchesFleetSearch(banda, '923')).toBe(true);
    expect(matchesFleetSearch(banda, '9999')).toBe(false);
    expect(matchesFleetSearch(banda, '  ')).toBe(true);
  });

  it('sorts by the signed key, without data last in both directions, ties by MMSI', () => {
    expect(mmsis(sortFleetItems(ITEMS, 'mmsi'))).toEqual([
      525000001, 525000002, 525000003, 525000004, 525000005, 525000006,
    ]);
    expect(mmsis(sortFleetItems(ITEMS, '-mmsi'))[0]).toBe(525000006);
    // Case-insensitive names.
    expect(mmsis(sortFleetItems(ITEMS, 'name'))).toEqual([
      525000002, 525000001, 525000005, 525000004, 525000003, 525000006,
    ]);
    expect(mmsis(sortFleetItems(ITEMS, 'rating'))).toEqual([
      525000001, 525000005, 525000003, 525000002, 525000004, 525000006,
    ]);
    expect(mmsis(sortFleetItems(ITEMS, '-rating'))).toEqual([
      525000002, 525000003, 525000005, 525000001, 525000004, 525000006,
    ]);
    // Grade then rating: within D the better rating first (or last when descending).
    expect(mmsis(sortFleetItems(ITEMS, 'grade'))).toEqual([
      525000001, 525000005, 525000003, 525000002, 525000004, 525000006,
    ]);
    expect(mmsis(sortFleetItems(ITEMS, '-grade'))).toEqual([
      525000002, 525000003, 525000005, 525000001, 525000004, 525000006,
    ]);
    // A manual record without a grade still has an attained CII.
    expect(mmsis(sortFleetItems(ITEMS, '-attained'))).toEqual([
      525000002, 525000003, 525000005, 525000006, 525000001, 525000004,
    ]);
  });
});
