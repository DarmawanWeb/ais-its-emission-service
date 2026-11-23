import { co2FromFuel } from '../cii.js';

/**
 * CO2 of the SEEMP baseline year, t: the year's stored CO2, else (a manual
 * record without CO2) its fuel × C_F of the vessel's current fuel, as the
 * DCS summary.
 *
 * @method emission.co2_conversion
 */
export function baselineCo2Ton(
  baseline: {
    readonly co2Ton: number | null;
    readonly fuelMeTon: number;
    readonly fuelAeTon: number;
  },
  conversionFactor: number,
): number {
  return (
    baseline.co2Ton ??
    co2FromFuel(baseline.fuelMeTon + baseline.fuelAeTon, conversionFactor)
  );
}

/**
 * CO2 avoided per year by measures that take the attained CII from
 * `attainedBefore` to `attainedAfter`, t: the simulation keeps the baseline
 * distance and capacity, so CO2 scales like the attained CII
 * (`CO2 × (1 − after / before)`, i.e. the baseline CO2 times the reduction
 * percentage). Negative when the measures raise the attained CII; 0 for a
 * baseline without attained CII.
 *
 * @method seemp.simulation_combination
 */
export function co2AvoidedTon(
  baselineCo2: number,
  attainedBefore: number,
  attainedAfter: number,
): number {
  if (!(attainedBefore > 0)) return 0;
  return baselineCo2 * (1 - attainedAfter / attainedBefore);
}

/**
 * Cost per tonne of CO2 avoided, USD/t: the yearly cost of the measures over
 * the CO2 they avoid per year; `null` when they avoid none.
 *
 * @method seemp.simulation_combination
 */
export function costPerTonneUsd(
  costUsdPerYear: number,
  avoidedTon: number,
): number | null {
  return avoidedTon > 0 ? costUsdPerYear / avoidedTon : null;
}
