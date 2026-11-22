import type { CiiGrade } from '@darmawanweb/ais-its-contracts/domain';
import { type Database, InjectDb } from '@darmawanweb/ais-its-nest/db';
import { Injectable } from '@nestjs/common';
import { and, asc, eq, inArray, sql } from 'drizzle-orm';

import * as schema from '../../db/schema.js';

const { ciiAnnualManual } = schema;

/** A manual / imported annual CII record of a vessel-year. */
export interface AnnualManualRecord {
  readonly vesselId: string;
  /** MMSI of the vessel when the record was written (informational). */
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
export type AnnualManualInput = Omit<
  AnnualManualRecord,
  'vesselId' | 'mmsi' | 'year' | 'updatedAt'
>;

/**
 * Drizzle access to `cii_annual_manual`, keyed by vessel and year (a re-used
 * MMSI never exposes the previous vessel's records, spec §8.5).
 */
@Injectable()
export class AnnualManualRepository {
  constructor(@InjectDb() private readonly db: Database<typeof schema>) {}

  async find(
    vesselId: string,
    year: number,
  ): Promise<AnnualManualRecord | undefined> {
    const [row] = await this.db
      .select()
      .from(ciiAnnualManual)
      .where(
        and(
          eq(ciiAnnualManual.vesselId, vesselId),
          eq(ciiAnnualManual.year, year),
        ),
      )
      .limit(1);
    return row === undefined ? undefined : toRecord(row);
  }

  async listByVessel(vesselId: string): Promise<AnnualManualRecord[]> {
    const rows = await this.db
      .select()
      .from(ciiAnnualManual)
      .where(eq(ciiAnnualManual.vesselId, vesselId))
      .orderBy(asc(ciiAnnualManual.year));
    return rows.map(toRecord);
  }

  async listByVessels(
    vesselIds: readonly string[],
    year: number,
  ): Promise<AnnualManualRecord[]> {
    if (vesselIds.length === 0) return [];
    const rows = await this.db
      .select()
      .from(ciiAnnualManual)
      .where(
        and(
          eq(ciiAnnualManual.year, year),
          inArray(ciiAnnualManual.vesselId, [...vesselIds]),
        ),
      );
    return rows.map(toRecord);
  }

  /** Inserts or replaces the record of a vessel-year. */
  async upsert(
    vessel: { readonly vesselId: string; readonly mmsi: number },
    year: number,
    input: AnnualManualInput,
  ): Promise<AnnualManualRecord> {
    const values = {
      vesselId: vessel.vesselId,
      mmsi: vessel.mmsi,
      year,
      ...input,
    };
    const [row] = await this.db
      .insert(ciiAnnualManual)
      .values(values)
      .onConflictDoUpdate({
        target: [ciiAnnualManual.vesselId, ciiAnnualManual.year],
        set: { ...input, mmsi: vessel.mmsi, updatedAt: sql`now()` },
      })
      .returning();
    if (row === undefined)
      throw new Error('INSERT … RETURNING returned no row');
    return toRecord(row);
  }
}

function toRecord(
  row: typeof ciiAnnualManual.$inferSelect,
): AnnualManualRecord {
  return {
    vesselId: row.vesselId,
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
