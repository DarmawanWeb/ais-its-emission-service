# ais-its-emission-service

Fuel and CO2 per voyage segment, IMO CII (daily/annual, rating A–E), reduction factors, SEEMP
recommendations and what-if simulation, IMO DCS-style summary.

Service `emission` of **AIS Maritime Intelligence** v2 — the **scientific core of the thesis**:
every formula is a pure, documented TypeScript port of the MVP backend
(`ais-its-cii-seemp-be`, Express + MongoDB) with **numerical parity proven by golden tests** against
the original legacy code. NestJS 12 + Fastify on the platform kit
[`@darmawanweb/ais-its-nest`](https://github.com/DarmawanWeb/ais-its-contracts/tree/main/packages/nest),
PostgreSQL schema `emission` (TimescaleDB), NATS JetStream, Valkey. The normative engineering spec
is [`docs/PLATFORM_SPEC.md`](../../docs/PLATFORM_SPEC.md) §13.5 in the central repository
([`ais-its-platform`](https://github.com/DarmawanWeb/ais-its-platform)).

## Purpose and responsibilities

The service turns the AIS position feed into fuel, CO2 and CII figures and recommends energy
efficiency measures:

- **Voyage segments** — one segment `previous → current` per `ais.position.recorded.v1` of a fleet
  vessel: distance and speed (legacy `calculateSpeed`), fuel by method priority **telemetry →
  first fuel formula → Holtrop–Mennen with weather**, navstatus fuel multipliers, CO2 = fuel × C_F.
- **Telemetry attribution** — fuel readings (`fuel.reading.recorded.v1`) replace the modelled fuel
  of the segments they cover, whenever they arrive.
- **CII** — attained / required / rating / grade per **calendar year** (IMO G1–G4) from TimescaleDB
  continuous aggregates (`cii_daily` → `cii_annual`), daily cumulative curve, linear year-end
  projection, fleet grade distribution, manual / imported annual records for history.
- **Reduction factors Z** (MEPC.338(76), MEPC.400(83)) — seeded, editable by platform admins.
- **SEEMP** — the 12 legacy measures (catalog), recommendations with exact legacy output
  (`calculateSEEMPbyMMSI`), what-if simulation of combined measures, saved scenarios.
- **IMO DCS-style summary** — annual fuel per fuel type, distance, hours under way, CO2 (JSON/CSV).
- **Methodology** — `GET /api/v2/emission/methodology` (spec §17): implemented methods with
  formulas, variables and sources; active reduction factors; vessel type reference-line parameters.
- **Events** — producer of the `EMISSION` stream (`emission.cii.updated.v1`, throttled per vessel).

It owns the schema `emission` only. Vessel master data comes from the `FLEET` stream (local
projection `vessel_profiles`), positions from `AIS_POSITION`, telemetry from `FUEL`. It does not
store AIS positions (the ais-pipeline does) nor raw telemetry beyond what attribution needs.

## Architecture

```mermaid
flowchart LR
  subgraph NATS["NATS JetStream"]
    AISP[("AIS_POSITION<br/>ais.position.v1.&lt;p&gt;.&lt;mmsi&gt;")]
    FUEL[("FUEL<br/>fuel.reading.v1.&lt;mmsi&gt;")]
    FLEET[("FLEET<br/>fleet.vessel.v1.&lt;id&gt;")]
    EMI[("EMISSION<br/>emission.cii.v1.&lt;mmsi&gt;")]
    AUD[("AUDIT<br/>audit.v1.emission")]
  end
  subgraph SVC["emission service"]
    FC["FleetConsumer<br/>(emission-fleet)"] --> DIR["ProfileDirectory<br/>(in-memory MMSI → profile)"]
    PC["PositionsConsumer<br/>(emission-positions)"] --> SB["SegmentBuilder"]
    UC["FuelConsumer<br/>(emission-fuel)"] --> TA["TelemetryAttribution"]
    SB --> DOM["src/domain (pure)<br/>speed · fuel formulas · Holtrop/Kwon<br/>CII · SEEMP · DCS"]
    TA --> DOM
    SB --> WX["WeatherService<br/>Valkey cache · breaker"]
    API["HTTP /api/v2<br/>cii · seemp · emission · reduction-factors"] --> RL["rating layer<br/>(CiiService)"]
    RL --> DOM
    PUB["CiiPublisher<br/>(throttled)"] --> RL
    RC["RecomputeService<br/>(StreamReplayer)"] --> SB
  end
  AISP --> PC
  FUEL --> UC
  FLEET --> FC
  AISP -. replay .-> RC
  WX <--> OM["Open-Meteo<br/>/v1/forecast"]
  WX <--> VK[("Valkey")]
  subgraph PG["PostgreSQL · schema emission"]
    VP[(vessel_profiles)]
    FR[(fuel_readings<br/>hypertable)]
    SEG[(segments<br/>hypertable)]
    CD[[cii_daily<br/>continuous aggregate]]
    CA[[cii_annual<br/>hierarchical aggregate]]
    REF[(reduction_factors · cii_annual_manual<br/>seemp_measures · seemp_scenarios)]
  end
  FC --> VP
  SB --> SEG
  TA --> FR
  TA --> SEG
  SEG --> CD --> CA
  RL --> CA
  RL --> CD
  RL --> REF
  PUB --> EMI
  API --> AUD
```

| Path                       | What                                                                                                                                                                 |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/domain/`              | pure functions with `@method` TSDoc (no I/O): one file per concern, see below                                                                                        |
| `src/domain/segment.ts`    | `calculateSpeed` (haversine R = 3438 nm, cap 30 kn, × 0.5144), segment window rule                                                                                   |
| `src/domain/fuel/`         | method priority, navstatus multipliers, first formula, second formula, telemetry                                                                                     |
| `src/domain/expression/`   | safe expression evaluator of the first fuel formula (replaces `new Function`)                                                                                        |
| `src/domain/holtrop/`      | Holtrop–Mennen resistance and power chain (legacy `second-formula/*`)                                                                                                |
| `src/domain/weather/`      | Beaufort number, rhumb-line course, encounter angle, Kwon speed loss                                                                                                 |
| `src/domain/cii*.ts`       | CO2, attained, reference line, required, rating/grade, year-end projection                                                                                           |
| `src/domain/seemp/`        | 12 measures, reduction types 1–3, costs and amortization, recommender, simulation                                                                                    |
| `src/domain/dcs.ts`        | DCS summary model and CSV                                                                                                                                            |
| `src/consumers/`           | durable NATS consumers (`emission-positions`, `emission-fuel`, `emission-fleet`)                                                                                     |
| `src/modules/segments/`    | segment builder, telemetry attribution, repositories, aggregate refresher                                                                                            |
| `src/modules/cii/`         | CII rating layer, controllers, reduction factors, manual records, publisher, replay                                                                                  |
| `src/modules/seemp/`       | SEEMP catalog, recommendations, simulation, scenarios                                                                                                                |
| `src/modules/dcs/`         | DCS summary (JSON / CSV)                                                                                                                                             |
| `src/modules/weather/`     | Open-Meteo client, Valkey cache, circuit breaker                                                                                                                     |
| `src/modules/profiles/`    | FLEET projection, in-memory directory, tenancy (`VesselAccessService`)                                                                                               |
| `src/modules/methodology/` | `GET /emission/methodology`, method ids of the responses                                                                                                             |
| `migrations/`              | `0001_init.sql` (tables, hypertables), `0002_seed.sql` (Z, SEEMP), `0003_cii_aggregates.sql`, `0004_vessel_scoped_history.sql`, `0005_cii_aggregates_per_vessel.sql` |
| `test/fixtures/golden/`    | inputs and outputs of the original legacy functions (golden tests)                                                                                                   |

Startup follows the kit's lifecycle rule: connect, migrate and ensure streams (`onModuleInit`) →
load the vessel profiles and start the consumers (`onApplicationBootstrap`) → the port opens.
`SIGTERM` turns readiness to `503`, drains the consumers, cancels the recomputations of the
instance and waits until each recorded its outcome (`failed`, `INTERRUPTED: …`; nothing is deleted),
stops the publisher and refresher timers, drains NATS and closes the pool.

## Data model

| Table / view        | Kind                                                                                               | Content                                                                                                                                                                                                                                                                                                                           |
| ------------------- | -------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `vessel_profiles`   | table, PK `vessel_id`, unique `mmsi`                                                               | FLEET projection: `org_id`, full `VesselSnapshotV1` (`snapshot jsonb`), `snapshot_updated_at` (older snapshots never win and have no side effect; see Events)                                                                                                                                                                     |
| `fuel_readings`     | hypertable on `time` (7 d chunks, compressed after 14 d, retention 400 d)                          | telemetry readings `(mmsi, time)` PK, `period_start`, `fuel_me_ton`, `fuel_ae_ton`, `device_id`, `source`                                                                                                                                                                                                                         |
| `segments`          | hypertable on `time_start` (7 d chunks, compressed after 30 d by `vessel_id, mmsi`, retention 6 y) | PK `(mmsi, time_start)`, index `(vessel_id, time_start DESC)`: `time_end`, `vessel_id`, `distance_nm`, `speed_kn`, `fuel_me_ton`, `fuel_ae_ton`, `co2_ton`, `method` (`telemetry`/`first_formula`/`holtrop`/`none`), `navstatus` (previous fix), `fuel_code`, `conversion_factor`, `weather jsonb`, `flags text[]`, `computed_at` |
| `cii_daily`         | continuous aggregate (1 day, real-time; policy every 10 min over [−400 d, −1 h])                   | per vessel-day (`vessel_id`): Σ distance, Σ fuel ME/AE, Σ CO2 of counted segments (`method <> 'none'`), segment counts per method, excluded count, last time                                                                                                                                                                      |
| `cii_annual`        | hierarchical continuous aggregate on `cii_daily` (1 year, real-time; hourly over [−3 y, −1 d])     | the same sums per vessel-year (`vessel_id`)                                                                                                                                                                                                                                                                                       |
| `reduction_factors` | table, PK `year`                                                                                   | `z_percent`, `source` — seeded 2023–2026 = 5/7/9/11 (MEPC.338(76)), 2027–2030 = 13.625/16.25/18.875/21.5 (MEPC.400(83))                                                                                                                                                                                                           |
| `cii_annual_manual` | table, PK `(vessel_id, year)`                                                                      | legacy imported / manual annual CII (attained, optional required/rating/grade, distance, fuel ME/AE, CO2, note; `mmsi` at writing time) used for years **without segments**                                                                                                                                                       |
| `seemp_measures`    | table, PK `code`                                                                                   | the 12 legacy measures: name (exact legacy string), category, legacy order, method id, reduction and cost models (jsonb), source                                                                                                                                                                                                  |
| `seemp_scenarios`   | table, PK `id` (UUID v7)                                                                           | saved simulations, tenant-private by `org_id` (the vessel's organization)                                                                                                                                                                                                                                                         |
| `cii_publication`   | table, PK `mmsi`                                                                                   | throttle state of `emission.cii.updated.v1` (`dirty_since`, `last_published_at`, `last_year`), shared by replicas                                                                                                                                                                                                                 |
| `recompute_jobs`    | table, PK `id`                                                                                     | recomputations by replay (`mmsi`, `vessel_id`, range, status, counts, `error` as `CODE: message`, `heartbeat_at`); one running job per MMSI                                                                                                                                                                                       |

The rating layer is **application-level** (`src/modules/cii/cii-figures.ts`): it combines the
aggregate sums with the vessel profile (capacity, a/c, d-vector, C_F) and `reduction_factors`.

**The history follows the vessel, not the MMSI** (spec §8.5). Segments are stored under the MMSI
that reported them together with the `vessel_id` that held it; the CII aggregates, the manual
records and every read (segments, CII, DCS, SEEMP baseline, publication) are keyed by `vessel_id`.
An API path `/:mmsi` only resolves the vessel that holds the MMSI **now**: the next vessel
registered under a re-used MMSI — possibly of another organization — starts with an empty history,
and a vessel whose MMSI changes keeps its history. Rows of a deleted vessel are no longer reachable
and age out with the retention policies.

## Methods in short

**Segments** (`SegmentBuilderService`, `src/domain/segment.ts`)

- Each position event carries `previous`; the segment is `(previous.time, time]`. No segment when
  `previous` is `null` or `Δt ≤ 0`. `Δt > SEGMENT_MAX_GAP_MIN` (360) stores a segment with method
  `none`, zero fuel and the flag `gap` (not counted). Storage is idempotent by `(mmsi, time_start)`.
- Distance/speed: legacy `calculateSpeed([current, previous])` — haversine with R = 3438 nm, speed
  capped at 30 kn, m/s = kn × 0.5144.
- Fuel method priority (`fuel.method_selection`): telemetry if active for the segment, else the
  vessel's first fuel formula, else Holtrop (needs a main engine with SFOC), else nothing (`none`,
  flag `no_fuel_model`).
- First formula: `max(f(V), 0.5)` L/min per engine evaluated by the safe evaluator (numbers,
  `speedKnot`, `+ - * / ** ^ ( )`, `Math.`/bare `exp log ln sqrt pow abs min max`; `^` = power;
  identical IEEE-754 results to JavaScript for every valid formula), × navstatus factor of the
  **previous** fix, × minutes × density / 1000. An invalid formula keeps the legacy 0.5 L/min and is
  flagged `formula_error`.
- Holtrop: the legacy chain (Kwon speed loss from the wind at the previous fix → calm-water speed
  → R_F, R_APP, R_W, R_A, 1 + k₁ → R_T × 1.15 → P_E → P_D → P_S → P_MCR), ME fuel = P_MCR × SFOC ×
  t_new / 10⁶, AE fuel = 1.5103·e^(−0.064·V_new)·ρ/1000 (not × duration — legacy), navstatus
  factors. Non-finite or negative results (legacy speed loss above 100 % in strong winds on small
  hulls) are stored as `none` with `fuel_not_finite` / `fuel_negative`.
- CO2 = (ME + AE) × C_F of the vessel's fuel at computation time (`conversion_factor` is stored).

**Telemetry attribution rule** (`src/domain/fuel/telemetry.ts`, `telemetry.fuel_reading_usage`)

- A **period** reading `[periodStart, time]` counts in a segment `(start, end]` pro rata of the
  overlap: `share = |[periodStart, time] ∩ [start, end]| / (time − periodStart)`; it makes
  telemetry active only for the segments its period overlaps.
- An **instantaneous** reading (no `periodStart`, or `periodStart ≥ time`) — fuel since the
  device's previous report — counts fully in the segment whose window contains its time
  (`start < time ≤ end`) and makes telemetry active for every segment ending within
  `TELEMETRY_ACTIVE_WINDOW_MIN` (10) of it (those get 0 t: their fuel is in the next report).
- Segment fuel = Σ share × reading (ME and AE separately), no navstatus factors. Every reading is
  counted exactly once whatever the segmentation, provided its period is at most
  `TELEMETRY_MAX_PERIOD_H` (default 24 h; it bounds the search for overlapping period readings and
  MUST be at least the telemetry service's value of the same name — a longer reading is logged).
- Readings usually arrive after the positions: every stored reading re-attributes the segments it
  concerns (flag `telemetry_reattributed`), and a redelivered reading re-runs the idempotent
  attribution.
- Concurrency: the segment builder reads the readings and writes a segment, and the attribution
  stores a reading and updates the segments, each in one transaction under the vessel's advisory
  lock (`pg_advisory_xact_lock(hashtext('emission.segments'), mmsi)`; the Holtrop weather is
  fetched before the lock). Whichever runs second sees the other's write, so a position and a
  reading of the same window give the same segment fuel in either order (only the flag
  `telemetry_reattributed` tells which came first), also while the builder waits
  for Open-Meteo and during a recomputation.

**Weather** (`WeatherService`, `weather.open_meteo_current`) — wind of the 0.25° grid point
nearest to the previous fix and the UTC hour of the segment start, from
`{WEATHER_API_URL}/v1/forecast?hourly=wind_speed_10m,wind_direction_10m&wind_speed_unit=kn`,
cached in Valkey per cell-hour (`emission:weather:v1:<lat>:<lon>:<hour>`, 7 days), 3 s timeout,
circuit breaker (5 failures → 60 s open, then one trial). On failure: calm weather (0 kn) and the
flag `weather_unavailable`. "Weather data by Open-Meteo.com" (CC BY 4.0) must be shown with the
figures (the methodology endpoint returns the attribution).

**CII** (`src/domain/cii.ts`, `CiiService`)

- attained = Σ(fuel × C_F) × 10⁶ / (capacity × Σ distance) [g CO2 / (capacity · nm)] over the
  counted segments of a **calendar year** (UTC); capacity = `type.capacityFixed ?? dimensions.capacity`.
- required = (1 − Z_year / 100) × a × capacity^(−c); rating = attained / required; grade by the
  d-vector on the rating; boundaries `d_i × required` (legacy `ddVector`).
- A year without segments falls back to `cii_annual_manual` (stored values win; missing required,
  rating or grade are computed). Without either: **`404 CII_NOT_AVAILABLE`** (no default CII).
- `current` adds the linear year-end projection (`cii.year_end_projection`): the year-to-date
  totals divided by the elapsed fraction of the year, and the attained CII, rating and grade of
  those projected totals — equal to the year-to-date values, since a linear extrapolation scales CO2
  and distance alike. The trend of the cumulative ratio is not extrapolated (it converges and is not
  linear; extending a short slope to 31 December gave 0 or many times the year-to-date value).
- Freshness: the current day and year are real-time; changes to older days (late positions,
  telemetry, recomputation) are re-materialized by `AggregateRefresher` within
  `CII_AGGREGATE_REFRESH_MS` (same windows as the 10-minute TimescaleDB policy), before every
  publication round, once after boot (late writes of a replica that crashed before refreshing) and
  at shutdown.

**SEEMP** (`src/domain/seemp/*`)

- Context of a vessel: required CII of the **target year** (default the current year), baseline =
  CII figures of the **baseline year** (default the previous year, else the latest year with data;
  segments or manual record), the vessel's share of the year at sea, the Z table (amortization
  until the last year with a Z, legacy 2030).
- Types: (1) operational `CII − CII·p/100·v/100`; (2) fuel switch — the baseline fuel re-rated with
  the new C_F; (3) auxiliary energy — AE fuel × (1 − p), cold ironing `AE(1 − v/100) + AE·v·0.8/100`.
  Costs: LOA bands, ranges (mean of the per-year costs), wetted surface × 100, installed power ×
  USD/kW; per-year cost = investment / years until the grade would fall to D/E (whole investment
  when ≤ 1 year).
- Recommendations: every measure evaluated in legacy order, grades A–C kept, sorted by cost per
  year (stable). Items keep the legacy fields (`recommendation`, `cost` text, `ciiRatingAfter`
  rounded to 8 decimals, `ciiGradeAfter`, `ciiRatingBefore`, `ciiGradeBefore` = record of the year
  before the target year) plus `code`, `costUsdPerYear`, `costRangeUsdPerYear`, `ciiAttainedAfter`,
  `yearsUntilInferior`, `methodIds`.
- **Simulation combination model** (`seemp.simulation_combination`, sequential multiplicative,
  reduces to the legacy formula for one measure): (1) fuel side in legacy order — at most one fuel
  switch replaces C_F, each auxiliary measure multiplies the remaining AE fuel (`AE ← f_k(AE)`);
  (2) attained re-rated from the fuel side when a type-2/3 measure is selected, else the baseline;
  (3) each operational measure multiplies the attained CII by `(1 − p_k·v/10⁴)`. Cost = Σ per-year
  costs of the selected measures amortized with the combined rating. Two fuel switches → `422
SEEMP_MEASURES_INCOMPATIBLE`.

**DCS** — Σ fuel ME/AE and CO2 per fuel code, Σ distance, hours under way = duration of counted
segments with mean speed ≥ 1 kn (Fourth IMO GHG Study at-berth threshold); a year without segments
uses the manual record (hours unknown). CSV (RFC 4180, CRLF, formula-injection safe) with
`Accept: text/csv`.

**Recomputation** (`RecomputeService`) — `POST /cii/vessels/:mmsi/recompute?from&to` replays the
MMSI's subject of `AIS_POSITION` from `from − 15 min` (storage time) with an ephemeral consumer and
rebuilds every segment starting in `[from, to)` with the live builder in replace mode (current
profile, readings and weather, same vessel lock). Deletion is guarded:

- only after a **complete** replay — it read through the subject's last message at start, or past
  the range — and never after a cancellation (shutdown) or an early end of the message iterator;
- only rows of the job's vessel under the replayed MMSI, computed **before** the job started,
  starting between the first and the last rebuilt segment and not produced again; rows written by
  the live consumers during the job, rows of the previous holder of a re-assigned MMSI and rows at
  the edges of the range (their positions may have left the stream) are kept;
- a replay that finds no position of the range while segments exist deletes nothing and fails
  (`NO_POSITIONS`, e.g. the stream was purged or recreated).

A running job writes a heartbeat every 10 s; a running job without heartbeat for 60 s is failed at
boot and before a new job of any vessel starts, so an interrupted job never blocks the vessel.

## API

All routes under `/api/v2`, JSON in camelCase, errors as RFC 9457 problem details. CII, SEEMP and
DCS are **tenant-private**: the vessel's organization (FLEET projection, never the client) must be
the principal's active organization, unless `super_admin`.

| Method   | Path                                                   | Permission         | Notes                                                                                                                                                       |
| -------- | ------------------------------------------------------ | ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET`    | `/cii/vessels/:mmsi/current?year=`                     | `cii:read`         | year-to-date `CiiSummaryDto` + linear year-end projection, `methodIds`                                                                                      |
| `GET`    | `/cii/vessels/:mmsi/daily?from&to`                     | `cii:read`         | daily points with cumulative attained/rating/grade (default from 1 January of the year of `to`)                                                             |
| `GET`    | `/cii/vessels/:mmsi/annual`                            | `cii:read`         | per year (segments or manual) with `ddVector` = `d_i × required`; 404 without any year                                                                      |
| `GET`    | `/cii/vessels/:mmsi/segments?from&to&cursor&limit`     | `cii:read`         | cursor page, newest first (default last 24 h, ≤ 31 days)                                                                                                    |
| `GET`    | `/cii/fleet/summary?year&orgId&page&pageSize`          | `cii:read`         | grade distribution of the whole fleet of the active organization (`orgId` for super_admin) + one page of its vessels (`pageSize` ≤ 100, default 20), `meta` |
| `GET`    | `/cii/vessels/:mmsi/annual-manual/:year`               | `vessel:write`     | manual / imported annual record                                                                                                                             |
| `PUT`    | `/cii/vessels/:mmsi/annual-manual/:year`               | `vessel:write`     | create or replace (audited)                                                                                                                                 |
| `POST`   | `/cii/vessels/:mmsi/recompute?from&to`                 | `super_admin`      | `202` + job; replays `AIS_POSITION` (≤ `RECOMPUTE_MAX_DAYS`, inside the 7-day stream, `to` ≤ now; audited on the vessel id)                                 |
| `GET`    | `/cii/recompute-jobs/:id`                              | `super_admin`      | job status (`running` / `succeeded` / `failed`, counts, `error`)                                                                                            |
| `GET`    | `/reduction-factors`                                   | `cii:read`         | Z per year with source                                                                                                                                      |
| `PUT`    | `/reduction-factors`                                   | `reference:write`  | upsert the given years (others kept); every CII is republished (audited)                                                                                    |
| `GET`    | `/seemp/measures`                                      | `seemp:read`       | the 12 legacy measures with their models                                                                                                                    |
| `GET`    | `/seemp/vessels/:mmsi/recommendations?year&targetYear` | `seemp:read`       | legacy `calculateSEEMPbyMMSI` output (A–C after, cheapest first)                                                                                            |
| `POST`   | `/seemp/vessels/:mmsi/simulate`                        | `seemp:simulate`   | body `{ measureCodes[], year?, targetYear? }`                                                                                                               |
| `GET`    | `/seemp/scenarios?mmsi&page&pageSize`                  | `seemp:read`       | saved simulations of the organization, newest first                                                                                                         |
| `POST`   | `/seemp/scenarios`                                     | `seemp:simulate`   | `{ mmsi, name, measureCodes[], year?, targetYear? }` → `201` (audited)                                                                                      |
| `GET`    | `/seemp/scenarios/:id`                                 | `seemp:read`       | 404 for other organizations                                                                                                                                 |
| `DELETE` | `/seemp/scenarios/:id`                                 | `seemp:simulate`   | `204` (audited)                                                                                                                                             |
| `GET`    | `/emission/vessels/:mmsi/dcs?year=`                    | `cii:read`         | JSON, or CSV with `Accept: text/csv`                                                                                                                        |
| `GET`    | `/emission/methodology`                                | any signed-in user | methods (formula LaTeX, variables, constants, references), active Z, vessel types of the FLEET projection                                                   |

Outside the prefix: `GET /health/live`, `GET /health/ready` (database, NATS, Valkey),
`GET /metrics`, `GET /docs`, `GET /openapi.json`. The committed [`openapi.json`](openapi.json) is
generated with `pnpm openapi` (no connection needed).

Error codes: `VESSEL_NOT_FOUND` (404), `CII_NOT_AVAILABLE` (404), `CII_ANNUAL_MANUAL_NOT_FOUND`
(404), `SEEMP_SCENARIO_NOT_FOUND` (404), `RECOMPUTE_JOB_NOT_FOUND` (404), `REDUCTION_FACTOR_MISSING`
(422), `SEEMP_MEASURE_UNKNOWN` (422), `SEEMP_MEASURES_INCOMPATIBLE` (422), `RECOMPUTE_RANGE_INVALID`
(400), `RECOMPUTE_IN_PROGRESS` (409), `SUPER_ADMIN_REQUIRED` (403), `FORBIDDEN` (403, other tenant
or missing permission), `VALIDATION_FAILED` (400), `UNAUTHORIZED` (401).

## Events

| Direction | Stream         | Subject                              | Type                                                   | Consumer / notes                                                                                                                  |
| --------- | -------------- | ------------------------------------ | ------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------- |
| consumed  | `AIS_POSITION` | `ais.position.v1.<partition>.<mmsi>` | `ais.position.recorded.v1`                             | durable `emission-positions`, concurrency 8, per-vessel order; unknown vessels skipped                                            |
| consumed  | `FUEL`         | `fuel.reading.v1.<mmsi>`             | `fuel.reading.recorded.v1`                             | durable `emission-fuel`, concurrency 4; dedup by `(mmsi, time)`, idempotent re-attribution                                        |
| consumed  | `FLEET`        | `fleet.vessel.v1.<vesselId>`         | `fleet.vessel.upserted.v1` / `fleet.vessel.deleted.v1` | durable `emission-fleet`; newest `updatedAt` wins; a re-assigned MMSI moves to the newer claim (a stale snapshot changes nothing) |
| replayed  | `AIS_POSITION` | `ais.position.v1.<p>.<mmsi>`         | `ais.position.recorded.v1`                             | ephemeral consumer (`StreamReplayer`) of `POST …/recompute`                                                                       |
| published | `EMISSION`     | `emission.cii.v1.<mmsi>`             | `emission.cii.updated.v1` (`CiiUpdatedV1`)             | year-to-date CII of the year of the latest segment, at most every `CII_PUBLISH_INTERVAL_S` per vessel                             |
| published | `AUDIT`        | `audit.v1.emission`                  | `audit.recorded.v1`                                    | `cii_annual_manual.update`, `reduction_factor.update`, `seemp_scenario.create/delete`, `cii.recompute`                            |

The service ensures `EMISSION` and `AUDIT` as producer; consumed streams are only created when
missing. Invalid messages are terminated and counted; failures are retried with backoff and
dead-lettered after 10 deliveries (kit).

## Configuration

Every variable is validated at boot (zod); see [`.env.example`](.env.example).

| Variable                        | Default                                                      | Notes                                                              |
| ------------------------------- | ------------------------------------------------------------ | ------------------------------------------------------------------ |
| `NODE_ENV`                      | `development`                                                | `development` \| `test` \| `production`                            |
| `SERVICE_NAME`                  | `emission`                                                   | logs, metrics, event `source`, `audit.v1.emission`                 |
| `SERVICE_VERSION`               | `package.json` version                                       |                                                                    |
| `HOST` / `PORT`                 | `0.0.0.0` / `3006`                                           |                                                                    |
| `LOG_LEVEL` / `LOG_PRETTY`      | `info` / `true` in development                               | pino                                                               |
| `SHUTDOWN_TIMEOUT_MS`           | `30000`                                                      | graceful shutdown deadline                                         |
| `TRUSTED_PROXIES`               | empty                                                        | proxies whose `X-Forwarded-*` are trusted                          |
| `DATABASE_URL`                  | `postgres://emission_svc:emission_svc@localhost:5432/aisits` |                                                                    |
| `DATABASE_SCHEMA`               | `emission`                                                   | `search_path=emission,public`                                      |
| `DATABASE_POOL_MAX`             | `10`                                                         |                                                                    |
| `DATABASE_STATEMENT_TIMEOUT_MS` | `30000`                                                      |                                                                    |
| `DB_MIGRATE_ON_BOOT`            | `true`                                                       | also `pnpm migrate`                                                |
| `NATS_URL`                      | `nats://localhost:4222`                                      | comma separated list allowed                                       |
| `NATS_DURABLE_PREFIX`           | empty                                                        | prefix of durable names (test suites only)                         |
| `REDIS_URL`                     | `redis://localhost:6379`                                     | Valkey (weather cache)                                             |
| `AUTH_JWKS_URL`                 | `http://localhost:3001/.well-known/jwks.json`                | access token verification (cached JWKS)                            |
| `AUTH_ISSUER` / `AUTH_AUDIENCE` | `ais-its-auth` / `ais-its-api`                               |                                                                    |
| `AUTH_INTERNAL_URL`             | `http://localhost:3001`                                      | API-key introspection (kit; no API-key route here)                 |
| `INTERNAL_TOKEN`                | `dev-internal-token-change-me`                               | ≥ 16 chars and not the default in production                       |
| `CORS_ORIGINS`                  | `http://localhost:5173,http://localhost:8000`                |                                                                    |
| `PUBLIC_BASE_URL`               | `http://localhost:8000`                                      |                                                                    |
| `OTEL_EXPORTER_OTLP_ENDPOINT`   | unset                                                        | OTLP/HTTP tracing when set                                         |
| `SEGMENT_MAX_GAP_MIN`           | `360`                                                        | longest window of a counted segment, minutes                       |
| `TELEMETRY_ACTIVE_WINDOW_MIN`   | `10`                                                         | active window of instantaneous readings, minutes                   |
| `TELEMETRY_MAX_PERIOD_H`        | `24` (1–744)                                                 | longest reading period; ≥ the telemetry service's value            |
| `CII_PUBLISH_INTERVAL_S`        | `60`                                                         | minimum interval between two `emission.cii.updated.v1` of a vessel |
| `CII_PUBLISH_POLL_MS`           | `5000`                                                       | how often due publications are checked                             |
| `CII_AGGREGATE_REFRESH_MS`      | `30000`                                                      | longest delay before late changes reach the aggregates             |
| `RECOMPUTE_MAX_DAYS`            | `7`                                                          | longest recomputation range (1–7)                                  |
| `WEATHER_API_URL`               | `https://api.open-meteo.com`                                 | forecast API base (`/v1/forecast`)                                 |
| `WEATHER_ENABLED`               | `true`                                                       | `false` = calm weather + flag, no requests                         |
| `WEATHER_TIMEOUT_MS`            | `3000`                                                       | per request                                                        |
| `WEATHER_CACHE_TTL_S`           | `604800`                                                     | Valkey lifetime of a cell-hour                                     |
| `WEATHER_BREAKER_THRESHOLD`     | `5`                                                          | consecutive failures that open the breaker                         |
| `WEATHER_BREAKER_COOLDOWN_MS`   | `60000`                                                      | open time before a trial request                                   |

## Local development

Requirements: Node.js 24 (`.nvmrc`), pnpm 10 (`corepack enable`), Docker. `@darmawanweb/*` packages
come from the package registry: map the scope once in `~/.npmrc` (never in this repository).

```bash
pnpm install
cp .env.example .env
pnpm --dir ../.. infra:up        # postgres, nats, valkey, … from the central repository
pnpm dev                         # watch mode (SWC, decorator metadata)
curl -s localhost:3006/health/ready
open http://localhost:3006/docs  # Swagger UI
```

Other scripts: `pnpm build`, `pnpm start`, `pnpm migrate`, `pnpm openapi` (regenerates
`openapi.json`), `pnpm openapi:check`, `pnpm lint`, `pnpm typecheck`, `pnpm format`.

## Testing

- **Golden unit tests** (`pnpm test`, no Docker): `src/**/*.spec.ts` compare the ported functions
  with `test/fixtures/golden/*.json` at a relative tolerance of 1e-9 (`test/support/golden.ts`).
  The fixtures were produced by running the **original legacy TypeScript** (the `be-legacy` files copied
  unchanged except for appended `export { … }` lists of internal functions, executed with `tsx`;
  Mongo repositories and the Open-Meteo call stubbed with fixed data, "now" fixed at
  2026-06-15T12:00Z; a throwaway harness outside the repository, re-run to identical fixtures) on the Postman sample vessel _Dharma Ferry VIII_ and four
  further hull forms chosen to reach every branch (c7, c15, c16, λ, C_B bands, Beaufort bands):

  | Fixture              | Legacy functions                                                                                                                                                |
  | -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
  | `speed.json`         | `calculateSpeed` (10 cases incl. 30 kn cap, zero time, tiny move, 6 h)                                                                                          |
  | `first-formula.json` | `evaluateFormula`, `getFuelByNavStatus` (navstatus −1…16), `calculateTotalFuelTon`, `calculateFirstFormulaFuel` (5 formulas × 10 cases × 5 navstatus)           |
  | `weather.json`       | `calculateBeafortNumber`, `calculateEncountedAngle`, `calculateShipCourse`, `calculateWindCourse`, Kwon coefficients                                            |
  | `holtrop.json`       | every intermediate of `second-formula/*` (hull terms of 5 ships; 120 chains: 5 ships × 6 speeds × 4 winds) and `calculateSecondFormulaFuel` per navstatus       |
  | `cii.json`           | `calculateCIIRequired` (Z 2023–2030), `calculateCII` accumulation, `assignGradeBasedOnDdVector(New)`                                                            |
  | `seemp.json`         | the 12 measure functions, `calculateSemp`, `calculateSEEMPbyMMSI` (7 scenarios), `calculatedYear`, `calculateCostPerYear`, `calculateCostbyPower`, `formatCost` |

  Further unit tests cover the safe evaluator (bit-identical to JavaScript, refusals), the
  telemetry rule, the simulation combination model, the weather client against a local fake
  Open-Meteo, the circuit breaker, the DCS CSV and the configuration.

- **Integration tests** (`pnpm test:int`, Docker): `test/*.int.test.ts` boot the real `AppModule`
  against `timescale/timescaledb-ha:pg17`, `nats:2.11-alpine` and `valkey/valkey:8-alpine` started
  once by `test/support/global-setup.ts`, with signed test JWTs and a local fake Open-Meteo. They
  publish FLEET, AIS_POSITION and FUEL events and assert, through the HTTP API: segments with each
  method equal to the legacy golden values, the CII of the Postman vessel equal to the legacy
  accumulated `calculateCII`, the SEEMP recommendations equal to the legacy `calculateSEEMPbyMMSI`,
  Holtrop with Open-Meteo weather and the calm fallback, telemetry before/after positions, gaps,
  idempotency, reduction factor changes, `404 CII_NOT_AVAILABLE`, tenancy, DCS JSON/CSV, scenarios,
  recomputation by replay and the publication throttling of `emission.cii.updated.v1`.
  `test/hardening.int.test.ts` covers the concurrency and recovery rules: a reading stored while
  its segment waits for a hanging Open-Meteo, readings longer than 24 h, stale FLEET snapshots,
  MMSI re-use across organizations and MMSI changes, live segments written during a
  recomputation, a replay without positions, stale job heartbeats, the bounded overlap search on a
  compressed history (`EXPLAIN`) and a shutdown in the middle of a recomputation.
  `test/migrations-upgrade.int.test.ts` upgrades a 0.1.0 database (0001–0003, in a database of its
  own) holding segments, chunks compressed under the old settings and manual records to the
  vessel-scoped history (0004–0005): identical sums per vessel, materialized history, manual
  records attributed or dropped, policies present, recompression with the new settings.
  Set `TESTCONTAINERS_RYUK_DISABLED=true` where Ryuk is not available; containers are stopped by the
  global teardown.

## Operations

- Image `ghcr.io/darmawanweb/ais-its-emission-service` (multi-stage `node:24-alpine`, `USER node`,
  production dependencies only, `HEALTHCHECK` on `/health/live`). Build with BuildKit secrets only:

  ```bash
  DOCKER_BUILDKIT=1 docker build --secret id=npmrc,src=$HOME/.npmrc -t ais-its-emission-service .
  # behind a TLS-intercepting proxy, add the optional CA bundle (spec §11):
  DOCKER_BUILDKIT=1 docker build --network host --secret id=npmrc,src=$HOME/.npmrc \
    --secret id=ca,src=/path/to/ca-bundle.crt -t ais-its-emission-service .
  ```

- Health: `/health/live` (process), `/health/ready` (database, NATS, Valkey; `503` while draining or
  when a consumer stalls).
- Metrics (`/metrics`, prefix `aisits_`): kit HTTP and event metrics
  (`aisits_http_requests_total`, `aisits_events_consumed_total{stream,consumer,outcome}`,
  `aisits_events_published_total`, `aisits_events_invalid_total`, …) and the domain metrics
  `aisits_emission_segments_total{method}`, `aisits_emission_positions_total{outcome}` (`stored`,
  `duplicate`, `unknown_vessel`, `no_previous`, `not_after_previous`),
  `aisits_weather_cache_hits_total`, `aisits_weather_requests_total{outcome}` (`ok`, `error`,
  `breaker_open`, `disabled`).
- Logs: pino JSON (`service`, `version`, `requestId`, `traceId`, `principal`).
- Troubleshooting:

  | Symptom                                | Check                                                                                                                                                                                                                                                                                                                                 |
  | -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
  | No segments for a vessel               | the vessel exists in `vessel_profiles` (FLEET projection) — `aisits_emission_positions_total{outcome="unknown_vessel"}` grows otherwise; positions carry `previous`                                                                                                                                                                   |
  | Segments with `method = 'none'`        | `flags`: `gap` (Δt > `SEGMENT_MAX_GAP_MIN`), `no_fuel_model` (no telemetry, formula or main engine), `fuel_not_finite` / `fuel_negative` (legacy weather model breakdown)                                                                                                                                                             |
  | Many `weather_unavailable` flags       | `aisits_weather_requests_total{outcome}`; egress to `WEATHER_API_URL`; breaker cooldown                                                                                                                                                                                                                                               |
  | `404 CII_NOT_AVAILABLE`                | no counted segments and no manual record for the year (expected: no default CII)                                                                                                                                                                                                                                                      |
  | `422 REDUCTION_FACTOR_MISSING`         | add the year with `PUT /api/v2/reduction-factors`                                                                                                                                                                                                                                                                                     |
  | CII of an older day lags               | late changes reach the aggregates within `CII_AGGREGATE_REFRESH_MS`; `CALL refresh_continuous_aggregate('cii_daily', NULL, NULL)` forces it                                                                                                                                                                                           |
  | `CII aggregate refresh failed` warning | TimescaleDB rejects a refresh overlapping one in progress (`55P03` "due to a concurrent refresh": a policy job, another replica); the refresher retries for about 4 s, then keeps the change pending for the next tick — harmless unless it repeats on every tick                                                                     |
  | Wrong figures after a fleet change     | `POST /api/v2/cii/vessels/:mmsi/recompute?from&to` (last 7 days) rebuilds the segments with the current profile                                                                                                                                                                                                                       |
  | Recomputation `failed`                 | `error`: `INTERRUPTED` (instance stopped; no heartbeat for 60 s also fails a job), `REPLAY_INCOMPLETE` (the replay ended before the subject's last message), `NO_POSITIONS` (the stream has no position of the range while segments exist), `VESSEL_CHANGED` (MMSI re-assigned during the job) — nothing was deleted; start a new job |
  | `409 RECOMPUTE_IN_PROGRESS`            | a job of the MMSI is running (heartbeat < 60 s); `GET /api/v2/cii/recompute-jobs/:id`                                                                                                                                                                                                                                                 |

- Release: move the `Unreleased` entries of [CHANGELOG.md](CHANGELOG.md) under the new version,
  bump `package.json`, tag `v<version>`.

## Known limitations

- Legacy Holtrop/Kwon instability, kept for parity: for Beaufort ≥ 7 on small hulls the legacy
  speed loss exceeds 100 %, giving a negative speed and `NaN` fuel (144 of the golden Holtrop fuel
  values are `NaN` in the legacy itself). v2 stores such segments as `none` with `fuel_not_finite` /
  `fuel_negative` (not counted); the thesis needs a methodology decision on this regime.
- Legacy modelling choices kept for parity and marked `needsCitation` in the catalog: the Holtrop
  path's auxiliary-engine fuel is not multiplied by the segment duration; R_F uses B/T instead of
  the wetted surface; the Kwon form coefficient is the legacy variant; the 0.5 L/min floor of the
  first formula also applies at 0 kn.
- Past hours are requested from the Open-Meteo **forecast** API (`start_hour`/`end_hour`), which
  keeps about 3 months of past hours — enough for live segments and recomputations (≤ 7 days); a
  historical backfill would need the archive API. The live API could not be exercised from the
  build machine (tests use a local fake).
- Changes to days before today (late positions, telemetry re-attribution, recomputation) reach the
  CII API within `CII_AGGREGATE_REFRESH_MS` (30 s); a graceful shutdown refreshes pending changes,
  and every replica refreshes once after boot, so the late writes of a crashed replica wait at most
  until a replica's first tick (TimescaleDB keeps their invalidations), never for the 10-minute
  policy alone. The current day and year are always real-time.
- CO2 uses the vessel's fuel C_F at segment computation time: a mid-year fuel change mixes fuels in
  the annual CII (as the attained formula requires), DCS splits the totals per `fuel_code`. A
  recomputation applies the vessel's **current** fuel to the rebuilt segments.
- Segments longer than `SEGMENT_MAX_GAP_MIN` are gaps; the overlap search of a fuel reading relies
  on it (`time_start ≥ from − SEGMENT_MAX_GAP_MIN`). After lowering the variable, older segments
  longer than the new value are no longer re-attributed by late readings.
- The Docker image is about 476 MB: the `node:24-alpine` base (about 150 MB) and about 200 MB of
  production `node_modules`, mostly runtime dependencies of the kit (the OpenTelemetry Node SDK
  with every exporter, gRPC included; Swagger UI; drizzle; class-validator). The kit's test-only
  optional peers (`testcontainers` with `dockerode` and `ssh2`, `@nestjs/testing`) and the
  compile-time peer `typescript` are kept out of the production graph by `.pnpmfile.cjs`.

## Legacy parity notes

Ported files: `src/services/cii/cii.service.ts`, `src/utils/cii/{speed-calculation,fuel-calculation,cii-calculation,weather}.ts`,
`src/utils/cii/second-formula/*`, `src/services/seemp.service.ts`, `src/utils/seemp/*`,
`src/types/second-formula.types.ts`, the CII/SEEMP controllers and models of `be-legacy`.

**Identical numbers (golden-tested):** speed and distance, both fuel formulas with the navstatus
multipliers of the previous fix, every Holtrop/Kwon intermediate, required CII, the accumulated
attained CII of one year, grades, every SEEMP measure (rating after, cost, cost text), the
recommender's filter/ordering and the legacy output items.

**Intentional changes (spec §15):** no hard-coded default CII (`404 CII_NOT_AVAILABLE`); CII per
calendar year from segments instead of a lifetime accumulator, manual records only as fallback;
safe evaluator (`^` = power) instead of `new Function`; telemetry active window in minutes and
readings attributed by time (the legacy used the first log of the latest reading for any segment);
CII capacity `type.capacityFixed ?? dimensions.capacity`.

**v2 decisions without legacy equivalent:**

- Weather is the hourly wind of the 0.25° cell and the segment hour (reproducible replays, cache);
  the legacy asked `current_weather` at the exact previous fix at processing time and failed the
  whole CII update when the request failed — v2 uses calm weather and flags the segment.
- Gaps longer than 360 min are not counted; non-finite/negative Holtrop results are not counted
  (in the legacy a single `NaN` poisoned the accumulator for the vessel's lifetime).
- SEEMP uses one consistent baseline year (the legacy mixed the attained CII of the **last** annual
  record with the fuel and distance of the **first** one); `ciiRatingBefore`/`ciiGradeBefore` are
  `null` (legacy `undefined`) without a record of the previous year. The domain functions still take
  both inputs separately, which is how the golden tests reproduce the legacy mix.
- The legacy Holtrop path's auxiliary engine fuel is not multiplied by the segment duration, the
  friction resistance uses B/T instead of the wetted surface and the form coefficient is the
  legacy variant: kept for parity and marked in the methodology catalog.

## Methodology & references

Every domain function carries `@method <id>` TSDoc with units and sources; values from the thesis
without a verified external source are marked `// SOURCE: thesis — needs citation` (⚠️ below,
`needsCitation` in the catalog). Formulas, variables and sources are in
[`docs/METHODOLOGY.md`](../../docs/METHODOLOGY.md) sections
[7 — fuel](../../docs/METHODOLOGY.md#7-konsumsi-bahan-bakar-emission),
[8 — CO2 and CII](../../docs/METHODOLOGY.md#8-co2-dan-cii-emission) and
[9 — SEEMP](../../docs/METHODOLOGY.md#9-seemp-model-reduksi-biaya-dan-12-langkah-emission); the same
catalog is served by `GET /api/v2/emission/methodology` (from `@darmawanweb/ais-its-contracts/references`).

| Method id                                                                                                              | Name                                                                                   | Main sources                                                                                                                                                  |
| ---------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`geo.haversine_distance`](../../docs/METHODOLOGY.md#geo.haversine_distance)                                           | Great-circle distance between two AIS fixes (haversine, R = 3438 nm)                   | [Sinnott 1984 / Veness](https://movable-type.co.uk/scripts/latlong.html), [Aviation Formulary](https://www.edwilliams.org/avform.txt)                         |
| [`geo.speed_from_positions`](../../docs/METHODOLOGY.md#geo.speed_from_positions)                                       | Segment speed from two AIS fixes (cap 30 kn) ⚠️                                        | [NIST SP 811](https://www.nist.gov/pml/special-publication-811/nist-guide-si-footnotes)                                                                       |
| [`geo.rhumb_line_course`](../../docs/METHODOLOGY.md#geo.rhumb_line_course)                                             | Ship course from two fixes (rhumb-line bearing)                                        | [Veness](https://movable-type.co.uk/scripts/latlong.html), [Aviation Formulary](https://www.edwilliams.org/avform.txt)                                        |
| `emission.segment_window`                                                                                              | Segment window rule (no previous / Δt ≤ 0 / gap > SEGMENT_MAX_GAP_MIN) — _proposed id_ | platform spec §13.5                                                                                                                                           |
| [`fuel.method_selection`](../../docs/METHODOLOGY.md#fuel.method_selection)                                             | Fuel-estimation method priority (telemetry > first formula > Holtrop) ⚠️               | legacy MVP, platform spec                                                                                                                                     |
| [`telemetry.fuel_reading_usage`](../../docs/METHODOLOGY.md#telemetry.fuel_reading_usage)                               | Use of telemetry fuel readings in the segment ⚠️                                       | legacy MVP, platform spec                                                                                                                                     |
| [`fuel.navstatus_multipliers`](../../docs/METHODOLOGY.md#fuel.navstatus_multipliers)                                   | ME/AE fuel multipliers by AIS navigational status ⚠️                                   | [Fourth IMO GHG Study 2020](https://imo.org/en/ourwork/Environment/Pages/Fourth-IMO-Greenhouse-Gas-Study-2020.aspx)                                           |
| [`fuel.first_formula`](../../docs/METHODOLOGY.md#fuel.first_formula)                                                   | First fuel formula (vessel-specific fuel-flow regressions) ⚠️                          | legacy MVP (thesis)                                                                                                                                           |
| [`fuel.ae_regression`](../../docs/METHODOLOGY.md#fuel.ae_regression)                                                   | Auxiliary-engine fuel regression 1.5103·e^(−0.064 v) ⚠️                                | legacy MVP (thesis), Fourth IMO GHG Study                                                                                                                     |
| [`fuel.density_conversion`](../../docs/METHODOLOGY.md#fuel.density_conversion)                                         | Fuel volume to mass conversion ⚠️                                                      | [ISO 8217](https://www.iso.org/standard/80579.html)                                                                                                           |
| [`resistance.hull_volumes_and_lengths`](../../docs/METHODOLOGY.md#resistance.hull_volumes_and_lengths)                 | Lengths, displacement and volumes of the Holtrop/Kwon chain ⚠️                         | Holtrop & Mennen 1982, SOLAS II-1/2.20                                                                                                                        |
| [`resistance.holtrop.reynolds_froude`](../../docs/METHODOLOGY.md#resistance.holtrop.reynolds_froude)                   | Froude and Reynolds numbers ⚠️                                                         | ITTC 7.5-02-01-03                                                                                                                                             |
| [`resistance.holtrop.friction_line`](../../docs/METHODOLOGY.md#resistance.holtrop.friction_line)                       | ITTC-1957 friction line                                                                | ITTC 7.5-02-02-01, Hadler 1958                                                                                                                                |
| [`resistance.holtrop.friction`](../../docs/METHODOLOGY.md#resistance.holtrop.friction)                                 | Frictional resistance R_F (B/T instead of wetted surface) ⚠️                           | [Holtrop & Mennen 1982](https://www.marin.nl/en/publications/an-approximate-power-prediction-method)                                                          |
| [`resistance.holtrop.form_factor`](../../docs/METHODOLOGY.md#resistance.holtrop.form_factor)                           | Hull form factor 1 + k₁ ⚠️                                                             | Holtrop 1984, Holtrop & Mennen 1982                                                                                                                           |
| [`resistance.holtrop.lcb_length_of_run`](../../docs/METHODOLOGY.md#resistance.holtrop.lcb_length_of_run)               | Assumed LCB and length of run L_R ⚠️                                                   | Holtrop & Mennen 1982                                                                                                                                         |
| [`resistance.holtrop.appendage`](../../docs/METHODOLOGY.md#resistance.holtrop.appendage)                               | Appendage area and appendage resistance ⚠️                                             | Holtrop & Mennen 1982                                                                                                                                         |
| [`resistance.holtrop.wetted_surface`](../../docs/METHODOLOGY.md#resistance.holtrop.wetted_surface)                     | Wetted surface S                                                                       | Holtrop & Mennen 1982                                                                                                                                         |
| [`resistance.holtrop.wave_c1_c7_ie`](../../docs/METHODOLOGY.md#resistance.holtrop.wave_c1_c7_ie)                       | Wave-resistance coefficients c7, iE, c1                                                | Holtrop & Mennen 1982                                                                                                                                         |
| [`resistance.holtrop.wave_bulb_transom`](../../docs/METHODOLOGY.md#resistance.holtrop.wave_bulb_transom)               | Bulb and transom terms (c2, c3, c5) ⚠️                                                 | Holtrop & Mennen 1982                                                                                                                                         |
| [`resistance.holtrop.wave_m1_m2_lambda`](../../docs/METHODOLOGY.md#resistance.holtrop.wave_m1_m2_lambda)               | Exponent terms c15, c16, m1, m2, λ                                                     | Holtrop & Mennen 1982, Holtrop 1984                                                                                                                           |
| [`resistance.holtrop.wave`](../../docs/METHODOLOGY.md#resistance.holtrop.wave)                                         | Wave-making resistance R_W                                                             | Holtrop & Mennen 1982, Holtrop 1984                                                                                                                           |
| [`resistance.holtrop.correlation_allowance`](../../docs/METHODOLOGY.md#resistance.holtrop.correlation_allowance)       | Model-ship correlation allowance C_A and R_A                                           | Holtrop & Mennen 1982                                                                                                                                         |
| [`resistance.total_and_sea_margin`](../../docs/METHODOLOGY.md#resistance.total_and_sea_margin)                         | Total resistance and 15 % sea margin ⚠️                                                | Holtrop & Mennen 1982, MAN ES propulsion margins                                                                                                              |
| [`resistance.power.effective_power`](../../docs/METHODOLOGY.md#resistance.power.effective_power)                       | Effective power P_E                                                                    | [MAN ES, Basic Principles of Ship Propulsion](https://man-es.com/docs/default-source/document-sync-archive/basic-principles-of-ship-propulsion_web_links.pdf) |
| [`resistance.power.propulsive_efficiency`](../../docs/METHODOLOGY.md#resistance.power.propulsive_efficiency)           | Wake, thrust deduction and propulsive efficiency ⚠️                                    | Taylor, Harvald 1983                                                                                                                                          |
| [`resistance.power.transmission_mcr`](../../docs/METHODOLOGY.md#resistance.power.transmission_mcr)                     | Shaft power, brake power and MCR (0.98, 0.98, 0.85) ⚠️                                 | MAN ES propulsion margins, Harvald 1983                                                                                                                       |
| [`weather.open_meteo_current`](../../docs/METHODOLOGY.md#weather.open_meteo_current)                                   | Wind from Open-Meteo at the previous fix                                               | [Open-Meteo API](https://open-meteo.com/en/docs), [licence CC BY 4.0](https://open-meteo.com/en/licence)                                                      |
| [`weather.beaufort_number`](../../docs/METHODOLOGY.md#weather.beaufort_number)                                         | Beaufort number from wind speed in knots (capped at 8) ⚠️                              | WMO-No. 558, Kwon 2008                                                                                                                                        |
| [`weather.encounter_angle`](../../docs/METHODOLOGY.md#weather.encounter_angle)                                         | Wind encounter angle relative to the ship course                                       | Kwon 2008                                                                                                                                                     |
| [`weather.kwon_direction_coefficient`](../../docs/METHODOLOGY.md#weather.kwon_direction_coefficient)                   | Kwon direction reduction coefficient C_β ⚠️                                            | Kwon 2008, Townsin & Kwon 1983                                                                                                                                |
| [`weather.kwon_speed_coefficient`](../../docs/METHODOLOGY.md#weather.kwon_speed_coefficient)                           | Kwon speed reduction coefficient C_U (C_B bands) ⚠️                                    | Kwon 2008                                                                                                                                                     |
| [`weather.kwon_form_coefficient`](../../docs/METHODOLOGY.md#weather.kwon_form_coefficient)                             | Kwon ship form coefficient C_Form (legacy variant) ⚠️                                  | Townsin & Kwon 1983, Kwon 2008                                                                                                                                |
| [`weather.speed_loss_correction`](../../docs/METHODOLOGY.md#weather.speed_loss_correction)                             | Weather speed-loss correction to calm-water speed ⚠️                                   | Kwon 2008, ISO 15016                                                                                                                                          |
| [`fuel.second_formula_me`](../../docs/METHODOLOGY.md#fuel.second_formula_me)                                           | Main-engine fuel in the Holtrop path (MCR × SFOC × time) ⚠️                            | Fourth IMO GHG Study 2020                                                                                                                                     |
| [`fuel.second_formula_ae`](../../docs/METHODOLOGY.md#fuel.second_formula_ae)                                           | Auxiliary-engine fuel in the Holtrop path (not × duration) ⚠️                          | legacy MVP (thesis)                                                                                                                                           |
| [`emission.co2_conversion`](../../docs/METHODOLOGY.md#emission.co2_conversion)                                         | CO2 from fuel mass (C_F)                                                               | IMO MEPC.364(79), MEPC.352(78)                                                                                                                                |
| [`cii.attained_accumulation`](../../docs/METHODOLOGY.md#cii.attained_accumulation)                                     | Attained CII (v2: per calendar year)                                                   | IMO MEPC.352(78) (G1)                                                                                                                                         |
| [`cii.reference_line`](../../docs/METHODOLOGY.md#cii.reference_line)                                                   | CII reference line a × Capacity^(−c)                                                   | IMO MEPC.353(78) (G2)                                                                                                                                         |
| [`cii.reduction_factor_z`](../../docs/METHODOLOGY.md#cii.reduction_factor_z)                                           | Annual reduction factor Z                                                              | IMO MEPC.338(76) (G3), MEPC.400(83)                                                                                                                           |
| [`cii.required`](../../docs/METHODOLOGY.md#cii.required)                                                               | Required CII                                                                           | IMO MEPC.328(76), MEPC.338(76), MEPC.400(83)                                                                                                                  |
| [`cii.rating_grade`](../../docs/METHODOLOGY.md#cii.rating_grade)                                                       | CII rating and A–E grade by the d-vector                                               | IMO MEPC.354(78) (G4)                                                                                                                                         |
| [`cii.dd_vector_boundaries`](../../docs/METHODOLOGY.md#cii.dd_vector_boundaries)                                       | Grade boundaries d_i × required                                                        | IMO MEPC.354(78)                                                                                                                                              |
| [`cii.annual_manual`](../../docs/METHODOLOGY.md#cii.annual_manual)                                                     | Annual CII records entered manually ⚠️                                                 | IMO MEPC.278(70) (DCS), legacy MVP                                                                                                                            |
| `cii.year_end_projection`                                                                                              | Linear year-end projection of the YTD totals, rated as the YTD CII — _proposed id_     | v2                                                                                                                                                            |
| [`seemp.reduction_type1_operational_share`](../../docs/METHODOLOGY.md#seemp.reduction_type1_operational_share)         | SEEMP type-1 reduction (potential × share of year at sea) ⚠️                           | [Bouman et al. 2017](https://doi.org/10.1016/j.trd.2017.03.022)                                                                                               |
| [`seemp.reduction_type2_fuel_switch`](../../docs/METHODOLOGY.md#seemp.reduction_type2_fuel_switch)                     | SEEMP type-2 reduction (fuel switch via C_F) ⚠️                                        | IMO MEPC.364(79), MEPC.1/Circ.905                                                                                                                             |
| [`seemp.reduction_type3_auxiliary`](../../docs/METHODOLOGY.md#seemp.reduction_type3_auxiliary)                         | SEEMP type-3 reduction (auxiliary-energy substitution) ⚠️                              | IMO MEPC.1/Circ.896, IEC/IEEE 80005-1                                                                                                                         |
| [`seemp.cost_by_power`](../../docs/METHODOLOGY.md#seemp.cost_by_power)                                                 | SEEMP investment cost from installed power ⚠️                                          | [IMO GloMEEP technologies portal](https://greenvoyage2050.imo.org/energy-efficiency-technologies-information-portal/)                                         |
| [`seemp.cost_amortization`](../../docs/METHODOLOGY.md#seemp.cost_amortization)                                         | SEEMP cost per year (years until D/E) ⚠️                                               | IMO MEPC.338(76), MEPC.400(83)                                                                                                                                |
| [`seemp.filter_sort_output`](../../docs/METHODOLOGY.md#seemp.filter_sort_output)                                       | Recommendation filter, ranking and output ⚠️                                           | IMO MEPC.328(76), MEPC.346(78)                                                                                                                                |
| [`seemp.measure.air_lubrication`](../../docs/METHODOLOGY.md#seemp.measure.air_lubrication)                             | Measure 1: hull air-cavity lubrication (8 %, LOA cost bands) ⚠️                        | Bouman et al. 2017, ITF 2018                                                                                                                                  |
| [`seemp.measure.resistance_reduction_devices`](../../docs/METHODOLOGY.md#seemp.measure.resistance_reduction_devices)   | Measure 2: resistance reduction devices (9 %, USD 300k–700k) ⚠️                        | legacy MVP (thesis)                                                                                                                                           |
| [`seemp.measure.hull_coating`](../../docs/METHODOLOGY.md#seemp.measure.hull_coating)                                   | Measure 3: hull coating maintenance (10 %, USD 100/m² of wetted surface) ⚠️            | Bouman et al. 2017                                                                                                                                            |
| [`seemp.measure.power_system_machinery`](../../docs/METHODOLOGY.md#seemp.measure.power_system_machinery)               | Measure 4: variable speed electric power generation (10 %, USD 500/kW ME) ⚠️           | legacy MVP (thesis)                                                                                                                                           |
| [`seemp.measure.propulsion_efficiency_devices`](../../docs/METHODOLOGY.md#seemp.measure.propulsion_efficiency_devices) | Measure 5: propulsion efficiency devices (13 %, USD 100k–800k) ⚠️                      | Bouman et al. 2017, ITF 2018                                                                                                                                  |
| [`seemp.measure.waste_heat_recovery`](../../docs/METHODOLOGY.md#seemp.measure.waste_heat_recovery)                     | Measure 6: waste heat recovery (10 %, USD 100/kW) ⚠️                                   | Bouman et al. 2017, ITF 2018                                                                                                                                  |
| [`seemp.measure.lng`](../../docs/METHODOLOGY.md#seemp.measure.lng)                                                     | Measure 7: LNG for ME and AE (C_F 2.75, USD 1,580/kW) ⚠️                               | IMO MEPC.364(79), ITF 2018                                                                                                                                    |
| [`seemp.measure.biofuel`](../../docs/METHODOLOGY.md#seemp.measure.biofuel)                                             | Measure 8: biofuels for ME and AE (C_F 2.45, USD 20/kW) ⚠️                             | IMO MEPC.1/Circ.905                                                                                                                                           |
| [`seemp.measure.solar`](../../docs/METHODOLOGY.md#seemp.measure.solar)                                                 | Measure 9: solar panels (AE × 0.88, USD 3,000/kW AE) ⚠️                                | Bouman et al. 2017, ITF 2018                                                                                                                                  |
| [`seemp.measure.wind`](../../docs/METHODOLOGY.md#seemp.measure.wind)                                                   | Measure 10: wind power (AE × 0.85, USD 4,000/kW AE) ⚠️                                 | Bouman et al. 2017                                                                                                                                            |
| [`seemp.measure.cold_ironing`](../../docs/METHODOLOGY.md#seemp.measure.cold_ironing)                                   | Measure 11: cold ironing (AE(1 − v/100) + 0.8·AE·v/100, USD 0.5/kW AE + 800,150) ⚠️    | IEC/IEEE 80005-1, Bouman et al. 2017                                                                                                                          |
| [`seemp.measure.fuel_cells`](../../docs/METHODOLOGY.md#seemp.measure.fuel_cells)                                       | Measure 12: fuel cells (AE × 0.8, USD 1,780/kW AE) ⚠️                                  | Bouman et al. 2017                                                                                                                                            |
| `seemp.simulation_combination`                                                                                         | What-if combination of measures (sequential multiplicative) — _proposed id_            | v2                                                                                                                                                            |
| `emission.dcs_summary`                                                                                                 | IMO DCS-style annual summary (hours under way ≥ 1 kn) — _proposed id_                  | IMO MEPC.278(70) / MEPC.385(81), Fourth IMO GHG Study 2020                                                                                                    |

The four _proposed_ ids are implemented here but not yet in the shipped catalog
(`docs/references/methods.json`); the methodology endpoint lists them as `catalogued: false`.
