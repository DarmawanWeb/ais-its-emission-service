import {
  knotsToMs,
  legacyHaversineDistance,
} from '@darmawanweb/ais-its-contracts/domain';

/** A position fix: WGS84 degrees and the position time. */
export interface Fix {
  /** Latitude, decimal degrees (WGS84). */
  readonly lat: number;
  /** Longitude, decimal degrees (WGS84). */
  readonly lon: number;
  readonly time: Date;
}

/** A location in radians (legacy `ILocation` after `positionToRadians`). */
export interface RadianLocation {
  /** Latitude, rad. */
  readonly lat: number;
  /** Longitude, rad. */
  readonly lon: number;
}

/**
 * Kinematics of a voyage segment between two fixes (legacy
 * `ISpeedCalculation`, `be-legacy/src/types/second-formula.types.ts`).
 */
export interface SegmentKinematics {
  /** Current fix in radians (legacy `firstPositionRad` = `positions[0]`). */
  readonly currentRad: RadianLocation;
  /** Previous fix in radians (legacy `secondPositionRad` = `positions[1]`). */
  readonly previousRad: RadianLocation;
  /** Great-circle distance, nautical miles (R = 3438 nm). */
  readonly distanceNm: number;
  /** The same distance in metres (`distanceNm × 1852`). */
  readonly distanceM: number;
  /** Mean speed over ground, knots, capped at {@link SPEED_CAP_KN}. */
  readonly speedKn: number;
  /** {@link speedKn} in m/s with the legacy factor 0.5144. */
  readonly speedMs: number;
  /** Absolute time between the fixes, hours. */
  readonly durationHours: number;
  /** Absolute time between the fixes, minutes. */
  readonly durationMinutes: number;
}

/** Upper bound of the segment speed, knots (legacy `Math.min(speedKnot, 30)`). */
// SOURCE: thesis — needs citation (cap value chosen in the MVP)
export const SPEED_CAP_KN = 30;

const MS_PER_HOUR = 3_600_000;

/** `degrees × (π / 180)` exactly as the legacy `degreesToRadians`. */
function toRadians(degrees: number): number {
  return degrees * (Math.PI / 180);
}

/**
 * Distance and mean speed of the segment `previous → current`.
 *
 * Distance: haversine on a sphere of radius R = 3438 nm (contracts
 * `legacyHaversineDistance`). Time: `|t_current − t_previous|` in hours.
 * Speed: `min(distance / time, 30)` kn, `speedMs = speedKn × 0.5144`; a zero
 * time difference yields speed and time 0 (legacy branch kept).
 *
 * Port of `calculateDistance` / `calculateSpeed`
 * (`be-legacy/src/utils/cii/speed-calculation.ts`), called by the legacy with
 * `positions = [current, previous]` — the same order is used here, so the
 * radians and the course derived from them are bit-identical.
 *
 * @method geo.speed_from_positions
 * @method geo.haversine_distance
 * @see docs/METHODOLOGY.md#geo.speed_from_positions
 * @see https://www.movable-type.co.uk/scripts/latlong.html (haversine)
 */
export function calculateSpeed(current: Fix, previous: Fix): SegmentKinematics {
  const currentRad = { lat: toRadians(current.lat), lon: toRadians(current.lon) };
  const previousRad = {
    lat: toRadians(previous.lat),
    lon: toRadians(previous.lon),
  };
  const distance = legacyHaversineDistance(current, previous);
  const durationHours =
    Math.abs(current.time.getTime() - previous.time.getTime()) / MS_PER_HOUR;

  if (durationHours === 0) {
    return {
      currentRad,
      previousRad,
      distanceNm: distance.nm,
      distanceM: distance.meters,
      speedKn: 0,
      speedMs: 0,
      durationHours: 0,
      durationMinutes: 0,
    };
  }

  const speedKn = Math.min(distance.nm / durationHours, SPEED_CAP_KN);
  return {
    currentRad,
    previousRad,
    distanceNm: distance.nm,
    distanceM: distance.meters,
    speedKn,
    speedMs: knotsToMs(speedKn),
    durationHours,
    durationMinutes: durationHours * 60,
  };
}

/** Why a position pair does not produce a counted segment. */
export type SegmentWindowVerdict =
  | { readonly kind: 'segment'; readonly durationMinutes: number }
  | { readonly kind: 'no_previous' }
  | { readonly kind: 'not_after_previous' }
  | { readonly kind: 'gap'; readonly durationMinutes: number };

/**
 * Classifies the window `previous → current` of a position event (v2 rule,
 * no legacy equivalent: the MVP computed every pair):
 * - no previous fix → no segment;
 * - `t_current − t_previous ≤ 0` → no segment (out-of-order or duplicate);
 * - `t_current − t_previous > maxGapMinutes` → a gap: stored with the flag
 *   `gap`, zero fuel and excluded from the CII sums;
 * - otherwise a segment.
 *
 * @method emission.segment_window
 * @see docs/PLATFORM_SPEC.md §13.5 (SEGMENT_MAX_GAP_MIN, default 360)
 */
export function classifySegmentWindow(
  current: Pick<Fix, 'time'>,
  previous: Pick<Fix, 'time'> | null,
  maxGapMinutes: number,
): SegmentWindowVerdict {
  if (previous === null) return { kind: 'no_previous' };
  const durationMinutes =
    (current.time.getTime() - previous.time.getTime()) / 60_000;
  if (durationMinutes <= 0) return { kind: 'not_after_previous' };
  if (durationMinutes > maxGapMinutes) return { kind: 'gap', durationMinutes };
  return { kind: 'segment', durationMinutes };
}
