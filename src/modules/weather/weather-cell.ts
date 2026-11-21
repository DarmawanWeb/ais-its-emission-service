/** Edge of a weather cache cell, degrees (spec §13.5: 0.25° grid). */
export const WEATHER_CELL_DEG = 0.25;

/** A weather cell (grid point) and hour. */
export interface WeatherCellHour {
  /** Latitude of the grid point, degrees (multiple of 0.25). */
  readonly lat: number;
  /** Longitude of the grid point, degrees (multiple of 0.25, −180 ≤ lon < 180). */
  readonly lon: number;
  /** UTC hour, `YYYY-MM-DDTHH:00` (Open-Meteo `start_hour` format). */
  readonly hour: string;
}

function snap(value: number): number {
  // `+ 0` turns -0 into 0 so that keys are stable.
  return Math.round(value / WEATHER_CELL_DEG) * WEATHER_CELL_DEG + 0;
}

/**
 * The 0.25° grid point nearest to a position and the UTC hour of a time: the
 * weather of every position of the cell during that hour is the same, which
 * makes segments reproducible (replays) and the cache effective.
 */
export function weatherCellHour(lat: number, lon: number, time: Date): WeatherCellHour {
  const cellLon = snap(lon);
  return {
    lat: Math.min(Math.max(snap(lat), -90), 90),
    lon: cellLon >= 180 ? cellLon - 360 : cellLon,
    hour: `${time.toISOString().slice(0, 13)}:00`,
  };
}

/** Valkey key of a cell-hour. */
export function weatherCacheKey(cell: WeatherCellHour): string {
  return `weather:v1:${cell.lat.toFixed(2)}:${cell.lon.toFixed(2)}:${cell.hour}`;
}
