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
import {
  hullFormOf,
  segmentFuelProfileOf,
} from '../../modules/profiles/vessel-profile.js';
import { calculateSecondFormulaFuel } from '../fuel/second-formula.js';
import { calculateSpeed } from '../segment.js';
import { computeSegmentFuel, type SegmentFuelInput } from '../segment-fuel.js';
import {
  directionCoefficient,
  formCoefficient,
  speedCoefficient,
} from '../weather/kwon.js';
import { appendageArea } from './appendage.js';
import { holtropChain } from './chain.js';
import {
  c4,
  correlationAllowance,
  correlationResistance,
} from './correlation.js';
import { lcb, lengthOfRun, onePlusK1 } from './form-factor.js';
import { displacementTonnes, lengthDisplacement } from './hull.js';
import { froudeNumber } from './numbers.js';
import { wakeFraction } from './power.js';
import type { HullForm } from './types.js';
import {
  bulbTransomTerms,
  c1,
  c15,
  c16,
  c7,
  halfAngleOfEntrance,
  lambda,
  m1,
  m2,
  waveResistance,
} from './wave.js';
import { wettedSurface } from './wetted-surface.js';

const FuelSchema = z.object({
  fuelConsumptionMeTon: num,
  fuelConsumptionAeTon: num,
  totalFuelConsumptionTon: num,
});

const HOLTROP = loadGolden(
  'holtrop.json',
  z.object({
    ships: z.record(z.string(), LegacyShipSchema),
    hull: z.array(
      z.object({ ship: z.string(), output: z.record(z.string(), num) }),
    ),
    chains: z.array(
      z.object({
        name: z.string(),
        input: z.object({
          ship: z.string(),
          speedCase: z.string(),
          weather: z.object({
            windspeed: z.number(),
            winddirection: z.number(),
          }),
        }),
        speedData: z.object({ distance: num, speedKnot: num, speedMs: num }),
        intermediates: z.object({
          shipCourse: num,
          windCourse: z.object({
            beafortNumber: z.number(),
            encounteredAngle: num,
          }),
          fn: num,
          speedReductionCoef: num,
          shipShapeCoef: num,
          windCourseRedCoef: num,
          coefReduction: num,
          friction: z.object({
            newSpeed: z.object({ speedMs: num, speedKnot: num }),
            newFn: num,
            newTime: num,
            Saap: num,
            onePlusK2: num,
            Raap: num,
            Rf: num,
          }),
          reynolds: num,
          m2: num,
          rw: num,
          ra: num,
          totalResistance: z.object({ rt: num, rtPlusSm: num }),
          ehp: num,
          dhp: num,
          shp: num,
          bhpMCR: num,
        }),
        weatherCall: z.object({ latitude: z.number(), longitude: z.number() }),
        fuel: z.record(z.string(), FuelSchema),
      }),
    ),
  }),
);

const FixSchema = z.object({
  lat: z.number(),
  lon: z.number(),
  time: z.string(),
  navstatus: z.number(),
});
const SPEED_CASES = loadGolden(
  'speed.json',
  z.object({
    cases: z.array(
      z.object({
        name: z.string(),
        input: z.object({ current: FixSchema, previous: FixSchema }),
      }),
    ),
  }),
).cases;

function snapshotOf(key: string) {
  const ship = HOLTROP.ships[key];
  if (ship === undefined) throw new Error(`no legacy ship ${key}`);
  return snapshotOfLegacyShip(ship, 1, { firstFuelFormula: false });
}

function hullOf(key: string): HullForm {
  return hullFormOf(snapshotOf(key));
}

function kinematicsOf(speedCase: string) {
  const c = SPEED_CASES.find((candidate) => candidate.name === speedCase);
  if (c === undefined) throw new Error(`no speed case ${speedCase}`);
  const fix = (value: z.output<typeof FixSchema>) => ({
    lat: value.lat,
    lon: value.lon,
    time: new Date(value.time),
  });
  return {
    kinematics: calculateSpeed(fix(c.input.current), fix(c.input.previous)),
    previous: c.input.previous,
  };
}

