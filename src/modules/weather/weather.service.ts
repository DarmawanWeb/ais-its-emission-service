import { InjectConfig } from '@darmawanweb/ais-its-nest';
import { MetricsService } from '@darmawanweb/ais-its-nest/metrics';
import { InjectRedis, type Redis } from '@darmawanweb/ais-its-nest/redis';
import { Injectable, Logger } from '@nestjs/common';
import type { Counter } from 'prom-client';
import * as z from 'zod';

import type { Config } from '../../config.js';
import { CALM_WIND, type Wind } from '../../domain/weather/types.js';
import { CircuitBreaker } from './circuit-breaker.js';
import { OpenMeteoClient } from './open-meteo.client.js';
import { weatherCacheKey, type WeatherCellHour, weatherCellHour } from './weather-cell.js';

const CachedWindSchema = z.object({ speedKn: z.number(), directionDeg: z.number() });

/** The wind used for a segment and where it came from. */
export interface WindObservation {
  readonly wind: Wind;
  /** `open-meteo`, or `calm_fallback` when the weather was unavailable. */
  readonly source: 'open-meteo' | 'calm_fallback';
  readonly cell: WeatherCellHour;
}

/**
 * Wind for the Holtrop path: Valkey cache per 0.25° cell and UTC hour →
 * Open-Meteo (3 s timeout) behind a circuit breaker → calm weather with
 * source `calm_fallback` (the segment gets the flag `weather_unavailable`).
 * Metrics: `aisits_weather_cache_hits_total`, `aisits_weather_requests_total{outcome}`.
 *
 * @method weather.open_meteo_current
 */
@Injectable()
export class WeatherService {
  private readonly logger = new Logger(WeatherService.name);
  private readonly breaker: CircuitBreaker;
  private readonly cacheHits: Counter;
  private readonly requests: Counter<'outcome'>;

  constructor(
    @InjectConfig() private readonly config: Config,
    @InjectRedis() private readonly redis: Redis,
    private readonly client: OpenMeteoClient,
    metrics: MetricsService,
  ) {
    this.breaker = new CircuitBreaker(config.WEATHER_BREAKER_THRESHOLD, config.WEATHER_BREAKER_COOLDOWN_MS);
    this.cacheHits = metrics.counter({ name: 'weather_cache_hits_total', help: 'Weather lookups answered from the Valkey cache' });
    this.requests = metrics.counter({
      name: 'weather_requests_total',
      help: 'Open-Meteo requests by outcome (ok, error, breaker_open, disabled)',
      labelNames: ['outcome'],
    });
  }

  /** The wind at a position (previous fix) and time (segment start). */
  async windAt(lat: number, lon: number, time: Date): Promise<WindObservation> {
    const cell = weatherCellHour(lat, lon, time);
    if (!this.config.WEATHER_ENABLED) {
      this.requests.inc({ outcome: 'disabled' });
      return { wind: CALM_WIND, source: 'calm_fallback', cell };
    }
    const cached = await this.readCache(cell);
    if (cached !== undefined) {
      this.cacheHits.inc();
      return { wind: cached, source: 'open-meteo', cell };
    }
    if (!this.breaker.tryAcquire()) {
      this.requests.inc({ outcome: 'breaker_open' });
      return { wind: CALM_WIND, source: 'calm_fallback', cell };
    }
    try {
      const wind = await this.client.getCurrentWind(cell);
      this.breaker.success();
      this.requests.inc({ outcome: 'ok' });
      await this.writeCache(cell, wind);
      return { wind, source: 'open-meteo', cell };
    } catch (error) {
      this.breaker.failure();
      this.requests.inc({ outcome: 'error' });
      this.logger.warn({ err: error, cell, breaker: this.breaker.state }, 'weather unavailable, using calm weather');
      return { wind: CALM_WIND, source: 'calm_fallback', cell };
    }
  }

  private async readCache(cell: WeatherCellHour): Promise<Wind | undefined> {
    try {
      const raw = await this.redis.get(weatherCacheKey(cell));
      if (raw === null) return undefined;
      const parsed = CachedWindSchema.safeParse(JSON.parse(raw));
      return parsed.success ? parsed.data : undefined;
    } catch (error) {
      this.logger.warn({ err: error }, 'weather cache read failed');
      return undefined;
    }
  }

  private async writeCache(cell: WeatherCellHour, wind: Wind): Promise<void> {
    try {
      await this.redis.set(weatherCacheKey(cell), JSON.stringify(wind), 'EX', this.config.WEATHER_CACHE_TTL_S);
    } catch (error) {
      this.logger.warn({ err: error }, 'weather cache write failed');
    }
  }
}
