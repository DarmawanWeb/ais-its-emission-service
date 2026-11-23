import {
  CII_GRADES,
  type CiiGrade,
} from '@darmawanweb/ais-its-contracts/domain';

import { sortOrderOf } from '../../common/query.js';
import type { FleetSort } from './dto/cii-queries.js';

/** What the filters and the sort of the fleet summary read of an item. */
export interface FleetItemView {
  readonly vessel: {
    readonly mmsi: number;
    readonly name: string;
    readonly imo: string | null;
  };
  readonly figures: {
    readonly grade: CiiGrade | null;
    readonly rating: number | null;
    readonly attained: number;
  } | null;
}

/** Filters of the fleet summary items. */
export interface FleetItemFilter {
  /** Only these grades (vessels without a grade never match). */
  readonly grades?: readonly CiiGrade[] | undefined;
  /** Name substring (case-insensitive), or MMSI / IMO prefix of digits. */
  readonly search?: string | undefined;
}

const DIGITS = /^\d+$/;

/**
 * `true` when the vessel matches the search text: its name contains it
 * (case-insensitive), or the text is digits that start its MMSI or IMO
 * number (an `IMO` prefix of the stored number is ignored).
 */
export function matchesFleetSearch(
  vessel: FleetItemView['vessel'],
  search: string,
): boolean {
  const text = search.trim().toLowerCase();
  if (text.length === 0) return true;
  if (vessel.name.toLowerCase().includes(text)) return true;
  if (!DIGITS.test(text)) return false;
  const imo = vessel.imo?.replace(/^imo\s*/i, '') ?? '';
  return String(vessel.mmsi).startsWith(text) || imo.startsWith(text);
}

/** The items matching every given filter, in their order. */
export function filterFleetItems<Item extends FleetItemView>(
  items: readonly Item[],
  filter: FleetItemFilter,
): Item[] {
  const grades =
    filter.grades === undefined ? undefined : new Set(filter.grades);
  const { search } = filter;
  return items.filter((item) => {
    if (grades !== undefined) {
      const grade = item.figures?.grade ?? null;
      if (grade === null || !grades.has(grade)) return false;
    }
    return search === undefined || matchesFleetSearch(item.vessel, search);
  });
}

/** Sort values of an item (`null` = no value: always last). */
function keyOf(
  item: FleetItemView,
  key: 'mmsi' | 'name' | 'grade' | 'rating' | 'attained',
): readonly (number | string)[] | null {
  const { figures } = item;
  switch (key) {
    case 'mmsi':
      return [item.vessel.mmsi];
    case 'name':
      return [item.vessel.name];
    case 'grade':
      // Within a grade, the rating orders the vessels the same way.
      return figures?.grade === undefined || figures.grade === null
        ? null
        : [CII_GRADES.indexOf(figures.grade), figures.rating ?? 0];
    case 'rating':
      return figures?.rating === undefined || figures.rating === null
        ? null
        : [figures.rating];
    case 'attained':
      return figures === null ? null : [figures.attained];
  }
}

function compareValues(
  a: readonly (number | string)[],
  b: readonly (number | string)[],
): number {
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    const x = a[i];
    const y = b[i];
    const order =
      typeof x === 'string' && typeof y === 'string'
        ? x.localeCompare(y, 'en', { sensitivity: 'base' })
        : Number(x) - Number(y);
    if (order !== 0) return order;
  }
  return 0;
}

/**
 * The items in the order of a signed sort key (`-` = descending). Items
 * without a value of the key (no CII data, no grade or rating) come last in
 * both directions; ties are broken by ascending MMSI.
 */
export function sortFleetItems<Item extends FleetItemView>(
  items: readonly Item[],
  sort: FleetSort,
): Item[] {
  const { key, descending } = sortOrderOf(sort);
  return [...items].sort((a, b) => {
    const x = keyOf(a, key);
    const y = keyOf(b, key);
    if (x === null || y === null) {
      if (x !== null) return -1;
      if (y !== null) return 1;
    } else {
      const order = compareValues(x, y);
      if (order !== 0) return descending ? -order : order;
    }
    return a.vessel.mmsi - b.vessel.mmsi;
  });
}
