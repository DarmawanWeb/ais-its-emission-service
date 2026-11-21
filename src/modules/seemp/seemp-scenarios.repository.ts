import { type Database, InjectDb } from '@darmawanweb/ais-its-nest/db';
import { Injectable } from '@nestjs/common';
import { and, count, desc, eq, type SQL, sql } from 'drizzle-orm';

import type { OrgScope } from '../../common/tenancy.js';
import * as schema from '../../db/schema.js';

const { seempScenarios } = schema;

/** A saved simulation. */
export type SeempScenario = typeof seempScenarios.$inferSelect;
/** A simulation to save. */
export type NewSeempScenario = Omit<SeempScenario, 'createdAt' | 'updatedAt'>;

/** Drizzle access to `seemp_scenarios`; every query is restricted to an {@link OrgScope}. */
@Injectable()
export class SeempScenariosRepository {
  constructor(@InjectDb() private readonly db: Database<typeof schema>) {}

  async insert(scenario: NewSeempScenario): Promise<SeempScenario> {
    const [row] = await this.db.insert(seempScenarios).values(scenario).returning();
    if (row === undefined) throw new Error('INSERT … RETURNING returned no row');
    return row;
  }

  async find(id: string, scope: OrgScope): Promise<SeempScenario | undefined> {
    const [row] = await this.db
      .select()
      .from(seempScenarios)
      .where(and(eq(seempScenarios.id, id), scopeCondition(scope)))
      .limit(1);
    return row;
  }

  /** One page, newest first. */
  async list(
    scope: OrgScope,
    mmsi: number | undefined,
    page: { readonly offset: number; readonly limit: number },
  ): Promise<{ rows: SeempScenario[]; total: number }> {
    const where = and(scopeCondition(scope), mmsi === undefined ? undefined : eq(seempScenarios.mmsi, mmsi));
    const [rows, totals] = await Promise.all([
      this.db
        .select()
        .from(seempScenarios)
        .where(where)
        .orderBy(desc(seempScenarios.createdAt), desc(seempScenarios.id))
        .limit(page.limit)
        .offset(page.offset),
      this.db.select({ total: count() }).from(seempScenarios).where(where),
    ]);
    return { rows, total: totals[0]?.total ?? 0 };
  }

  /** Deletes a scenario of the scope; `undefined` when none matched. */
  async delete(id: string, scope: OrgScope): Promise<SeempScenario | undefined> {
    const [row] = await this.db
      .delete(seempScenarios)
      .where(and(eq(seempScenarios.id, id), scopeCondition(scope)))
      .returning();
    return row;
  }
}

function scopeCondition(scope: OrgScope): SQL | undefined {
  if (scope.kind === 'all') return undefined;
  // Without an active organization a non-admin sees nothing (spec §8.5).
  return scope.orgId === null ? sql`false` : eq(seempScenarios.orgId, scope.orgId);
}
