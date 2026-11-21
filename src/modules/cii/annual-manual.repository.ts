import type { CiiGrade } from '@darmawanweb/ais-its-contracts/domain';
import { type Database, InjectDb } from '@darmawanweb/ais-its-nest/db';
import { Injectable } from '@nestjs/common';
import { and, asc, eq, sql } from 'drizzle-orm';

import * as schema from '../../db/schema.js';

const { ciiAnnualManual } = schema;

/** A manual / imported annual CII record. */
export interface AnnualManualRecord {
  readonly mmsi: number;
  readonly year: number;
  readonly attained: number;
  readonly required: number | null;
  readonly rating: number | null;
  readonly grade: CiiGrade | null;
  readonly distanceNm: number;
  readonly fuelMeTon: number;
  readonly fuelAeTon: number;
  readonly co2Ton: number | null;
  readonly note: string | null;
  readonly updatedBy: string | null;
  readonly updatedAt: Date;
}

/** Fields of a manual record. */
export type AnnualManualInput = Omit<AnnualManualRecord, 'mmsi' | 'year' | 'updatedAt'>;

/** Drizzle access to `cii_annual_manual`. */
@Injectable()
export class AnnualManualRepository {
  constructor(@InjectDb() private readonly db: Database<typeof schema>) {}

  async find(mmsi: number, year: number): Promise<AnnualManualRecord | undefined> {
    const [row] = await this.db
      .select()
      .from(ciiAnnualManual)
      .where(and(eq(ciiAnnualManual.mmsi, mmsi), eq(ciiAnnualManual.year, year)))
      .limit(1);
    return row === undefined ? undefined : toRecord(row);
  }

  async listByMmsi(mmsi: number): Promise<AnnualManualRecord[]> {
    const rows = await this.db
      .select()
      .from(ciiAnnualManual)
      .where(eq(ciiAnnualManual.mmsi, mmsi))
      .orderBy(asc(ciiAnnualManual.year));
    return rows.map(toRecord);
  }

  async listByMmsis(mmsis: readonly number[], year: number): Promise<AnnualManualRecord[]> {
    if (mmsis.length === 0) return [];
    const rows = await this.db
      .select()
      .from(ciiAnnualManual)
      .where(and(eq(ciiAnnualManual.year, year), sql`${ciiAnnualManual.mmsi} = ANY(${[...mmsis]}::int[])`));
    return rows.map(toRecord);
  }

  /** Inserts or replaces the record of a vessel-year. */
  async upsert(mmsi: number, year: number, input: AnnualManualInput): Promise<AnnualManualRecord> {
    const values = { mmsi, year, ...input };
    const [row] = await this.db
      .insert(ciiAnnualManual)
      .values(values)
      .onConflictDoUpdate({
        target: [ciiAnnualManual.mmsi, ciiAnnualManual.year],
        set: { ...input, updatedAt: sql`now()` },
      })
      .returning();
    if (row === undefined) throw new Error('INSERT … RETURNING returned no row');
    return toRecord(row);
  }
}

function toRecord(row: typeof ciiAnnualManual.$inferSelect): AnnualManualRecord {
  return {
    mmsi: row.mmsi,
    year: row.year,
    attained: row.attained,
    required: row.required,
    rating: row.rating,
    grade: row.grade,
    distanceNm: row.distanceNm,
    fuelMeTon: row.fuelMeTon,
    fuelAeTon: row.fuelAeTon,
    co2Ton: row.co2Ton,
    note: row.note,
    updatedBy: row.updatedBy,
    updatedAt: row.updatedAt,
  };
}
