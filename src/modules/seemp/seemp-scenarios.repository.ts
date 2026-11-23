import { type Database, InjectDb } from '@darmawanweb/ais-its-nest/db';
import { Injectable } from '@nestjs/common';
import {
  and,
  asc,
  count,
  desc,
  eq,
  getTableColumns,
  ilike,
  or,
  type SQL,
  sql,
} from 'drizzle-orm';

import { sortOrderOf } from '../../common/query.js';
import type { OrgScope } from '../../common/tenancy.js';
import * as schema from '../../db/schema.js';

const { seempScenarios, vesselProfiles } = schema;

/** A saved simulation as stored. */
type StoredSeempScenario = typeof seempScenarios.$inferSelect;
/** A saved simulation with the current name of its vessel. */
export type SeempScenario = StoredSeempScenario & {
  /** Name of the vessel in the FLEET projection; `null` once the vessel is gone. */
  readonly vesselName: string | null;
};
/** A simulation to save. */
export type NewSeempScenario = Omit<
  StoredSeempScenario,
  'createdAt' | 'updatedAt'
>;

/** Sort keys of the scenario list. */
export const SCENARIO_SORT_KEYS = [
  'createdAt',
  'name',
  'vesselName',
  'mmsi',
] as const;
/** A scenario sort key; a leading `-` sorts descending. */
export type ScenarioSort =
  | (typeof SCENARIO_SORT_KEYS)[number]
  | `-${(typeof SCENARIO_SORT_KEYS)[number]}`;

/** Filters of the scenario list. */
export interface ScenarioListFilter {
  readonly mmsi?: number | undefined;
  /** Scenario or vessel name (case-insensitive substring), or MMSI prefix of digits. */
  readonly search?: string | undefined;
  readonly sort: ScenarioSort;
}

const vesselName = sql<string | null>`${vesselProfiles.snapshot}->>'name'`.as(
  'vessel_name',
);

/** Drizzle access to `seemp_scenarios`; every query is restricted to an {@link OrgScope}. */
@Injectable()
export class SeempScenariosRepository {
  constructor(@InjectDb() private readonly db: Database<typeof schema>) {}

  async insert(
    scenario: NewSeempScenario,
    currentVesselName: string,
  ): Promise<SeempScenario> {
    const [row] = await this.db
      .insert(seempScenarios)
      .values(scenario)
      .returning();
    if (row === undefined)
      throw new Error('INSERT … RETURNING returned no row');
    return { ...row, vesselName: currentVesselName };
  }

  async find(id: string, scope: OrgScope): Promise<SeempScenario | undefined> {
    const [row] = await this.withVesselName()
      .where(and(eq(seempScenarios.id, id), scopeCondition(scope)))
      .limit(1);
    return row;
  }

  /** One page in the requested order (default newest first). */
  async list(
    scope: OrgScope,
    filter: ScenarioListFilter,
    page: { readonly offset: number; readonly limit: number },
  ): Promise<{ rows: SeempScenario[]; total: number }> {
    const where = and(
      scopeCondition(scope),
      filter.mmsi === undefined
        ? undefined
        : eq(seempScenarios.mmsi, filter.mmsi),
      filter.search === undefined ? undefined : searchCondition(filter.search),
    );
    const [rows, totals] = await Promise.all([
      this.withVesselName()
        .where(where)
        .orderBy(...orderOf(filter.sort))
        .limit(page.limit)
        .offset(page.offset),
      this.db
        .select({ total: count() })
        .from(seempScenarios)
        .leftJoin(
          vesselProfiles,
          eq(vesselProfiles.vesselId, seempScenarios.vesselId),
        )
        .where(where),
    ]);
    return { rows, total: totals[0]?.total ?? 0 };
  }

  /** Renames a scenario of the scope; `undefined` when none matched. */
  async rename(
    id: string,
    name: string,
    scope: OrgScope,
  ): Promise<SeempScenario | undefined> {
    const [row] = await this.db
      .update(seempScenarios)
      .set({ name, updatedAt: sql`now()` })
      .where(and(eq(seempScenarios.id, id), scopeCondition(scope)))
      .returning({ id: seempScenarios.id });
    return row === undefined ? undefined : this.find(id, scope);
  }

  /** Deletes a scenario of the scope; `undefined` when none matched. */
  async delete(
    id: string,
    scope: OrgScope,
  ): Promise<StoredSeempScenario | undefined> {
    const [row] = await this.db
      .delete(seempScenarios)
      .where(and(eq(seempScenarios.id, id), scopeCondition(scope)))
      .returning();
    return row;
  }

  /** Scenarios with the current name of their vessel. */
  private withVesselName() {
    return this.db
      .select({ ...getTableColumns(seempScenarios), vesselName })
      .from(seempScenarios)
      .leftJoin(
        vesselProfiles,
        eq(vesselProfiles.vesselId, seempScenarios.vesselId),
      )
      .$dynamic();
  }
}

function scopeCondition(scope: OrgScope): SQL | undefined {
  if (scope.kind === 'all') return undefined;
  // Without an active organization a non-admin sees nothing (spec §8.5).
  return scope.orgId === null
    ? sql`false`
    : eq(seempScenarios.orgId, scope.orgId);
}

/** `ILIKE` pattern of a literal substring (`%`, `_` and `\` escaped). */
function containsPattern(text: string): string {
  return `%${text.replace(/[\\%_]/g, (char) => `\\${char}`)}%`;
}

function searchCondition(search: string): SQL | undefined {
  const pattern = containsPattern(search);
  return or(
    ilike(seempScenarios.name, pattern),
    ilike(sql`${vesselProfiles.snapshot}->>'name'`, pattern),
    /^\d+$/.test(search)
      ? sql`${seempScenarios.mmsi}::text LIKE ${`${search}%`}`
      : undefined,
  );
}

/** ORDER BY of a signed sort key; ties by newest first (then id). */
function orderOf(sort: ScenarioSort): SQL[] {
  const { key, descending } = sortOrderOf(sort);
  const direction = descending ? desc : asc;
  const tieBreak = [desc(seempScenarios.createdAt), desc(seempScenarios.id)];
  switch (key) {
    case 'createdAt':
      return descending
        ? tieBreak
        : [asc(seempScenarios.createdAt), asc(seempScenarios.id)];
    case 'name':
      return [direction(sql`lower(${seempScenarios.name})`), ...tieBreak];
    case 'vesselName':
      return [
        sql`lower(${vesselProfiles.snapshot}->>'name') ${sql.raw(descending ? 'DESC' : 'ASC')} NULLS LAST`,
        ...tieBreak,
      ];
    case 'mmsi':
      return [direction(seempScenarios.mmsi), ...tieBreak];
  }
}
