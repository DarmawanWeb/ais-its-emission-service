import type { VesselSnapshotV1 } from '@darmawanweb/ais-its-contracts/events';
import {
  type Database,
  InjectDb,
  InjectPool,
  type Pool,
  withTransaction,
} from '@darmawanweb/ais-its-nest/db';
import { Injectable } from '@nestjs/common';
import { and, eq, inArray, type SQL, sql } from 'drizzle-orm';

import * as schema from '../../db/schema.js';
import type { OrgScope } from '../../common/tenancy.js';
import type { VesselProfile } from './vessel-profile.js';

const { vesselProfiles } = schema;

/** Version of a stored profile. */
export interface ProfileVersion {
  readonly vesselId: string;
  readonly mmsi: number;
  readonly snapshotUpdatedAt: Date;
}

/** Outcome of applying a snapshot. */
export type UpsertOutcome = 'inserted' | 'updated' | 'stale';

/** Drizzle access to `vessel_profiles` (FLEET projection). */
@Injectable()
export class VesselProfilesRepository {
  constructor(
    @InjectDb() private readonly db: Database<typeof schema>,
    @InjectPool() private readonly pool: Pool,
  ) {}

  /**
   * Stores a snapshot unless a newer one (by `updatedAt`) is stored already;
   * a different vessel holding the same MMSI (re-assigned MMSI) is removed in
   * the same transaction.
   */
  async upsert(snapshot: VesselSnapshotV1): Promise<UpsertOutcome> {
    return withTransaction(this.pool, async (client) => {
      await client.query(
        'DELETE FROM vessel_profiles WHERE mmsi = $1 AND vessel_id <> $2',
        [snapshot.mmsi, snapshot.id],
      );
      const result = await client.query<{ inserted: boolean }>(
        `INSERT INTO vessel_profiles (vessel_id, mmsi, org_id, snapshot, snapshot_updated_at)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (vessel_id) DO UPDATE SET
           mmsi = EXCLUDED.mmsi, org_id = EXCLUDED.org_id, snapshot = EXCLUDED.snapshot,
           snapshot_updated_at = EXCLUDED.snapshot_updated_at, updated_at = now()
         WHERE vessel_profiles.snapshot_updated_at <= EXCLUDED.snapshot_updated_at
         RETURNING (xmax = 0) AS inserted`,
        [
          snapshot.id,
          snapshot.mmsi,
          snapshot.orgId,
          JSON.stringify(snapshot),
          new Date(snapshot.updatedAt),
        ],
      );
      const row = result.rows[0];
      if (row === undefined) return 'stale';
      return row.inserted ? 'inserted' : 'updated';
    });
  }

  /** Removes a deleted vessel; `true` when a row was removed. */
  async delete(vesselId: string): Promise<boolean> {
    const rows = await this.db
      .delete(vesselProfiles)
      .where(eq(vesselProfiles.vesselId, vesselId))
      .returning({ vesselId: vesselProfiles.vesselId });
    return rows.length > 0;
  }

  async findByMmsi(mmsi: number): Promise<VesselProfile | undefined> {
    const [row] = await this.db
      .select()
      .from(vesselProfiles)
      .where(eq(vesselProfiles.mmsi, mmsi))
      .limit(1);
    return row === undefined ? undefined : toProfile(row);
  }

  async findByVesselIds(
    vesselIds: readonly string[],
  ): Promise<VesselProfile[]> {
    if (vesselIds.length === 0) return [];
    const rows = await this.db
      .select()
      .from(vesselProfiles)
      .where(inArray(vesselProfiles.vesselId, [...vesselIds]));
    return rows.map(toProfile);
  }

  /** Versions of every stored profile (cheap; used to refresh in-memory caches). */
  async versions(): Promise<ProfileVersion[]> {
    return this.db
      .select({
        vesselId: vesselProfiles.vesselId,
        mmsi: vesselProfiles.mmsi,
        snapshotUpdatedAt: vesselProfiles.snapshotUpdatedAt,
      })
      .from(vesselProfiles);
  }

  /** Profiles visible in a scope (fleet summary), ordered by MMSI. */
  async list(scope: OrgScope, orgId?: string): Promise<VesselProfile[]> {
    const conditions: (SQL | undefined)[] = [
      scope.kind === 'all'
        ? undefined
        : scope.orgId === null
          ? sql`false`
          : eq(vesselProfiles.orgId, scope.orgId),
      orgId === undefined ? undefined : eq(vesselProfiles.orgId, orgId),
    ];
    const rows = await this.db
      .select()
      .from(vesselProfiles)
      .where(and(...conditions))
      .orderBy(vesselProfiles.mmsi);
    return rows.map(toProfile);
  }

  /** Distinct vessel types of the projection (latest snapshot per type id). */
  async vesselTypes(): Promise<VesselSnapshotV1['type'][]> {
    const result = await this.pool.query<{ type: VesselSnapshotV1['type'] }>(
      `SELECT DISTINCT ON (snapshot->'type'->>'id') snapshot->'type' AS type
         FROM vessel_profiles
        ORDER BY snapshot->'type'->>'id', snapshot_updated_at DESC`,
    );
    return result.rows.map((row) => row.type);
  }
}

function toProfile(row: typeof vesselProfiles.$inferSelect): VesselProfile {
  return {
    vesselId: row.vesselId,
    mmsi: row.mmsi,
    orgId: row.orgId,
    snapshot: row.snapshot,
    snapshotUpdatedAt: row.snapshotUpdatedAt,
  };
}
