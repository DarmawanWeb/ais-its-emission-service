-- 0001_init — schema of ais-its-emission-service (docs/PLATFORM_SPEC.md §6, §13.5).
--
-- Runs inside schema "emission" (search_path=emission,public) as the role
-- emission_svc, in one transaction. The infrastructure creates the extensions
-- (timescaledb, postgis, pgcrypto) in "public"; services never CREATE EXTENSION.
-- Migrations are forward-only: once applied anywhere, never edit this file
-- (its checksum is verified at startup) — add a new numbered file instead.

COMMENT ON SCHEMA emission IS 'emission service (CII, SEEMP, DCS) — owned by emission_svc';

-- Projection of the FLEET stream (consumer emission-fleet): latest vessel snapshot.
CREATE TABLE vessel_profiles (
  vessel_id           uuid PRIMARY KEY,
  mmsi                integer NOT NULL UNIQUE CHECK (mmsi BETWEEN 100000000 AND 999999999),
  org_id              uuid,
  snapshot            jsonb NOT NULL,
  -- VesselSnapshotV1.updatedAt: older snapshots never overwrite newer ones.
  snapshot_updated_at timestamptz NOT NULL,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX vessel_profiles_org_idx ON vessel_profiles (org_id);
COMMENT ON TABLE vessel_profiles IS 'FLEET projection (fleet.vessel.upserted.v1 snapshots)';

-- Telemetry fuel readings (consumer emission-fuel), used for segment attribution.
CREATE TABLE fuel_readings (
  time         timestamptz NOT NULL,
  mmsi         integer NOT NULL CHECK (mmsi BETWEEN 100000000 AND 999999999),
  period_start timestamptz,
  fuel_me_ton  double precision NOT NULL CHECK (fuel_me_ton >= 0),
  fuel_ae_ton  double precision NOT NULL CHECK (fuel_ae_ton >= 0),
  device_id    uuid,
  source       text NOT NULL CHECK (source IN ('device', 'mqtt', 'api', 'manual', 'import')),
  received_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (mmsi, time)
);
SELECT create_hypertable('fuel_readings', by_range('time', INTERVAL '7 days'));
ALTER TABLE fuel_readings SET (
  timescaledb.compress,
  timescaledb.compress_segmentby = 'mmsi',
  timescaledb.compress_orderby = 'time DESC'
);
SELECT add_compression_policy('fuel_readings', INTERVAL '14 days');
SELECT add_retention_policy('fuel_readings', INTERVAL '400 days');

-- Voyage segments previous → current position (consumer emission-positions).
CREATE TABLE segments (
  time_start        timestamptz NOT NULL,
  time_end          timestamptz NOT NULL,
  mmsi              integer NOT NULL CHECK (mmsi BETWEEN 100000000 AND 999999999),
  vessel_id         uuid NOT NULL,
  distance_nm       double precision NOT NULL CHECK (distance_nm >= 0),
  speed_kn          double precision NOT NULL CHECK (speed_kn >= 0),
  fuel_me_ton       double precision NOT NULL CHECK (fuel_me_ton >= 0),
  fuel_ae_ton       double precision NOT NULL CHECK (fuel_ae_ton >= 0),
  co2_ton           double precision NOT NULL CHECK (co2_ton >= 0),
  -- 'none' = not counted in the CII sums (gap, no fuel model, non-finite result).
  method            text NOT NULL CHECK (method IN ('telemetry', 'first_formula', 'holtrop', 'none')),
  -- Reported navstatus of the previous fix (fuel multipliers).
  navstatus         smallint NOT NULL CHECK (navstatus BETWEEN 0 AND 15),
  fuel_code         text NOT NULL,
  conversion_factor double precision NOT NULL CHECK (conversion_factor > 0),
  weather           jsonb,
  flags             text[] NOT NULL DEFAULT '{}',
  computed_at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (mmsi, time_start),
  CHECK (time_end > time_start)
);
SELECT create_hypertable('segments', by_range('time_start', INTERVAL '7 days'));
ALTER TABLE segments SET (
  timescaledb.compress,
  timescaledb.compress_segmentby = 'mmsi',
  timescaledb.compress_orderby = 'time_start DESC'
);
SELECT add_compression_policy('segments', INTERVAL '30 days');
SELECT add_retention_policy('segments', INTERVAL '6 years');
COMMENT ON TABLE segments IS 'Fuel and CO2 per voyage segment (spec 13.5)';

-- Reduction factor Z per year (MEPC.338(76), MEPC.400(83)); seeded in 0002.
CREATE TABLE reduction_factors (
  year       integer PRIMARY KEY CHECK (year BETWEEN 2019 AND 2100),
  z_percent  double precision NOT NULL CHECK (z_percent >= 0 AND z_percent < 100),
  source     text NOT NULL CHECK (char_length(source) BETWEEN 1 AND 500),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Annual CII entered manually or imported from the MVP; used for years without segments.
CREATE TABLE cii_annual_manual (
  mmsi        integer NOT NULL CHECK (mmsi BETWEEN 100000000 AND 999999999),
  year        integer NOT NULL CHECK (year BETWEEN 2000 AND 2200),
  attained    double precision NOT NULL CHECK (attained >= 0),
  required    double precision CHECK (required > 0),
  rating      double precision CHECK (rating >= 0),
  grade       text CHECK (grade IN ('A', 'B', 'C', 'D', 'E')),
  distance_nm double precision NOT NULL CHECK (distance_nm >= 0),
  fuel_me_ton double precision NOT NULL CHECK (fuel_me_ton >= 0),
  fuel_ae_ton double precision NOT NULL CHECK (fuel_ae_ton >= 0),
  co2_ton     double precision CHECK (co2_ton >= 0),
  note        text CHECK (char_length(note) <= 2000),
  updated_by  uuid,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (mmsi, year)
);

-- Catalog of the SEEMP measures (legacy recommender); seeded in 0002.
CREATE TABLE seemp_measures (
  code         text PRIMARY KEY CHECK (code ~ '^[a-z][a-z0-9_]*$'),
  name         text NOT NULL,
  category     text NOT NULL CHECK (category IN ('technical', 'operational', 'fuel', 'energy')),
  legacy_order integer NOT NULL UNIQUE,
  method_id    text NOT NULL,
  reduction    jsonb NOT NULL,
  cost         jsonb NOT NULL,
  source       text NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);

-- Saved what-if simulations (tenant-private: org of the vessel).
CREATE TABLE seemp_scenarios (
  id            uuid PRIMARY KEY,
  org_id        uuid,
  mmsi          integer NOT NULL CHECK (mmsi BETWEEN 100000000 AND 999999999),
  vessel_id     uuid NOT NULL,
  name          text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 120),
  measure_codes text[] NOT NULL CHECK (cardinality(measure_codes) BETWEEN 1 AND 12),
  baseline_year integer NOT NULL,
  target_year   integer NOT NULL,
  result        jsonb NOT NULL,
  created_by    uuid NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX seemp_scenarios_org_created_idx ON seemp_scenarios (org_id, created_at DESC, id DESC);
CREATE INDEX seemp_scenarios_mmsi_idx ON seemp_scenarios (mmsi);

-- Throttle state of emission.cii.updated.v1 per vessel (CII_PUBLISH_INTERVAL_S).
CREATE TABLE cii_publication (
  mmsi              integer PRIMARY KEY CHECK (mmsi BETWEEN 100000000 AND 999999999),
  dirty_since       timestamptz,
  last_published_at timestamptz,
  last_year         integer
);
CREATE INDEX cii_publication_dirty_idx ON cii_publication (dirty_since) WHERE dirty_since IS NOT NULL;

-- Recomputations by replay of AIS_POSITION (POST /cii/vessels/:mmsi/recompute).
CREATE TABLE recompute_jobs (
  id           uuid PRIMARY KEY,
  mmsi         integer NOT NULL CHECK (mmsi BETWEEN 100000000 AND 999999999),
  from_time    timestamptz NOT NULL,
  to_time      timestamptz NOT NULL,
  status       text NOT NULL CHECK (status IN ('running', 'succeeded', 'failed')),
  requested_by uuid,
  replayed     integer NOT NULL DEFAULT 0,
  segments     integer NOT NULL DEFAULT 0,
  deleted      integer NOT NULL DEFAULT 0,
  error        text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  finished_at  timestamptz,
  CHECK (to_time > from_time)
);
-- One running recomputation per vessel.
CREATE UNIQUE INDEX recompute_jobs_running_idx ON recompute_jobs (mmsi) WHERE status = 'running';
