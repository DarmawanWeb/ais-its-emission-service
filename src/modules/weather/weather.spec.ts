import { loadConfig } from '@darmawanweb/ais-its-nest';
import { MetricsService } from '@darmawanweb/ais-its-nest/metrics';
import type { Redis } from '@darmawanweb/ais-its-nest/redis';
import { Logger } from '@nestjs/common';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { FakeOpenMeteo } from '../../../test/support/fake-open-meteo.js';
import { type Config, configSchema } from '../../config.js';
import { CircuitBreaker } from './circuit-breaker.js';
import { OpenMeteoClient, WeatherRequestError } from './open-meteo.client.js';
import { weatherCacheKey, weatherCellHour } from './weather-cell.js';
import { WeatherService } from './weather.service.js';

describe('weatherCellHour', () => {
  it('snaps to the nearest 0.25° grid point and the UTC hour', () => {
    expect(
      weatherCellHour(1.1, 104.13, new Date('2026-03-10T08:59:59Z')),
    ).toEqual({ lat: 1, lon: 104.25, hour: '2026-03-10T08:00' });
    expect(
      weatherCellHour(-6.88, -0.1, new Date('2026-03-10T23:00:00Z')),
    ).toEqual({ lat: -7, lon: 0, hour: '2026-03-10T23:00' });
    expect(
      weatherCellHour(0, 179.9, new Date('2026-03-10T00:00:00Z')).lon,
    ).toBe(-180);
  });

  it('builds a stable cache key', () => {
    expect(
      weatherCacheKey({ lat: -6.75, lon: 112.5, hour: '2026-03-10T08:00' }),
    ).toBe('weather:v1:-6.75:112.50:2026-03-10T08:00');
  });
});

describe('CircuitBreaker', () => {
  it('opens after the threshold, lets one trial through after the cooldown and closes on success', () => {
    let now = 0;
    const breaker = new CircuitBreaker(2, 1_000, () => now);
    expect(breaker.tryAcquire()).toBe(true);
    breaker.failure();
    expect(breaker.state).toBe('closed');
    breaker.failure();
    expect(breaker.state).toBe('open');
    expect(breaker.tryAcquire()).toBe(false);
    now = 1_000;
    expect(breaker.state).toBe('half_open');
    expect(breaker.tryAcquire()).toBe(true);
    expect(breaker.tryAcquire()).toBe(false);
    breaker.failure();
    expect(breaker.state).toBe('open');
    now = 2_000;
    expect(breaker.tryAcquire()).toBe(true);
    breaker.success();
    expect(breaker.state).toBe('closed');
  });
});

/** In-memory replacement of the two Valkey commands the weather cache uses. */
class FakeRedis {
  readonly store = new Map<string, string>();
  failing = false;

  get(key: string): Promise<string | null> {
    if (this.failing) return Promise.reject(new Error('valkey down'));
    return Promise.resolve(this.store.get(key) ?? null);
  }

  set(key: string, value: string): Promise<'OK'> {
    if (this.failing) return Promise.reject(new Error('valkey down'));
    this.store.set(key, value);
    return Promise.resolve('OK');
  }
}

