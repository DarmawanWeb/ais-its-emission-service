# Changelog

All notable changes to `ais-its-emission-service` are documented in this file. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the service adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.2.0] - 2026-11-23

Upgrade to `@darmawanweb/ais-its-contracts` 0.4.0 and `@darmawanweb/ais-its-nest` 0.3.0, the
backend additions requested by the web app, and the hardening of 0.1.x (vessel-scoped history).

**Rolling update** (README, Operations). From the 0.1.0 release (migrations 0001–0003) replicas of
both versions cannot run side by side: the first 0.2.0 replica applies migrations `0004` and
`0005` at boot, after which 0.1.0 replicas fail (they read `cii_daily` / `cii_annual` by `mmsi` and
upsert manual records on `(mmsi, year)`); stop them first, and keep the pre-upgrade database backup
for a rollback (forward-only migrations). From a `main` build that already applied `0005` (it
reports `0.1.0`), 0.2.0 adds no migration, mixed replicas share the tables, subjects and durables,
and a rollback is safe, but only 0.2.0 answers the new API: an older replica answers the new query
parameters with `400 VALIDATION_FAILED`, the new routes with `404 NOT_FOUND` and a segment request
with `Accept: text/csv` with JSON. Finish the emission rollout before deploying a web app that uses
the new parameters and routes; during the rollout the web app must map both
`403 SUPER_ADMIN_REQUIRED` and `403 PLATFORM_ADMIN_REQUIRED` of the recomputation routes.

### Added

- `GET /cii/fleet/fuel?year&month&orgId` [cii:read]: fuel (ME, AE, total) and CO2 of the fleet in a
  calendar year and one of its months, with the vessels counted and the manual-record fallback of
  the year (replaces up to 50 `…/daily` requests of the dashboard).
- `GET /cii/fleet/summary`: `grade` (e.g. `D,E`), `search` (name, MMSI / IMO prefix) and signed
  `sort` (`mmsi`, `name`, `grade`, `rating`, `attained`, `-` = descending) on `items` and
  `meta.total`; items carry `typeCode`, `imo`, `required`, `zPercent` and `previousYear`
  `{ source, rating, grade }` (the distribution still covers the whole fleet).
- `DELETE /cii/vessels/:mmsi/annual-manual/:year` [vessel:write], audited
  `cii_annual_manual.delete`.
- `GET /cii/recompute-jobs?mmsi&status&cursor&limit` [super_admin]: every job, newest first.
- `DELETE /reduction-factors/:year` [reference:write], audited `reduction_factor.delete`: only an
  unused first or last year (`404 REDUCTION_FACTOR_NOT_FOUND`, `409 REDUCTION_FACTOR_IN_USE`,
  `409 REDUCTION_FACTOR_TABLE_GAP`). The check locks `reduction_factors` only: a segment or manual
  record of the year written at the same moment, or later for a year about to receive data (the
  next calendar year at New Year), leaves its CII at `422 REDUCTION_FACTOR_MISSING` until the year
  is added again with `PUT` (README, Known limitations).
- SEEMP: `includeAll=true` on the recommendations (every measure, `recommended` flag),
  `baselineCo2Ton` on recommendations and simulations, `co2AvoidedTon` and `costPerTonneUsd` on
  simulations, `vesselName` on scenarios, `search` and signed `sort` on the scenario list, and
  `PATCH /seemp/scenarios/:id` (rename, audited `seemp_scenario.update`); scenarios expose
  `updatedAt`. A scenario's `result` stays the simulation response stored at creation time
  (`SeempScenarioResultDto` in OpenAPI): scenarios saved before 0.2.0 (or by a 0.1.x replica during
  the rollout) lack `vessel`, `baselineCo2Ton`, `co2AvoidedTon` and `costPerTonneUsd`, which are
  optional there (not backfilled).
- Vessel identity (`vessel { vesselId, mmsi, imo, name, flag, typeCode, typeName }`) in
  `CiiSummaryDto`, `AnnualCiiDto` and the SEEMP recommendation / simulation responses.
