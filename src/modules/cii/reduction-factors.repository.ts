import { type Database, InjectDb, InjectPool, type Pool, withTransaction } from '@darmawanweb/ais-its-nest/db';
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
      .select({ year: reductionFactors.year, zPercent: reductionFactors.zPercent, source: reductionFactors.source })
      .from(reductionFactors)
      .orderBy(asc(reductionFactors.year));
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