describe('Holtrop–Mennen hull terms — golden parity with legacy second-formula/*', () => {
  it.each(HOLTROP.hull.map((h) => [h.ship, h] as const))(
    'ship %s',
    (ship, h) => {
      const hull = hullOf(ship);
      const legacy = h.output;
      const value = (key: string): number => {
        const expected = legacy[key];
        if (expected === undefined) throw new Error(`fixture without ${key}`);
        return expected;
      };
      const c7Value = c7(hull);
      const { c2, c5 } = bulbTransomTerms(hull);
      expectAllClose(
        {
          lengthDisplacement: [
            lengthDisplacement(hull),
            value('lengthDisplacement'),
          ],
          displacement: [displacementTonnes(hull), value('displacement')],
          lcb: [lcb(hull), value('lcb')],
          lr: [lengthOfRun(hull), value('lr')],
          ie: [halfAngleOfEntrance(hull), value('ie')],
          c7: [c7Value, value('c7')],
          c1: [c1(hull, c7Value), value('c1')],
          c2: [c2, value('c2')],
          c4: [c4(hull), value('c4')],
          c5: [c5, value('c5')],
          c15: [c15(hull), value('c15')],
          c16: [c16(hull), value('c16')],
          m1: [m1(hull), value('m1')],
          lambda: [lambda(hull), value('lambda')],
          s: [wettedSurface(hull), value('s')],
          ca: [correlationAllowance(hull), value('ca')],
          onePlusK1: [onePlusK1(hull), value('onePlusK1')],
          saap: [appendageArea(hull), value('saap')],
          w: [wakeFraction(hull), value('w')],
        },
        `ship ${ship}`,
      );
    },
  );
});

describe('Holtrop chain and second fuel formula — golden parity (weather stubbed)', () => {
  it.each(HOLTROP.chains.map((c) => [c.name, c] as const))('%s', (name, c) => {
    const hull = hullOf(c.input.ship);
    const { kinematics, previous } = kinematicsOf(c.input.speedCase);
    const wind = {
      speedKn: c.input.weather.windspeed,
      directionDeg: c.input.weather.winddirection,
    };
    const chain = holtropChain(kinematics, wind, hull);
    const legacy = c.intermediates;

    expectAllClose(
      {
        distance: [kinematics.distanceNm, c.speedData.distance],
        speedKnot: [kinematics.speedKn, c.speedData.speedKnot],
        speedMs: [kinematics.speedMs, c.speedData.speedMs],
        shipCourse: [chain.shipCourseDeg, legacy.shipCourse],
        encounterAngle: [
          chain.windCourse.encounterAngleDeg,
          legacy.windCourse.encounteredAngle,
        ],
        fn: [froudeNumber(kinematics.speedMs, hull.lwl), legacy.fn],
        speedReductionCoef: [
          speedCoefficient(hull, kinematics.speedMs),
          legacy.speedReductionCoef,
        ],
        shipShapeCoef: [
          formCoefficient(chain.windCourse, hull),
          legacy.shipShapeCoef,
        ],
        windCourseRedCoef: [
          directionCoefficient(chain.windCourse),
          legacy.windCourseRedCoef,
        ],
        coefReduction: [chain.speedReductionPercent, legacy.coefReduction],
        newSpeedMs: [
          chain.friction.newSpeed.speedMs,
          legacy.friction.newSpeed.speedMs,
        ],
        newSpeedKnot: [
          chain.friction.newSpeed.speedKn,
          legacy.friction.newSpeed.speedKnot,
        ],
        newFn: [chain.friction.newFn, legacy.friction.newFn],
        newTime: [chain.friction.newTimeHours, legacy.friction.newTime],
        saap: [chain.friction.appendageArea, legacy.friction.Saap],
        onePlusK2: [chain.friction.onePlusK2, legacy.friction.onePlusK2],
        raap: [chain.friction.raap, legacy.friction.Raap],
        rf: [chain.friction.rf, legacy.friction.Rf],
        reynolds: [chain.friction.reynolds, legacy.reynolds],
        m2: [m2(hull, chain.friction.newFn), legacy.m2],
        rw: [waveResistance(hull, chain.friction.newFn), legacy.rw],
        ra: [
          correlationResistance(hull, chain.friction.newSpeed.speedMs),
          legacy.ra,
        ],
        rt: [chain.totalResistance.rt, legacy.totalResistance.rt],
        rtPlusSm: [
          chain.totalResistance.rtPlusSm,
          legacy.totalResistance.rtPlusSm,
        ],
        ehp: [chain.effectivePowerKw, legacy.ehp],
        dhp: [chain.deliveredPowerKw, legacy.dhp],
        shp: [chain.shaftPowerKw, legacy.shp],
        bhpMcr: [chain.bhpMcrKw, legacy.bhpMCR],
      },
      name,
    );
    expect(chain.windCourse.beaufortNumber).toBe(
      legacy.windCourse.beafortNumber,
    );
    // The legacy asked Open-Meteo for the weather at the previous fix.
    expect(c.weatherCall).toEqual({
      latitude: previous.lat,
      longitude: previous.lon,
    });

    const snapshot = snapshotOf(c.input.ship);
    for (const [key, expected] of Object.entries(c.fuel)) {
      const navstatus = Number(key.replace('nav', ''));
      const fuel = calculateSecondFormulaFuel({
        bhpMcrKw: chain.bhpMcrKw,
        sfocGPerKwh: snapshot.mainEngine?.sfoc ?? Number.NaN,
        newTimeHours: chain.friction.newTimeHours,
        newSpeedKnot: chain.friction.newSpeed.speedKn,
        densityKgPerL: snapshot.fuel.density,
        navstatus,
      });
      expectAllClose(
        {
          me: [fuel.meTon, expected.fuelConsumptionMeTon],
          ae: [fuel.aeTon, expected.fuelConsumptionAeTon],
          total: [fuel.totalTon, expected.totalFuelConsumptionTon],
        },
        `${name} ${key}`,
      );
    }
  });
});

