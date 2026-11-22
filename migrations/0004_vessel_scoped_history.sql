-- 0004_vessel_scoped_history — the emission history follows the vessel, not
-- the MMSI (docs/PLATFORM_SPEC.md §8.5: CII/emission data are tenant-private).
--
-- Until 0.1.0 the CII sums, the manual records and every read were keyed by
-- MMSI only, so the next vessel registered under a re-used MMSI (possibly of
-- another organization) inherited the previous vessel's segments, CII, SEEMP
-- baseline and DCS, and a vessel whose MMSI changed lost its history. Reads
-- are now filtered by vessel_id; 0005 rebuilds the CII aggregates per vessel.

-- Manual / imported annual CII per vessel-year.
ALTER TABLE cii_annual_manual ADD COLUMN vessel_id uuid;
UPDATE cii_annual_manual AS m
   SET vessel_id = p.vessel_id
  FROM vessel_profiles AS p
 WHERE p.mmsi = m.mmsi;
-- A record of an MMSI that no vessel holds cannot be attributed to a vessel:
-- attaching it to the next holder of the MMSI is the leak closed here. Such
-- records were unreachable through the API already (404 VESSEL_NOT_FOUND).
DELETE FROM cii_annual_manual WHERE vessel_id IS NULL;
ALTER TABLE cii_annual_manual ALTER COLUMN vessel_id SET NOT NULL;
ALTER TABLE cii_annual_manual DROP CONSTRAINT cii_annual_manual_pkey;
ALTER TABLE cii_annual_manual ADD PRIMARY KEY (vessel_id, year);
COMMENT ON COLUMN cii_annual_manual.mmsi IS 'MMSI of the vessel when the record was written (informational)';

-- Reads of one vessel's segments (pages, DCS totals, latest segment, recomputation).
CREATE INDEX segments_vessel_time_idx ON segments (vessel_id, time_start DESC);
-- Compressed batches per vessel (and MMSI), so that reads of a vessel's past
-- years never decompress other vessels' data. Chunks compressed before this
-- migration keep their settings (TimescaleDB applies new settings to future
-- compressions).
ALTER TABLE segments SET (
  timescaledb.compress_segmentby = 'vessel_id, mmsi',
  timescaledb.compress_orderby = 'time_start DESC'
);

-- Recomputations: the vessel whose segments are rebuilt, and a heartbeat
-- written while the job runs (a running job with a stale heartbeat was
-- interrupted and is marked failed).
ALTER TABLE recompute_jobs ADD COLUMN vessel_id uuid;
ALTER TABLE recompute_jobs ADD COLUMN heartbeat_at timestamptz NOT NULL DEFAULT now();