- `GET /cii/vessels/:mmsi/segments`: `method` and `flag` filters and a CSV export of the range with
  `Accept: text/csv` (oldest first, ≤ 50 000 rows, `X-Truncated`).
- The JSON / CSV routes (segments, vessel and fleet DCS) answer `Vary: Origin, Accept` in both
  representations, and OpenAPI documents their CSV as a `text/csv` string (header line as the
  example) with `Content-Disposition` (and `X-Truncated`), apart from the JSON schema.
- `GET /emission/fleet/dcs?year&orgId`: the DCS summaries of every vessel of the fleet (JSON with
  `withoutData`, or one CSV in the per-vessel layout).
- CORS exposes `Content-Disposition` and `X-Truncated` besides the kit's defaults.

### Changed

- Contracts 0.4.0 / kit 0.3.0. The consumers use the exact contracts envelopes (exhaustive switches,
  no runtime type checks); the recomputation trusts `ReplayReport.completed` / `endedBy` (results
  are written only after a complete replay); the aggregate refresher uses the kit's
  `refreshContinuousAggregate` (55P03 retries with jittered backoff, no statement timeout for the
  400-day window); unique violations come from the kit's `isUniqueViolation`; metric types from
  `@darmawanweb/ais-its-nest/metrics`; migrations are resolved from the package
  (`MIGRATIONS_DIR`), not from the working directory.
- The first fuel formula is evaluated with the contracts grammar (`parseFuelFormula` once per
  profile, `evaluateFuelFormula`), the one fleet validates with: values are bit-identical (golden
  tests unchanged); limits are 500 characters, depth 32 and finite literals (no stored formula is
  affected), and refusal messages follow the contracts (e.g. `pow() takes 2 arguments, got 1 at
position 0`).
- Path parameters use the kit's `@MmsiParam()`, `@IntParam()` and `@UuidParam()`: a malformed UUID
  is now `400 VALIDATION_FAILED` with `field: "id"` (was a bare `400`), and an MMSI with a leading
  zero (`0525005223`) is refused (`code: isMmsi`).
- **Breaking for clients:** the recomputation routes use the kit's `@RequirePlatformAdmin()` and
  answer `403 PLATFORM_ADMIN_REQUIRED` (spec §5) instead of `403 SUPER_ADMIN_REQUIRED`; OpenAPI
  shows `x-required-roles: ["super_admin"]`.
- `year` / `targetYear` of the SEEMP simulation and scenario bodies reject `null`
  (`IsOptionalNotNull`) instead of passing it to the baseline search.
- The service's own database error logs go through the kit's `sanitizeError`.
- `openapi.json` regenerated (page maximum, parameter schemas, roles).

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

### Removed

- Local workarounds made obsolete by the kit: the runtime event type checks of the position and
  fleet consumers, `src/modules/cii/replay-completeness.ts` (replay completeness heuristic),
  `src/domain/expression/evaluator.ts` (own formula evaluator), `src/db/errors.ts` (template
  leftover), `src/common/pipes.ts` (MMSI / year pipes), the in-handler super_admin check, the
  55P03 retry loop of the refresher and the direct `prom-client` dependency.
- `.pnpmfile.cjs` no longer strips kit peers (kit 0.3 declares no test peers); it strips the
  `@nestjs/terminus` gRPC peers instead, which `dockerode` (testcontainers) would otherwise put
  into the production install.

### Fixed

- `GET /emission/vessels/:mmsi/dcs` keeps the `Vary: Origin` of CORS besides `Accept` (its
  `@Header('vary', 'accept')` replaced it), and OpenAPI no longer declares its CSV body as
  `DcsSummaryDto`.
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

[Unreleased]: https://github.com/DarmawanWeb/ais-its-emission-service/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/DarmawanWeb/ais-its-emission-service/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/DarmawanWeb/ais-its-emission-service/releases/tag/v0.1.0
