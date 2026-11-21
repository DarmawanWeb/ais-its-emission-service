import { InjectPool, type Pool } from '@darmawanweb/ais-its-nest/db';
import { Injectable } from '@nestjs/common';

/**
 * Throttle state of `emission.cii.updated.v1` (`cii_publication`): vessels
 * are marked dirty when their segments change; a poller claims the vessels
 * whose last publication is older than the interval (shared by replicas).
 */
@Injectable()
export class CiiPublicationRepository {
  constructor(@InjectPool() private readonly pool: Pool) {}

  /** Marks a vessel as having an unpublished CII change (keeps the oldest mark). */
  async markDirty(mmsi: number): Promise<void> {
    await this.pool.query(
      `INSERT INTO cii_publication (mmsi, dirty_since) VALUES ($1, now())
       ON CONFLICT (mmsi) DO UPDATE SET dirty_since = coalesce(cii_publication.dirty_since, now())`,
      [mmsi],
    );
  }

  /** Marks every vessel with segments as dirty (e.g. after a reduction factor change). */
  async markAllDirty(): Promise<number> {
    const result = await this.pool.query('UPDATE cii_publication SET dirty_since = coalesce(dirty_since, now())');
    return result.rowCount ?? 0;
  }

  /**
   * Claims up to `limit` dirty vessels not published for `intervalSeconds`:
   * sets their publication time to now and clears the mark atomically
   * (`FOR UPDATE SKIP LOCKED`, safe with several replicas).
   */
  async claimDue(intervalSeconds: number, limit: number): Promise<number[]> {
    const result = await this.pool.query<{ mmsi: number }>(
      `WITH due AS (
         SELECT mmsi FROM cii_publication
          WHERE dirty_since IS NOT NULL
            AND (last_published_at IS NULL OR last_published_at <= now() - make_interval(secs => $1))
          ORDER BY dirty_since
          LIMIT $2
          FOR UPDATE SKIP LOCKED)
       UPDATE cii_publication p SET last_published_at = now(), dirty_since = NULL
         FROM due WHERE p.mmsi = due.mmsi
       RETURNING p.mmsi`,
      [intervalSeconds, limit],
    );
    return result.rows.map((row) => row.mmsi);
  }

  /** Records the published year, or marks the vessel dirty again after a failed publication. */
  async settle(mmsi: number, outcome: { readonly year: number } | 'failed'): Promise<void> {
    if (outcome === 'failed') {
      await this.pool.query('UPDATE cii_publication SET dirty_since = coalesce(dirty_since, now()) WHERE mmsi = $1', [mmsi]);
      return;
    }
    await this.pool.query('UPDATE cii_publication SET last_year = $2 WHERE mmsi = $1', [mmsi, outcome.year]);
  }
}
