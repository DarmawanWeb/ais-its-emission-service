import { describe, expect, it } from 'vitest';
import * as z from 'zod';

import {
  expectAllClose,
  expectClose,
  loadGolden,
  num,
} from '../../../test/support/golden.js';
import {
  LegacyShipSchema,
  snapshotOfLegacyShip,
} from '../../../test/support/legacy-ship.js';
import { hullFormOf } from '../../modules/profiles/vessel-profile.js';
import type { HullForm } from '../holtrop/types.js';
import { beaufortNumber } from './beaufort.js';
import { calculateShipCourse } from './course.js';
import {
  calculateEncounterAngle,
  calculateWindCourse,
} from './encounter-angle.js';
import {
  directionCoefficient,
  formCoefficient,
  speedCoefficient,
} from './kwon.js';

const RadSchema = z.object({ lat: num, lon: num });

const WEATHER = loadGolden(
  'weather.json',
  z.object({
    beaufort: z.array(z.object({ input: z.number(), output: z.number() })),
    encounterAngle: z.array(
      z.object({
        input: z.object({ shipCourse: z.number(), windCourse: z.number() }),
        output: num,
      }),
    ),
    shipCourse: z.array(
      z.object({
        name: z.string(),
        input: z.object({
          firstPositionRad: RadSchema,
          secondPositionRad: RadSchema,
        }),
        output: num,
      }),
    ),
    windCourse: z.array(
      z.object({
        input: z.object({
          shipCourse: z.number(),
          windspeed: z.number(),
          winddirection: z.number(),
        }),
        output: z.object({ beafortNumber: z.number(), encounteredAngle: num }),
      }),
    ),
    directionCoefficient: z.array(
      z.object({
        input: z.object({
          encounteredAngle: z.number(),
          beafortNumber: z.number(),
        }),
        output: num,
      }),
    ),
    speedCoefficient: z.array(
      z.object({
        input: z.object({
          cb: z.number(),
          lwl: z.number(),
          vesselSpeedMs: z.number(),
        }),
        output: num,
      }),
    ),
    formCoefficient: z.array(
      z.object({
        input: z.object({ ship: z.string(), beafortNumber: z.number() }),
        output: num,
      }),
    ),
  }),
);

const SHIPS = loadGolden(
  'holtrop.json',
  z.object({ ships: z.record(z.string(), LegacyShipSchema) }),
).ships;

function hullOf(key: string): HullForm {
  const ship = SHIPS[key];
  if (ship === undefined) throw new Error(`no legacy ship ${key}`);
  return hullFormOf(snapshotOfLegacyShip(ship, 1));
}

describe('weather terms — golden parity with legacy course-calculation.ts / coefisien-reduction-calculation.ts', () => {
  it('Beaufort number from the wind speed in knots (capped at 8)', () => {
    for (const c of WEATHER.beaufort)
      expect(beaufortNumber(c.input), `${c.input} kn`).toBe(c.output);
  });

  it('encounter angle of ship course and wind direction', () => {
    for (const c of WEATHER.encounterAngle) {
      expectClose(
        calculateEncounterAngle(c.input.shipCourse, c.input.windCourse),
        c.output,
        JSON.stringify(c.input),
      );
    }
  });

  it('rhumb-line ship course from the [current, previous] fixes', () => {
    for (const c of WEATHER.shipCourse) {
      expectClose(
        calculateShipCourse(
          c.input.firstPositionRad,
          c.input.secondPositionRad,
        ),
        c.output,
        c.name,
      );
    }
  });

  it('wind course (Beaufort number and encounter angle)', () => {
    for (const c of WEATHER.windCourse) {
      const result = calculateWindCourse(c.input.shipCourse, {
        speedKn: c.input.windspeed,
        directionDeg: c.input.winddirection,
      });
      expect(result.beaufortNumber).toBe(c.output.beafortNumber);
      expectClose(
        result.encounterAngleDeg,
        c.output.encounteredAngle,
        JSON.stringify(c.input),
      );
    }
  });

  it('Kwon direction coefficient', () => {
    for (const c of WEATHER.directionCoefficient) {
      const value = directionCoefficient({
        encounterAngleDeg: c.input.encounteredAngle,
        beaufortNumber: c.input.beafortNumber,
      });
      expectClose(value, c.output, JSON.stringify(c.input));
    }
  });

  it('Kwon speed coefficient by block coefficient band', () => {
    for (const c of WEATHER.speedCoefficient) {
      expectClose(
        speedCoefficient(
          { cb: c.input.cb, lwl: c.input.lwl },
          c.input.vesselSpeedMs,
        ),
        c.output,
        JSON.stringify(c.input),
      );
    }
  });

  it('Kwon ship form coefficient (legacy variant)', () => {
    for (const c of WEATHER.formCoefficient) {
      const value = formCoefficient(
        { beaufortNumber: c.input.beafortNumber, encounterAngleDeg: 0 },
        hullOf(c.input.ship),
      );
      expectAllClose({ form: [value, c.output] }, JSON.stringify(c.input));
    }
  });
});
