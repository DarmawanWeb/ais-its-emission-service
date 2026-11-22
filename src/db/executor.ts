import type { ExtractTablesWithRelations } from 'drizzle-orm';
import { sql } from 'drizzle-orm';
import type { NodePgQueryResultHKT } from 'drizzle-orm/node-postgres';
import type { PgDatabase } from 'drizzle-orm/pg-core';

import type * as schema from './schema.js';

/**
 * Runs drizzle queries of the service schema: the injected database or a
 * transaction (`db.transaction(async (tx) => …)`). Repository methods that
 * may take part in a transaction accept one, defaulting to the database.
 */
export type Executor = PgDatabase<
  NodePgQueryResultHKT,
  typeof schema,
  ExtractTablesWithRelations<typeof schema>
>;

/**
 * Takes the transaction-scoped advisory lock that serializes the writers of
 * one vessel's segments: the segment builder (live and recomputation) and the
 * telemetry attribution read the readings and write the segments of an MMSI
 * under this lock, so a reading stored while a segment of the same window is
 * being built is always seen by one of them. Released at commit / rollback.
 * Two-key form: (`hashtext('emission.segments')`, MMSI); an MMSI fits int4.
 */
export async function lockVesselSegments(
  tx: Executor,
  mmsi: number,
): Promise<void> {
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtext('emission.segments'), ${mmsi}::int)`,
  );
}
