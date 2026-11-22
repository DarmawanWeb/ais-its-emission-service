// Drizzle definitions of the "emission" schema (docs/PLATFORM_SPEC.md §6).
// The SQL files in migrations/ create the tables; these definitions MUST
// mirror them and only type the queries.
import type { VesselSnapshotV1 } from '@darmawanweb/ais-its-contracts/events';
import * as pg from 'drizzle-orm/pg-core';

import type {
  SeempCostModel,
  SeempReductionModel,
} from '../domain/seemp/measures.js';

/** The service's PostgreSQL schema, owned by the role `emission_svc`. */
export const serviceSchema = pg.pgSchema('emission');

const timestamps = {
  createdAt: pg
    .timestamp('created_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: pg
    .timestamp('updated_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
};

/** FLEET projection (`0001_init.sql`). */
export const vesselProfiles = serviceSchema.table('vessel_profiles', {
  vesselId: pg.uuid('vessel_id').primaryKey(),
  mmsi: pg.integer('mmsi').notNull().unique(),
  orgId: pg.uuid('org_id'),
  snapshot: pg.jsonb('snapshot').$type<VesselSnapshotV1>().notNull(),
  snapshotUpdatedAt: pg
    .timestamp('snapshot_updated_at', { withTimezone: true })
    .notNull(),
  ...timestamps,
});

/** Telemetry readings hypertable (`0001_init.sql`). */
export const fuelReadings = serviceSchema.table(
  'fuel_readings',
  {
    time: pg.timestamp('time', { withTimezone: true }).notNull(),
    mmsi: pg.integer('mmsi').notNull(),
    periodStart: pg.timestamp('period_start', { withTimezone: true }),
    fuelMeTon: pg.doublePrecision('fuel_me_ton').notNull(),
    fuelAeTon: pg.doublePrecision('fuel_ae_ton').notNull(),
    deviceId: pg.uuid('device_id'),
    source: pg.text('source').notNull(),
    receivedAt: pg
      .timestamp('received_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [pg.primaryKey({ columns: [table.mmsi, table.time] })],
);

/** Weather used by a Holtrop segment (`segments.weather`). */
export interface SegmentWeather {
  /** Wind speed, kn. */
  readonly windSpeedKn: number;
  /** Wind direction, degrees. */
  readonly windDirectionDeg: number;
  readonly beaufortNumber: number;
  readonly encounterAngleDeg: number;
  /** `open-meteo` or `calm_fallback`. */
  readonly source: 'open-meteo' | 'calm_fallback';
  /** Centre of the 0.25° cell and the UTC hour the wind belongs to. */
  readonly cell: { readonly lat: number; readonly lon: number };
  readonly hour: string;
}

/** Voyage segments hypertable (`0001_init.sql`, vessel index `0004_vessel_scoped_history.sql`). */
export const segments = serviceSchema.table(
  'segments',
  {
    timeStart: pg.timestamp('time_start', { withTimezone: true }).notNull(),
    timeEnd: pg.timestamp('time_end', { withTimezone: true }).notNull(),
    mmsi: pg.integer('mmsi').notNull(),
    vesselId: pg.uuid('vessel_id').notNull(),
    distanceNm: pg.doublePrecision('distance_nm').notNull(),
    speedKn: pg.doublePrecision('speed_kn').notNull(),
    fuelMeTon: pg.doublePrecision('fuel_me_ton').notNull(),
    fuelAeTon: pg.doublePrecision('fuel_ae_ton').notNull(),
    co2Ton: pg.doublePrecision('co2_ton').notNull(),
    method: pg
      .text('method', {
        enum: ['telemetry', 'first_formula', 'holtrop', 'none'],
      })
      .notNull(),
    navstatus: pg.smallint('navstatus').notNull(),
    fuelCode: pg.text('fuel_code').notNull(),
    conversionFactor: pg.doublePrecision('conversion_factor').notNull(),
    weather: pg.jsonb('weather').$type<SegmentWeather>(),
    flags: pg.text('flags').array().notNull().default([]),
    computedAt: pg
      .timestamp('computed_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    pg.primaryKey({ columns: [table.mmsi, table.timeStart] }),
    pg
      .index('segments_vessel_time_idx')
      .on(table.vesselId, table.timeStart.desc()),
  ],
);

/** Reduction factors Z (`0001_init.sql`, seeded in `0002_seed.sql`). */
export const reductionFactors = serviceSchema.table('reduction_factors', {
  year: pg.integer('year').primaryKey(),
  zPercent: pg.doublePrecision('z_percent').notNull(),
  source: pg.text('source').notNull(),
  ...timestamps,
});

/** Manual / imported annual CII per vessel-year (`0001_init.sql`, `0004_vessel_scoped_history.sql`). */
export const ciiAnnualManual = serviceSchema.table(
  'cii_annual_manual',
  {
    vesselId: pg.uuid('vessel_id').notNull(),
    /** MMSI of the vessel when the record was written (informational). */
    mmsi: pg.integer('mmsi').notNull(),
    year: pg.integer('year').notNull(),
    attained: pg.doublePrecision('attained').notNull(),
    required: pg.doublePrecision('required'),
    rating: pg.doublePrecision('rating'),
    grade: pg.text('grade', { enum: ['A', 'B', 'C', 'D', 'E'] }),
    distanceNm: pg.doublePrecision('distance_nm').notNull(),
    fuelMeTon: pg.doublePrecision('fuel_me_ton').notNull(),
    fuelAeTon: pg.doublePrecision('fuel_ae_ton').notNull(),
    co2Ton: pg.doublePrecision('co2_ton'),
    note: pg.text('note'),
    updatedBy: pg.uuid('updated_by'),
    ...timestamps,
  },
  (table) => [pg.primaryKey({ columns: [table.vesselId, table.year] })],
);

/** SEEMP measure catalog (`0001_init.sql`, seeded in `0002_seed.sql`). */
export const seempMeasures = serviceSchema.table('seemp_measures', {
  code: pg.text('code').primaryKey(),
  name: pg.text('name').notNull(),
  category: pg
    .text('category', { enum: ['technical', 'operational', 'fuel', 'energy'] })
    .notNull(),
  legacyOrder: pg.integer('legacy_order').notNull().unique(),
  methodId: pg.text('method_id').notNull(),
  reduction: pg.jsonb('reduction').$type<SeempReductionModel>().notNull(),
  cost: pg.jsonb('cost').$type<SeempCostModel>().notNull(),
  source: pg.text('source').notNull(),
  ...timestamps,
});

/** Saved SEEMP simulations (`0001_init.sql`). */
export const seempScenarios = serviceSchema.table(
  'seemp_scenarios',
  {
    id: pg.uuid('id').primaryKey(),
    orgId: pg.uuid('org_id'),
    mmsi: pg.integer('mmsi').notNull(),
    vesselId: pg.uuid('vessel_id').notNull(),
    name: pg.text('name').notNull(),
    measureCodes: pg.text('measure_codes').array().notNull(),
    baselineYear: pg.integer('baseline_year').notNull(),
    targetYear: pg.integer('target_year').notNull(),
    result: pg.jsonb('result').$type<Record<string, unknown>>().notNull(),
    createdBy: pg.uuid('created_by').notNull(),
    ...timestamps,
  },
  (table) => [
    pg
      .index('seemp_scenarios_org_created_idx')
      .on(table.orgId, table.createdAt.desc(), table.id.desc()),
    pg.index('seemp_scenarios_mmsi_idx').on(table.mmsi),
  ],
);

/** Throttle state of `emission.cii.updated.v1` (`0001_init.sql`). */
export const ciiPublication = serviceSchema.table('cii_publication', {
  mmsi: pg.integer('mmsi').primaryKey(),
  dirtySince: pg.timestamp('dirty_since', { withTimezone: true }),
  lastPublishedAt: pg.timestamp('last_published_at', { withTimezone: true }),
  lastYear: pg.integer('last_year'),
});

/** Recomputations by replay (`0001_init.sql`, `0004_vessel_scoped_history.sql`). */
export const recomputeJobs = serviceSchema.table('recompute_jobs', {
  id: pg.uuid('id').primaryKey(),
  mmsi: pg.integer('mmsi').notNull(),
  /** The vessel whose segments are rebuilt (`null` for jobs created before 0004). */
  vesselId: pg.uuid('vessel_id'),
  fromTime: pg.timestamp('from_time', { withTimezone: true }).notNull(),
  toTime: pg.timestamp('to_time', { withTimezone: true }).notNull(),
  status: pg
    .text('status', { enum: ['running', 'succeeded', 'failed'] })
    .notNull(),
  requestedBy: pg.uuid('requested_by'),
  replayed: pg.integer('replayed').notNull().default(0),
  segments: pg.integer('segments').notNull().default(0),
  deleted: pg.integer('deleted').notNull().default(0),
  error: pg.text('error'),
  createdAt: pg
    .timestamp('created_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
  finishedAt: pg.timestamp('finished_at', { withTimezone: true }),
  /** Written while the job runs; a running job with a stale heartbeat was interrupted. */
  heartbeatAt: pg
    .timestamp('heartbeat_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
});

const aggregateColumns = {
  vesselId: pg.uuid('vessel_id').notNull(),
  distanceNm: pg.doublePrecision('distance_nm').notNull(),
  fuelMeTon: pg.doublePrecision('fuel_me_ton').notNull(),
  fuelAeTon: pg.doublePrecision('fuel_ae_ton').notNull(),
  co2Ton: pg.doublePrecision('co2_ton').notNull(),
  segments: pg.bigint('segments', { mode: 'number' }).notNull(),
  telemetrySegments: pg
    .bigint('telemetry_segments', { mode: 'number' })
    .notNull(),
  firstFormulaSegments: pg
    .bigint('first_formula_segments', { mode: 'number' })
    .notNull(),
  holtropSegments: pg.bigint('holtrop_segments', { mode: 'number' }).notNull(),
  excludedSegments: pg
    .bigint('excluded_segments', { mode: 'number' })
    .notNull(),
  lastTime: pg.timestamp('last_time', { withTimezone: true }),
};

/** Continuous aggregate `cii_daily` per vessel-day (`0005_cii_aggregates_per_vessel.sql`). */
export const ciiDaily = serviceSchema
  .view('cii_daily', {
    day: pg.timestamp('day', { withTimezone: true }).notNull(),
    ...aggregateColumns,
  })
  .existing();

/** Hierarchical continuous aggregate `cii_annual` per vessel-year on `cii_daily` (`0005_cii_aggregates_per_vessel.sql`). */
export const ciiAnnual = serviceSchema
  .view('cii_annual', {
    year: pg.timestamp('year', { withTimezone: true }).notNull(),
    ...aggregateColumns,
  })
  .existing();
