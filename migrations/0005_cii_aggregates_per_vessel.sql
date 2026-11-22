-- aisits:no-transaction
-- 0005_cii_aggregates_per_vessel — cii_daily and cii_annual grouped by
-- vessel_id instead of mmsi (see 0004_vessel_scoped_history). The aggregates
-- are dropped and rebuilt with the same sums and refresh policies as
-- 0003_cii_aggregates, and materialized over the whole history once: the
-- policies only refresh the last 400 days (daily) and 3 years (annual), and
-- older buckets below the watermark would otherwise be missing.
-- The history is materialized BEFORE the policies exist: a policy job starts
-- at once in a background worker, and TimescaleDB rejects a refresh that
-- overlaps a running one ("due to a concurrent refresh", SQLSTATE 55P03).
-- Statements run one by one (continuous aggregates refuse transactions); the
-- leading DROPs make a re-run after a partial failure start from scratch.

DROP MATERIALIZED VIEW IF EXISTS cii_annual;

DROP MATERIALIZED VIEW IF EXISTS cii_daily;

CREATE MATERIALIZED VIEW cii_daily
WITH (timescaledb.continuous, timescaledb.materialized_only = false) AS
SELECT
  time_bucket(INTERVAL '1 day', time_start) AS day,
  vessel_id,
  coalesce(sum(distance_nm) FILTER (WHERE method <> 'none'), 0) AS distance_nm,
  coalesce(sum(fuel_me_ton) FILTER (WHERE method <> 'none'), 0) AS fuel_me_ton,
  coalesce(sum(fuel_ae_ton) FILTER (WHERE method <> 'none'), 0) AS fuel_ae_ton,
  coalesce(sum(co2_ton) FILTER (WHERE method <> 'none'), 0) AS co2_ton,
  count(*) FILTER (WHERE method <> 'none') AS segments,
  count(*) FILTER (WHERE method = 'telemetry') AS telemetry_segments,
  count(*) FILTER (WHERE method = 'first_formula') AS first_formula_segments,
  count(*) FILTER (WHERE method = 'holtrop') AS holtrop_segments,
  count(*) FILTER (WHERE method = 'none') AS excluded_segments,
  max(time_end) FILTER (WHERE method <> 'none') AS last_time
FROM segments
GROUP BY 1, 2
WITH NO DATA;

CREATE MATERIALIZED VIEW cii_annual
WITH (timescaledb.continuous, timescaledb.materialized_only = false) AS
SELECT
  time_bucket(INTERVAL '1 year', day) AS year,
  vessel_id,
  sum(distance_nm) AS distance_nm,
  sum(fuel_me_ton) AS fuel_me_ton,
  sum(fuel_ae_ton) AS fuel_ae_ton,
  sum(co2_ton) AS co2_ton,
  sum(segments) AS segments,
  sum(telemetry_segments) AS telemetry_segments,
  sum(first_formula_segments) AS first_formula_segments,
  sum(holtrop_segments) AS holtrop_segments,
  sum(excluded_segments) AS excluded_segments,
  max(last_time) AS last_time
FROM cii_daily
GROUP BY 1, 2
WITH NO DATA;

-- The whole history up to the current day / year (later buckets are real-time).
CALL refresh_continuous_aggregate('cii_daily', NULL, date_trunc('day', now(), 'UTC'));

CALL refresh_continuous_aggregate('cii_annual', NULL, date_trunc('year', now(), 'UTC'));

-- Then the policies of 0003_cii_aggregates.
SELECT add_continuous_aggregate_policy('cii_daily',
  start_offset => INTERVAL '400 days',
  end_offset => INTERVAL '1 hour',
  schedule_interval => INTERVAL '10 minutes');

SELECT add_continuous_aggregate_policy('cii_annual',
  start_offset => INTERVAL '3 years',
  end_offset => INTERVAL '1 day',
  schedule_interval => INTERVAL '1 hour');
