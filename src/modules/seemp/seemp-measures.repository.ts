import { type Database, InjectDb } from '@darmawanweb/ais-its-nest/db';
import { Injectable } from '@nestjs/common';
import { asc } from 'drizzle-orm';
import * as z from 'zod';

import * as schema from '../../db/schema.js';
import type { SeempCostModel, SeempMeasure, SeempReductionModel } from '../../domain/seemp/measures.js';

const { seempMeasures } = schema;

const ReductionSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('operational'), potentialPercent: z.number() }),
  z.object({ type: z.literal('fuel_switch'), conversionFactor: z.number().positive() }),
  z.object({
    type: z.literal('auxiliary'),
    potentialShare: z.number(),
    coldIroning: z.boolean(),
    voyagePercent: z.number().nullable(),
  }),
]) satisfies z.ZodType<SeempReductionModel>;

const CostSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('loa_bands'),
    bands: z.array(z.object({ maxLoaM: z.number().nullable(), usd: z.number() })).min(1),
  }),
  z.object({ type: z.literal('range'), lowUsd: z.number(), highUsd: z.number() }),
  z.object({ type: z.literal('wetted_surface'), usdPerM2: z.number() }),
  z.object({
    type: z.literal('installed_power'),
    usdPerKw: z.number(),
    mainEngine: z.boolean(),
    auxEngines: z.boolean(),
    fixedUsd: z.number(),
  }),
]) satisfies z.ZodType<SeempCostModel>;

/** A catalog measure with its provenance. */
export interface StoredSeempMeasure extends SeempMeasure {
  readonly source: string;
}

/** Drizzle access to `seemp_measures` (models validated on read). */
@Injectable()
export class SeempMeasuresRepository {
  constructor(@InjectDb() private readonly db: Database<typeof schema>) {}

  /** The catalog in legacy order. */
  async list(): Promise<StoredSeempMeasure[]> {
    const rows = await this.db.select().from(seempMeasures).orderBy(asc(seempMeasures.legacyOrder));
    return rows.map((row) => ({
      code: row.code,
      name: row.name,
      category: row.category,
      legacyOrder: row.legacyOrder,
      methodId: row.methodId,
      reduction: ReductionSchema.parse(row.reduction),
      cost: CostSchema.parse(row.cost),
      source: row.source,
    }));
  }
}
