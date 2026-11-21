/** Wind at a place and hour (Open-Meteo 10 m wind). */
export interface Wind {
  /** Wind speed, knots. */
  readonly speedKn: number;
  /** Direction the wind comes from, degrees clockwise from north (0–360). */
  readonly directionDeg: number;
}

/** Calm weather: the fallback when the weather service is unavailable. */
export const CALM_WIND: Wind = Object.freeze({ speedKn: 0, directionDeg: 0 });

/** Wind relative to the ship (legacy `IWindCourse`). */
export interface WindCourse {
  /** Beaufort number 0–8. */
  readonly beaufortNumber: number;
  /** Encounter angle between ship course and wind direction, degrees (0–180). */
  readonly encounterAngleDeg: number;
}
