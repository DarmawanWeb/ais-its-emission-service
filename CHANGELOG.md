# Changelog

All notable changes to `ais-its-emission-service` are documented in this file. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the service adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed

- The emission history follows the vessel, not the MMSI (spec §8.5): migrations
  `0004_vessel_scoped_history` (`cii_annual_manual` keyed by `(vessel_id, year)`, segment index
  and compression by `vessel_id, mmsi`, job heartbeat) and `0005_cii_aggregates_per_vessel`
  (`cii_daily` / `cii_annual` grouped by `vessel_id`, materialized over the whole history once).
  Every read filters by the vessel that holds the MMSI now; manual records of an MMSI without a
  vessel are dropped by the migration (they could not be attributed), and records written by
  0.1.0 are attributed to the vessel holding their MMSI at upgrade time (0.1.0 did not record the
  vessel). Migration 0005 materializes the history before it adds the refresh policies, so a
  policy job starting at once cannot reject the migration's refresh as concurrent. Tested as an
  upgrade of a 0.1.0 database with chunks compressed under the old settings (TimescaleDB 2.32).
- `GET /cii/fleet/summary` paginates `items` (`page`, `pageSize` ≤ 100, `meta`); the grade
  distribution still covers the whole fleet, and only the rating fields of the snapshots are read.
- The year-end projection rates the linearly projected totals (attained, rating and grade equal
  the year-to-date values) instead of extrapolating the trend of the cumulative ratio.
- The `cii.recompute` audit record targets the vessel id with the vessel's organization (MMSI in
  `meta`), like the other vessel audits.
- New variable `TELEMETRY_MAX_PERIOD_H` (default 24, 1–744, aligned with the telemetry service)
  replaces the fixed 24 h bound of the search for overlapping period readings.

### Fixed

- A recomputation deletes segments only after a complete replay (not after a shutdown, a
  cancellation or an early end of the replay), only rows computed before the job between the first
  and the last rebuilt segment of the job's vessel, never live segments written meanwhile, and
  nothing when the stream holds no position of the range; `to` may not be in the future.
- Interrupted recomputations no longer block the vessel: running jobs write a heartbeat, jobs
  without one for 60 s are failed at boot and before a new job starts, and a shutting-down
  instance cancels its jobs and records them as failed while the database is still open.
- A position and a fuel reading of the same window no longer race: the builder (also in
  recomputations) and the telemetry attribution read and write under a per-vessel advisory lock,
  with the weather fetched before the lock.
- A stale FLEET snapshot no longer removes the vessel that holds its MMSI now (repository and
  in-memory directory apply the same version rule; projection writers are serialized).
- The overlap search of a fuel reading is bounded below by `SEGMENT_MAX_GAP_MIN` instead of
  scanning (and decompressing) the vessel's whole history; the re-attribution reads the readings
  once and updates the segments in one statement.
- A weather unit test no longer depends on a 200 ms timeout for its success paths.
- A refresh of the CII aggregates that TimescaleDB rejects because it overlaps a refresh in
  progress (a policy job, another replica: SQLSTATE 55P03) is retried briefly; a refresh failure
  after a recomputation no longer marks the (committed) job as failed — the change stays pending.
- Every replica refreshes the CII aggregates once after boot, so the late writes of a replica that
  crashed before refreshing no longer wait for the 10-minute TimescaleDB policy.
- The Docker image no longer ships the test-only optional peers of the kit (`testcontainers` with
  `dockerode` and `ssh2`, `@nestjs/testing`): `.pnpmfile.cjs` drops them from the production
  graph like the compile-time peer `typescript`.

## [0.1.0] - 2026-11-21

### Added

- Voyage segments from `ais.position.recorded.v1` (durable `emission-positions`): legacy
  `calculateSpeed`, fuel by method priority telemetry → first fuel formula → Holtrop–Mennen with
  Open-Meteo weather, navstatus multipliers of the previous fix, CO2 = fuel × C_F; idempotent by
  `(mmsi, time_start)`, gap rule `SEGMENT_MAX_GAP_MIN`, flags (`gap`, `no_fuel_model`,
  `formula_error`, `weather_unavailable`, `fuel_not_finite`, `fuel_negative`,
  `telemetry_reattributed`).
- Safe expression evaluator for the first fuel formula (spec §13.5 grammar, `^` = power),
  bit-identical to JavaScript for valid formulas.
- Telemetry attribution from `fuel.reading.recorded.v1` (durable `emission-fuel`): pro rata of the
  overlap for period readings, once in the containing segment for instantaneous readings,
  re-attribution of stored segments when readings arrive late.
- Weather client (Open-Meteo hourly wind per 0.25° cell and hour) with Valkey cache, 3 s timeout,
  circuit breaker and calm-weather fallback.
- FLEET projection `vessel_profiles` (durable `emission-fleet`) with an in-memory directory.
- CII per calendar year: `segments` hypertable, continuous aggregate `cii_daily` and hierarchical
  `cii_annual` with refresh policies, an application-level rating layer (attained, required,
  rating, grade, boundaries), manual / imported annual records as fallback, `404 CII_NOT_AVAILABLE`
  without data, linear year-end projection, fleet grade distribution, prompt refresh after late
  changes.
- Reduction factors Z seeded from MEPC.338(76) and MEPC.400(83), editable with `reference:write`.
- SEEMP: catalog of the 12 legacy measures, recommendations with the legacy
  `calculateSEEMPbyMMSI` output, what-if simulation (sequential multiplicative combination),
  tenant-private scenarios.
- IMO DCS-style annual summary (JSON and CSV).
- Recomputation of a vessel's segments by replay of `AIS_POSITION` (super_admin).
- Throttled producer of `emission.cii.updated.v1` (`CII_PUBLISH_INTERVAL_S`).
- `GET /api/v2/emission/methodology` and `methodIds` on every CII and SEEMP figure (spec §17).
- Golden unit tests against fixtures produced by the original legacy TypeScript, integration tests
  against TimescaleDB, NATS and Valkey containers.

[Unreleased]: https://github.com/DarmawanWeb/ais-its-emission-service/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/DarmawanWeb/ais-its-emission-service/releases/tag/v0.1.0