describe('Open-Meteo client and weather service', () => {
  const fake = new FakeOpenMeteo();
  let config: Config;

  beforeAll(async () => {
    // the fallback paths log warnings on purpose
    Logger.overrideLogger(false);
    const url = await fake.start();
    config = loadConfig(configSchema, {
      env: {
        LOG_LEVEL: 'silent',
        WEATHER_API_URL: url,
        WEATHER_TIMEOUT_MS: '200',
        WEATHER_BREAKER_THRESHOLD: '2',
        WEATHER_BREAKER_COOLDOWN_MS: '60000',
      },
      envFile: false,
      output: null,
    });
  });

  afterAll(async () => {
    await fake.stop();
  });

  let mode: 'ok' | 'error' | 'slow' | 'garbage' = 'ok';

  beforeEach(() => {
    fake.requests.length = 0;
    mode = 'ok';
    fake.answer = () => {
      switch (mode) {
        case 'ok':
          return { kind: 'wind', speedKn: 17.5, directionDeg: 225 };
        case 'error':
          return { kind: 'error', status: 503 };
        case 'slow':
          return { kind: 'hang' };
        case 'garbage':
          return { kind: 'garbage' };
      }
    };
  });

  function service(redis = new FakeRedis()): {
    weather: WeatherService;
    redis: FakeRedis;
    metrics: MetricsService;
  } {
    const metrics = new MetricsService();
    // The service only calls get/set (see FakeRedis).
    const weather = new WeatherService(
      config,
      redis as unknown as Redis,
      new OpenMeteoClient(config),
      metrics,
    );
    return { weather, redis, metrics };
  }

  it('asks for the hourly 10 m wind of the cell-hour in knots', async () => {
    const wind = await new OpenMeteoClient(config).getCurrentWind({
      lat: 1,
      lon: 104,
      hour: '2026-03-10T08:00',
    });
    expect(wind).toEqual({ speedKn: 17.5, directionDeg: 225 });
    expect(fake.requests[0]?.path).toBe('/v1/forecast');
    expect(fake.requests[0]?.query).toEqual({
      latitude: '1.00',
      longitude: '104.00',
      hourly: 'wind_speed_10m,wind_direction_10m',
      wind_speed_unit: 'kn',
      timezone: 'GMT',
      start_hour: '2026-03-10T08:00',
      end_hour: '2026-03-10T08:00',
    });
  });

  it('rejects errors, unusable bodies and timeouts', async () => {
    const client = new OpenMeteoClient(config);
    const cell = { lat: 1, lon: 104, hour: '2026-03-10T08:00' };
    mode = 'error';
    await expect(client.getCurrentWind(cell)).rejects.toThrow(
      WeatherRequestError,
    );
    mode = 'garbage';
    await expect(client.getCurrentWind(cell)).rejects.toThrow(
      WeatherRequestError,
    );
    mode = 'slow';
    await expect(client.getCurrentWind(cell)).rejects.toThrow(
      /aborted|timeout/i,
    );
  });

  it('caches per cell and hour', async () => {
    const { weather, redis, metrics } = service();
    const time = new Date('2026-03-10T08:10:00Z');
    const first = await weather.windAt(1.1, 104.0, time);
    const second = await weather.windAt(
      1.05,
      103.95,
      new Date('2026-03-10T08:50:00Z'),
    );
    expect(first).toEqual({
      wind: { speedKn: 17.5, directionDeg: 225 },
      source: 'open-meteo',
      cell: { lat: 1, lon: 104, hour: '2026-03-10T08:00' },
    });
    expect(second.wind).toEqual(first.wind);
    expect(fake.requests).toHaveLength(1);
    expect([...redis.store.keys()]).toEqual([
      'weather:v1:1.00:104.00:2026-03-10T08:00',
    ]);
    expect(await metrics.render()).toContain(
      'aisits_weather_cache_hits_total 1',
    );
  });

  it('falls back to calm weather on failure and stops asking while the breaker is open', async () => {
    const { weather } = service();
    mode = 'error';
    const time = new Date('2026-03-10T09:00:00Z');
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const observation = await weather.windAt(2, 105 + attempt, time);
      expect(observation).toMatchObject({
        wind: { speedKn: 0, directionDeg: 0 },
        source: 'calm_fallback',
      });
    }
    expect(fake.requests).toHaveLength(2);
  });

  it('works without the cache when Valkey fails', async () => {
    const redis = new FakeRedis();
    redis.failing = true;
    const { weather } = service(redis);
    const observation = await weather.windAt(
      3,
      106,
      new Date('2026-03-10T10:00:00Z'),
    );
    expect(observation.source).toBe('open-meteo');
  });
});
