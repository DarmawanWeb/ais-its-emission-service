# Changelog

All notable changes to `ais-its-emission-service` are documented in this file. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the service adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
