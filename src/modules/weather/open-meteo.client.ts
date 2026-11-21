import { InjectConfig } from '@darmawanweb/ais-its-nest';
import { Injectable } from '@nestjs/common';
import * as z from 'zod';

import type { Config } from '../../config.js';
import type { Wind } from '../../domain/weather/types.js';
import type { WeatherCellHour } from './weather-cell.js';

const HourlyWindSchema = z.object({
  hourly: z.object({
    time: z.array(z.string()),
    wind_speed_10m: z.array(z.number().nullable()),
    wind_direction_10m: z.array(z.number().nullable()),
  }),
});

/** The weather service answered with an error or an unusable body. */
export class WeatherRequestError extends Error {
  override readonly name = 'WeatherRequestError';
}

/**
 * Open-Meteo forecast API client (`GET {WEATHER_API_URL}/v1/forecast`): the
 * hourly 10 m wind (`wind_speed_10m`, `wind_direction_10m`, knots) of one
 * grid point and UTC hour. The legacy requested `current_weather=true` at the
 * previous fix at processing time; v2 asks for the segment's hour so that
 * replays give the same weather (forecast API: past 92 days).
 *
 * @method weather.open_meteo_current
 * @see https://open-meteo.com/en/docs (forecast API)
 * @see https://open-meteo.com/en/licence (CC BY 4.0 — "Weather data by Open-Meteo.com")
 */
@Injectable()
export class OpenMeteoClient {
  constructor(@InjectConfig() private readonly config: Config) {}

  /** The wind of a cell-hour; rejects on network errors, timeouts and bad answers. */
  async getCurrentWind(cell: WeatherCellHour): Promise<Wind> {
    const url = new URL('/v1/forecast', this.config.WEATHER_API_URL);
    url.searchParams.set('latitude', cell.lat.toFixed(2));
    url.searchParams.set('longitude', cell.lon.toFixed(2));
    url.searchParams.set('hourly', 'wind_speed_10m,wind_direction_10m');
    url.searchParams.set('wind_speed_unit', 'kn');
    url.searchParams.set('timezone', 'GMT');
    url.searchParams.set('start_hour', cell.hour);
    url.searchParams.set('end_hour', cell.hour);
    const response = await fetch(url, {
      headers: { accept: 'application/json', 'user-agent': 'ais-its-emission-service' },
      redirect: 'error',
      signal: AbortSignal.timeout(this.config.WEATHER_TIMEOUT_MS),
    });
    if (!response.ok) throw new WeatherRequestError(`Open-Meteo answered ${response.status}`);
    const body = HourlyWindSchema.safeParse(await response.json());
    if (!body.success) throw new WeatherRequestError('Open-Meteo answer without hourly wind');
    const index = body.data.hourly.time.findIndex((time) => time === cell.hour);
    const speedKn = body.data.hourly.wind_speed_10m[index];
    const directionDeg = body.data.hourly.wind_direction_10m[index];
    if (index === -1 || speedKn == null || directionDeg == null) {
      throw new WeatherRequestError(`Open-Meteo has no wind for ${cell.hour}`);
    }
    return { speedKn, directionDeg };
  }
}
