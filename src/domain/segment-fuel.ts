import type { FuelEstimationMethod } from '@darmawanweb/ais-its-contracts/domain';

import { co2FromFuel } from './cii.js';
import { calculateFirstFormulaFuel, type FirstFuelFormula } from './fuel/first-formula.js';
import { selectFuelMethod } from './fuel/method.js';
import { calculateSecondFormulaFuel } from './fuel/second-formula.js';
import { type FuelReading, isTelemetryActive, segmentFuelFromReadings, type TimeWindow } from './fuel/telemetry.js';
import type { FuelConsumption } from './fuel/types.js';
import { type HoltropChainResult, holtropChain } from './holtrop/chain.js';
import type { HullForm } from './holtrop/types.js';
import type { SegmentKinematics } from './segment.js';
import type { Wind } from './weather/types.js';

/** What the segment fuel estimation needs from a vessel. */
export interface SegmentFuelProfile {
  readonly fuelCode: string;
  /** C_F, t CO2 / t fuel. */
  readonly conversionFactor: number;
  /** Fuel density, kg/L. */
  readonly densityKgPerL: number;
  readonly hull: HullForm;
  /** Main engine SFOC, g/kWh; `null` without a main engine. */
  readonly mainEngineSfoc: number | null;
  /** Compiled first fuel formula; `null` when the vessel has none. */
  readonly firstFormula: FirstFuelFormula | null;
}

/**
 * Flags of a stored segment:
 * - `gap` — time between the fixes above SEGMENT_MAX_GAP_MIN (not counted);
 * - `no_fuel_model` — no telemetry, no formula and no main engine (not counted);
 * - `fuel_not_finite` / `fuel_negative` — the model gave an unusable value (not counted);
 * - `formula_error` — a first fuel formula did not compile (legacy 0.5 L/min fallback);
 * - `weather_unavailable` — Holtrop with calm weather because Open-Meteo failed;
 * - `telemetry_reattributed` — fuel replaced by telemetry that arrived after the segment.
 */
export type SegmentFlag =
  | 'gap'
  | 'no_fuel_model'
  | 'fuel_not_finite'
  | 'fuel_negative'
  | 'formula_error'
  | 'weather_unavailable'
  | 'telemetry_reattributed';

/** Inputs of the fuel estimation of one segment. */
export interface SegmentFuelInput {
  readonly kinematics: SegmentKinematics;
  readonly window: TimeWindow;
  /** AIS navstatus reported at the previous fix (fuel multipliers). */
  readonly navstatus: number;
  readonly profile: SegmentFuelProfile;
  /** Telemetry readings of the vessel around the window. */
  readonly readings: readonly FuelReading[];
  /** TELEMETRY_ACTIVE_WINDOW_MIN. */
  readonly telemetryActiveWindowMinutes: number;
}

/** Fuel, CO2 and provenance of a segment. */
export interface SegmentFuelResult {
  /** The estimation method, `none` when the segment is not counted. */
  readonly method: FuelEstimationMethod | 'none';
  readonly fuelMeTon: number;
  readonly fuelAeTon: number;
  /** CO2 = total fuel × C_F, t. */
  readonly co2Ton: number;
  readonly flags: readonly SegmentFlag[];
  /** Intermediate values of the Holtrop chain (method `holtrop`). */
  readonly holtrop?: HoltropChainResult;
  /** Readings that contributed (method `telemetry`). */
  readonly telemetryReadings?: number;
}

/**
 * The fuel method of a segment by priority (telemetry → first formula →
 * Holtrop), `null` when none applies.
 *
 * @method fuel.method_selection
 */
export function chooseFuelMethod(input: SegmentFuelInput): FuelEstimationMethod | null {
  return selectFuelMethod({
    telemetryActive: isTelemetryActive(input.readings, input.window, input.telemetryActiveWindowMinutes),
    hasFirstFormula: input.profile.firstFormula !== null,
    hasMainEngine: input.profile.mainEngineSfoc !== null,
  });
}

