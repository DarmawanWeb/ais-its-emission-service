-- aisits:no-transaction
-- 0003_cii_aggregates — daily and annual CII sums (spec 13.5): continuous
-- aggregate cii_daily on segments and the hierarchical cii_annual on cii_daily.
-- Real-time (materialized_only = false): rows newer than the last refresh come
-- from the source. The rating (attained/required/grade) is computed in the
-- application from these sums, the vessel profile and reduction_factors.
-- Only counted segments (method <> 'none') enter the sums.

CREATE MATERIALIZED VIEW cii_daily
WITH (timescaledb.continuous, timescaledb.materialized_only = false) AS
SELECT
  time_bucket(INTERVAL '1 day', time_start) AS day,
  mmsi,
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

SELECT add_continuous_aggregate_policy('cii_daily',
  start_offset => INTERVAL '400 days',
  end_offset => INTERVAL '1 hour',
  schedule_interval => INTERVAL '10 minutes');

CREATE MATERIALIZED VIEW cii_annual
WITH (timescaledb.continuous, timescaledb.materialized_only = false) AS
SELECT
  time_bucket(INTERVAL '1 year', day) AS year,
  mmsi,
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

SELECT add_continuous_aggregate_policy('cii_annual',
  start_offset => INTERVAL '3 years',
  end_offset => INTERVAL '1 day',
  schedule_interval => INTERVAL '1 hour');
