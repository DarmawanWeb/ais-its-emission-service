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

/** A vessel of the fleet summary with its CII rating inputs. */
export interface FleetRatingRow {
  readonly vesselId: string;
  readonly mmsi: number;
  readonly orgId: string | null;
  readonly name: string;
  /** `snapshot.type` (reference line, d-vector, fixed capacity). */
  readonly type: VesselSnapshotV1['type'];
  /** `snapshot.dimensions.capacity`. */
  readonly capacity: number;
}

/** Drizzle access to `vessel_profiles` (FLEET projection). */
@Injectable()
export class VesselProfilesRepository {
  constructor(
    @InjectDb() private readonly db: Database<typeof schema>,
    @InjectPool() private readonly pool: Pool,
  ) {}

  /**
   * Applies a FLEET snapshot (transaction under a projection-wide advisory
   * lock: FLEET changes are rare, and serialized writers see a consistent
   * table across replicas). Versions are `snapshot.updatedAt`:
   * - `stale` without any side effect when the stored profile of the same
   *   vessel is newer, or when another vessel holds the MMSI with a version
   *   at least as new (its claim is the current one; the snapshot being
   *   applied was superseded by a later one of its vessel, still to come or
   *   already applied);
   * - otherwise another vessel holding the MMSI with an older version lost
   *   it (re-assigned MMSI) and is removed, then the snapshot is stored.
   */
  async upsert(snapshot: VesselSnapshotV1): Promise<UpsertOutcome> {
    const updatedAt = new Date(snapshot.updatedAt);
    return withTransaction(this.pool, async (client) => {
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtext('emission.vessel_profiles'))",
      );
      const { rows } = await client.query<{
        vessel_id: string;
        snapshot_updated_at: Date;
      }>(
        `SELECT vessel_id, snapshot_updated_at FROM vessel_profiles
          WHERE vessel_id = $1 OR mmsi = $2`,
        [snapshot.id, snapshot.mmsi],
      );
      const own = rows.find((row) => row.vessel_id === snapshot.id);
      const holder = rows.find((row) => row.vessel_id !== snapshot.id);
      if (own !== undefined && own.snapshot_updated_at > updatedAt)
        return 'stale';
      if (holder !== undefined && holder.snapshot_updated_at >= updatedAt)
        return 'stale';
      if (holder !== undefined) {
        await client.query('DELETE FROM vessel_profiles WHERE vessel_id = $1', [
          holder.vessel_id,
        ]);
      }
      await client.query(
        `INSERT INTO vessel_profiles (vessel_id, mmsi, org_id, snapshot, snapshot_updated_at)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (vessel_id) DO UPDATE SET
           mmsi = EXCLUDED.mmsi, org_id = EXCLUDED.org_id, snapshot = EXCLUDED.snapshot,
           snapshot_updated_at = EXCLUDED.snapshot_updated_at, updated_at = now()`,
        [
          snapshot.id,
          snapshot.mmsi,
          snapshot.orgId,
          JSON.stringify(snapshot),
          updatedAt,
        ],
      );
      return own === undefined ? 'inserted' : 'updated';
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

  /**
   * The vessels visible in a scope with the snapshot fields the CII rating
   * needs (fleet summary), ordered by MMSI; the snapshots themselves are not
   * loaded.
   */
  async ratingRows(scope: OrgScope, orgId?: string): Promise<FleetRatingRow[]> {
    const conditions: (SQL | undefined)[] = [
      scope.kind === 'all'
        ? undefined
        : scope.orgId === null
          ? sql`false`
          : eq(vesselProfiles.orgId, scope.orgId),
      orgId === undefined ? undefined : eq(vesselProfiles.orgId, orgId),
    ];
    return this.db
      .select({
        vesselId: vesselProfiles.vesselId,
        mmsi: vesselProfiles.mmsi,
        orgId: vesselProfiles.orgId,
        name: sql<string>`${vesselProfiles.snapshot}->>'name'`,
        type: sql<VesselSnapshotV1['type']>`${vesselProfiles.snapshot}->'type'`,
        capacity: sql<number>`(${vesselProfiles.snapshot}->'dimensions'->>'capacity')::double precision`,
      })
      .from(vesselProfiles)
      .where(and(...conditions))
      .orderBy(vesselProfiles.mmsi);
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
