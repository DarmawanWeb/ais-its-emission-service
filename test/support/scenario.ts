import type { AisPositionRecordedV1 } from '@darmawanweb/ais-its-contracts/events';
import { waitFor } from '@darmawanweb/ais-its-nest/testing';
import * as z from 'zod';

import { ProfileDirectory } from '../../src/modules/profiles/profile-directory.js';
import { loadGolden } from './golden.js';
import { type LegacyShip, LegacyShipSchema } from './legacy-ship.js';
import type { TestService } from './test-service.js';

/** The legacy sample ships of the golden harness (A = Postman "Dharma Ferry VIII"). */
export function legacyShip(key: 'A' | 'B' | 'C' | 'D' | 'E'): LegacyShip {
  const ships = loadGolden(
    'holtrop.json',
    z.object({ ships: z.record(z.string(), LegacyShipSchema) }),
  ).ships;
  const ship = ships[key];
  if (ship === undefined) throw new Error(`no legacy ship ${key}`);
  return ship;
}

const FixSchema = z.object({
  lat: z.number(),
  lon: z.number(),
  time: z.string(),
  navstatus: z.number(),
});
export type GoldenFix = z.output<typeof FixSchema>;

/** A golden speed case: the `[current, previous]` pair the legacy functions were called with. */
export interface SpeedCase {
  readonly name: string;
  readonly current: GoldenFix;
  readonly previous: GoldenFix;
}

/** Every speed case of `test/fixtures/golden/speed.json`, in harness order. */
export function speedCases(): SpeedCase[] {
  return loadGolden(
    'speed.json',
    z.object({
      cases: z.array(
        z.object({
          name: z.string(),
          input: z.object({ current: FixSchema, previous: FixSchema }),
        }),
      ),
    }),
  ).cases.map((c) => ({
    name: c.name,
    current: c.input.current,
    previous: c.input.previous,
  }));
}

/** The golden speed case `name`. */
export function speedCase(name: string): SpeedCase {
  const found = speedCases().find((c) => c.name === name);
  if (found === undefined) throw new Error(`no speed case ${name}`);
  return found;
}

const shifted = (iso: string, shiftMs: number): string =>
  new Date(new Date(iso).getTime() + shiftMs).toISOString();

/**
 * The `ais.position.recorded.v1` payload of a speed case for `mmsi`, both
 * fixes moved by `shiftMs` (speed, distance and fuel depend on the time
 * difference only, so a shifted case keeps its golden values).
 */
export function positionOf(
  mmsi: number,
  c: SpeedCase,
  shiftMs = 0,
): AisPositionRecordedV1 {
  return {
    mmsi,
    time: shifted(c.current.time, shiftMs),
    source: 'primary',
    lat: c.current.lat,
    lon: c.current.lon,
    sog: 10,
    cog: 45,
    hdg: 45,
    navstatus: c.current.navstatus,
    predictedNavstatus: 0,
    coastDistanceM: null,
    previous: {
      time: shifted(c.previous.time, shiftMs),
      lat: c.previous.lat,
      lon: c.previous.lon,
      sog: 10,
      cog: 45,
      hdg: 45,
      navstatus: c.previous.navstatus,
      predictedNavstatus: 0,
    },
  };
}

/** A stored segment as the tests read it back. */
export interface StoredSegment {
  readonly timeStart: Date;
  readonly timeEnd: Date;
  readonly method: string;
  readonly distanceNm: number;
  readonly speedKn: number;
  readonly fuelMeTon: number;
  readonly fuelAeTon: number;
  readonly co2Ton: number;
  readonly navstatus: number;
  readonly flags: string[];
  readonly weather: {
    source: string;
    windSpeedKn: number;
    windDirectionDeg: number;
    cell: { lat: number; lon: number };
    hour: string;
  } | null;
}

/** Segments of a vessel ordered by start. */
export async function segmentsOf(
  service: TestService,
  mmsi: number,
): Promise<StoredSegment[]> {
  const { rows } = await service.pool.query<StoredSegment>(
    `SELECT time_start AS "timeStart", time_end AS "timeEnd", method, distance_nm AS "distanceNm", speed_kn AS "speedKn",
            fuel_me_ton AS "fuelMeTon", fuel_ae_ton AS "fuelAeTon", co2_ton AS "co2Ton", navstatus, flags, weather
       FROM segments WHERE mmsi = $1 ORDER BY time_start`,
    [mmsi],
  );
  return rows;
}

/** Waits until the vessel has `count` segments (consumers run asynchronously). */
export async function waitForSegments(
  service: TestService,
  mmsi: number,
  count: number,
  timeoutMs = 15_000,
): Promise<StoredSegment[]> {
  return waitFor(
    async () => {
      const rows = await segmentsOf(service, mmsi);
      return rows.length >= count ? rows : undefined;
    },
    { timeoutMs, message: `${count} segments of ${mmsi}` },
  );
}

/** Waits until the FLEET projection holds the vessel (version `updatedAt` when given) in the position consumer's directory. */
export async function waitForProfile(
  service: TestService,
  mmsi: number,
  updatedAt?: string,
): Promise<void> {
  const directory = service.app.get(ProfileDirectory);
  await waitFor(
    () => {
      const entry = directory.get(mmsi);
      return (
        entry !== undefined &&
        (updatedAt === undefined ||
          entry.profile.snapshotUpdatedAt.getTime() ===
            new Date(updatedAt).getTime())
      );
    },
    { timeoutMs: 15_000, message: `vessel profile ${mmsi}` },
  );
}

/** Segment counts per fuel method of a CII figure. */
export interface MethodCounts {
  readonly telemetry: number;
  readonly firstFormula: number;
  readonly holtrop: number;
}

/**
 * Waits until `GET /cii/vessels/:mmsi/current?year=` counts the expected
 * segments per method. The aggregates are eventually consistent for changes
 * to days before today (`AggregateRefresher`, CII_AGGREGATE_REFRESH_MS, 200 ms
 * in the tests); the current day is real-time.
 */
export async function waitForCii(
  service: TestService,
  mmsi: number,
  year: number,
  expected: MethodCounts,
): Promise<void> {
  await waitFor(
    async () => {
      const response = await service.request({
        url: `/api/v2/cii/vessels/${mmsi}/current?year=${year}`,
        as: { roles: ['super_admin'], orgId: null },
      });
      if (response.statusCode !== 200) return false;
      const { methods } = response.json<{ methods: MethodCounts }>();
      return (
        methods.telemetry === expected.telemetry &&
        methods.firstFormula === expected.firstFormula &&
        methods.holtrop === expected.holtrop
      );
    },
    {
      timeoutMs: 10_000,
      message: `CII of ${mmsi} with ${JSON.stringify(expected)}`,
    },
  );
}
