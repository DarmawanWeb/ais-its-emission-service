import {
  type Database,
  InjectDb,
  InjectPool,
  type Pool,
  withTransaction,
} from '@darmawanweb/ais-its-nest/db';
import { Injectable } from '@nestjs/common';
import { asc } from 'drizzle-orm';

import * as schema from '../../db/schema.js';
import type { ReductionFactor } from '../../domain/cii.js';

const { reductionFactors } = schema;

/** Drizzle access to `reduction_factors`. */
@Injectable()
export class ReductionFactorsRepository {
  constructor(
    @InjectDb() private readonly db: Database<typeof schema>,
    @InjectPool() private readonly pool: Pool,
  ) {}

  /** Every reduction factor, by year. */
  async list(): Promise<ReductionFactor[]> {
    return this.db
      .select({
        year: reductionFactors.year,
        zPercent: reductionFactors.zPercent,
        source: reductionFactors.source,
      })
      .from(reductionFactors)
      .orderBy(asc(reductionFactors.year));
  }

  /**
   * Removes the reduction factor of a year unless it is in use (in one
   * transaction that locks the table against concurrent changes):
   * - `not_found` without a factor for the year;
   * - `in_use` when a vessel has CII data for it (counted segments in
   *   `cii_annual` or a manual record), `vessels` saying how many;
   * - `gap` when the year is neither the first nor the last of the table;
   * - otherwise `removed`.
   */
  async removeYear(year: number): Promise<
    | { readonly outcome: 'removed' | 'not_found' }
    | { readonly outcome: 'in_use'; readonly vessels: number }
    | {
        readonly outcome: 'gap';
        readonly firstYear: number;
        readonly lastYear: number;
      }
  > {
    return withTransaction(this.pool, async (client) => {
      await client.query('LOCK TABLE reduction_factors IN EXCLUSIVE MODE');
      const { rows: bounds } = await client.query<{
        exists: boolean;
        first: number | null;
        last: number | null;
      }>(
        `SELECT bool_or(year = $1) AS "exists", min(year) AS "first", max(year) AS "last"
           FROM reduction_factors`,
        [year],
      );
      const table = bounds[0];
      if (table?.exists !== true) return { outcome: 'not_found' };
      const { rows: usage } = await client.query<{ vessels: number }>(
        `SELECT count(*)::int AS "vessels" FROM (
           SELECT vessel_id FROM cii_annual WHERE year = $1 AND segments > 0
           UNION
           SELECT vessel_id FROM cii_annual_manual WHERE year = $2
         ) AS used`,
        [new Date(Date.UTC(year, 0, 1)), year],
      );
      const vessels = usage[0]?.vessels ?? 0;
      if (vessels > 0) return { outcome: 'in_use', vessels };
      if (
        table.first !== null &&
        table.last !== null &&
        year !== table.first &&
        year !== table.last
      )
        return { outcome: 'gap', firstYear: table.first, lastYear: table.last };
      await client.query('DELETE FROM reduction_factors WHERE year = $1', [
        year,
      ]);
      return { outcome: 'removed' };
    });
  }

  /** Inserts or replaces the given years atomically; other years are kept. */
  async upsertMany(factors: readonly ReductionFactor[]): Promise<void> {
    await withTransaction(this.pool, async (client) => {
      for (const factor of factors) {
        await client.query(
          `INSERT INTO reduction_factors (year, z_percent, source) VALUES ($1, $2, $3)
           ON CONFLICT (year) DO UPDATE SET z_percent = EXCLUDED.z_percent, source = EXCLUDED.source, updated_at = now()`,
          [factor.year, factor.zPercent, factor.source],
        );
      }
    });
  }
}