const EXCLUDED = { fuelMeTon: 0, fuelAeTon: 0, co2Ton: 0 } as const;

/** A not-counted segment with the given flags. */
export function excludedSegment(...flags: SegmentFlag[]): SegmentFuelResult {
  return { method: 'none', ...EXCLUDED, flags };
}

function finish(
  method: FuelEstimationMethod,
  fuel: FuelConsumption,
  conversionFactor: number,
  flags: SegmentFlag[],
  extra: Pick<SegmentFuelResult, 'holtrop' | 'telemetryReadings'>,
): SegmentFuelResult {
  const values = [fuel.meTon, fuel.aeTon, fuel.totalTon];
  if (values.some((value) => !Number.isFinite(value))) return excludedSegment(...flags, 'fuel_not_finite');
  if (values.some((value) => value < 0)) return excludedSegment(...flags, 'fuel_negative');
  return {
    method,
    fuelMeTon: fuel.meTon,
    fuelAeTon: fuel.aeTon,
    co2Ton: co2FromFuel(fuel.totalTon, conversionFactor),
    flags,
    ...extra,
  };
}

/**
 * Fuel and CO2 of a segment with the chosen method (legacy
 * `CIIService.calculateCII` without the CII accumulation):
 * - telemetry: readings attributed to the window, no multipliers;
 * - first_formula: `calculateFirstFormulaFuel` with the previous navstatus;
 * - holtrop: the Holtrop–Kwon chain with `wind`, then `calculateSecondFormulaFuel`;
 * CO2 = total fuel × C_F. Non-finite or negative results are not counted.
 *
 * @method fuel.method_selection
 * @method telemetry.fuel_reading_usage
 * @method fuel.first_formula
 * @method fuel.second_formula_me
 * @method fuel.second_formula_ae
 * @method emission.co2_conversion
 * @param wind wind of the segment (Holtrop only; `null` otherwise).
 * @param weatherUnavailable the wind is the calm fallback.
 */
export function computeSegmentFuel(
  input: SegmentFuelInput,
  method: FuelEstimationMethod | null,
  wind: Wind | null,
  weatherUnavailable = false,
): SegmentFuelResult {
  const { profile, kinematics } = input;
  switch (method) {
    case null:
      return excludedSegment('no_fuel_model');
    case 'telemetry': {
      const fuel = segmentFuelFromReadings(input.readings, input.window);
      return finish('telemetry', fuel, profile.conversionFactor, [], { telemetryReadings: fuel.readings });
    }
    case 'first_formula': {
      const formula = profile.firstFormula;
      if (formula === null) return excludedSegment('no_fuel_model');
      const fuel = calculateFirstFormulaFuel({
        navstatus: input.navstatus,
        densityKgPerL: profile.densityKgPerL,
        speedKnot: kinematics.speedKn,
        formula,
        durationMinutes: kinematics.durationMinutes,
      });
      const flags: SegmentFlag[] =
        formula.mainEngine.valid && formula.auxiliaryEngine.valid ? [] : ['formula_error'];
      return finish('first_formula', fuel, profile.conversionFactor, flags, {});
    }
    case 'holtrop': {
      if (profile.mainEngineSfoc === null || wind === null) return excludedSegment('no_fuel_model');
      const chain = holtropChain(kinematics, wind, profile.hull);
      const fuel = calculateSecondFormulaFuel({
        bhpMcrKw: chain.bhpMcrKw,
        sfocGPerKwh: profile.mainEngineSfoc,
        newTimeHours: chain.friction.newTimeHours,
        newSpeedKnot: chain.friction.newSpeed.speedKn,
        densityKgPerL: profile.densityKgPerL,
        navstatus: input.navstatus,
      });
      const flags: SegmentFlag[] = weatherUnavailable ? ['weather_unavailable'] : [];
      return finish('holtrop', fuel, profile.conversionFactor, flags, { holtrop: chain });
    }
  }
}
