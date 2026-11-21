import {
  type AppConfig,
  defineConfig,
  envBoolean,
  envInteger,
  envUrl,
  ServiceNameSchema,
  SqlIdentifierSchema,
} from '@darmawanweb/ais-its-nest';
import * as z from 'zod';

import { SERVICE } from './service.js';

/**
 * Environment of the service: the platform base variables (spec §4) with this
 * service's defaults, plus its own variables (spec §13.5). Add a variable here
 * and to `.env.example`; `loadConfig()` refuses to start on invalid values and
 * prints every problem.
 */
export const configSchema = defineConfig({
  SERVICE_NAME: ServiceNameSchema.default(SERVICE.name),
  SERVICE_VERSION: z.string().min(1).default(SERVICE.version),
  PORT: envInteger(0, 65_535).default(SERVICE.port),
  DATABASE_SCHEMA: SqlIdentifierSchema.default(SERVICE.schema),

  /** Longest time between two fixes that still forms a segment, minutes. */
  SEGMENT_MAX_GAP_MIN: envInteger(1, 10_080).default(360),
  /** Telemetry counts as active within this many minutes of a reading (spec §13.4). */
  TELEMETRY_ACTIVE_WINDOW_MIN: envInteger(1, 1_440).default(10),
  /** Minimum interval between two emission.cii.updated.v1 of a vessel, seconds. */
  CII_PUBLISH_INTERVAL_S: envInteger(1, 86_400).default(60),
  /** How often pending CII publications are checked, milliseconds. */
  CII_PUBLISH_POLL_MS: envInteger(50, 600_000).default(5_000),
  /** Longest delay before late segment changes (older days) reach the CII aggregates, milliseconds. */
  CII_AGGREGATE_REFRESH_MS: envInteger(100, 3_600_000).default(30_000),
  /** Longest range of a recomputation by replay, days (AIS_POSITION keeps 7 d). */
  RECOMPUTE_MAX_DAYS: envInteger(1, 7).default(7),

  /** Base URL of the Open-Meteo API (forecast endpoint at /v1/forecast). */
  WEATHER_API_URL: envUrl(['http', 'https']).default(
    'https://api.open-meteo.com',
  ),
  /** `false` uses calm weather (flag weather_unavailable) without any request. */
  WEATHER_ENABLED: envBoolean().default(true),
  /** Timeout of one weather request, milliseconds. */
  WEATHER_TIMEOUT_MS: envInteger(100, 60_000).default(3_000),
  /** Lifetime of a cached weather cell-hour in Valkey, seconds. */
  WEATHER_CACHE_TTL_S: envInteger(60, 31_536_000).default(604_800),
  /** Consecutive failures that open the weather circuit breaker. */
  WEATHER_BREAKER_THRESHOLD: envInteger(1, 1_000).default(5),
  /** Time the open breaker answers calm weather without requests, milliseconds. */
  WEATHER_BREAKER_COOLDOWN_MS: envInteger(1_000, 3_600_000).default(60_000),
});

/** Validated configuration; inject it with `@InjectConfig() config: Config`. */
export type Config = AppConfig<typeof configSchema>;