describe('computeSegmentFuel (Holtrop path)', () => {
  const snapshot = snapshotOf('A');
  const { kinematics } = kinematicsOf('northeast-13kn');
  const input: SegmentFuelInput = {
    kinematics,
    window: {
      start: new Date('2026-03-10T08:00:00Z'),
      end: new Date('2026-03-10T08:10:00Z'),
    },
    navstatus: 0,
    profile: segmentFuelProfileOf(snapshot),
    readings: [],
    telemetryActiveWindowMinutes: 10,
  };
  const golden = HOLTROP.chains.find(
    (c) => c.name === 'A/northeast-13kn/moderate-bow',
  )?.fuel.nav0;

  it('stores the legacy fuel and CO2 = total fuel × C_F', () => {
    const result = computeSegmentFuel(input, 'holtrop', {
      speedKn: 12,
      directionDeg: 45,
    });
    expect(result.method).toBe('holtrop');
    expect(result.flags).toEqual([]);
    if (golden === undefined) throw new Error('missing golden case');
    expectClose(result.fuelMeTon, golden.fuelConsumptionMeTon, 'ME');
    expectClose(result.fuelAeTon, golden.fuelConsumptionAeTon, 'AE');
    expectClose(
      result.co2Ton,
      golden.totalFuelConsumptionTon * snapshot.fuel.conversionFactor,
      'CO2',
    );
  });

  it('flags calm-weather fallbacks', () => {
    const result = computeSegmentFuel(
      input,
      'holtrop',
      { speedKn: 0, directionDeg: 0 },
      true,
    );
    expect(result.flags).toEqual(['weather_unavailable']);
  });

  it('does not count non-finite legacy results (speed loss above 100 % in a gale)', () => {
    const result = computeSegmentFuel(input, 'holtrop', {
      speedKn: 40,
      directionDeg: 250,
    });
    expect(result).toMatchObject({
      method: 'none',
      fuelMeTon: 0,
      fuelAeTon: 0,
      co2Ton: 0,
      flags: ['fuel_not_finite'],
    });
  });
});
