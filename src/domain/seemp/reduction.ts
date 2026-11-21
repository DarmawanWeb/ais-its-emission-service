import { assignCiiGrade, type CiiGrade, type DdVector } from '@darmawanweb/ais-its-contracts/domain';

import { attainedCii, co2FromFuel } from '../cii.js';
import type { SeempReductionModel } from './measures.js';
import type { AnnualFuelBaseline } from './types.js';

/** Share of the at-berth auxiliary fuel supplied from shore by cold ironing. */
// SOURCE: thesis — needs citation (0.8 of the MVP)
export const COLD_IRONING_SHORE_SHARE = 0.8;

/** Rating and grade after a measure. */
export interface RatedAfter {
  readonly ciiRatingAfter: number;
  readonly ciiGradeAfter: CiiGrade;
}

/** `rating = attained_after / required` and its grade (legacy `assignGradeBasedOnDdVector`). */
export function rateAfter(attainedAfter: number, ciiRequired: number, d: DdVector): RatedAfter {
  const ciiRatingAfter = attainedAfter / ciiRequired;
  return { ciiRatingAfter, ciiGradeAfter: assignCiiGrade(ciiRatingAfter, d) };
}

/**
 * Type-1 reduction (operational / technical measures):
 * `CII_after = CII − (CII · p / 100) · v / 100` with p the potential (%) and v
 * the share of the year at sea (%).
 *
 * Port of `calculateFirstCiiAndGrade` (`be-legacy/src/utils/seemp/utils.ts`).
 *
 * @method seemp.reduction_type1_operational_share
 * @param ciiAttained baseline attained CII, g CO2 / (capacity · nm).
 * @param voyagePerYear share of the year at sea, %.
 * @param potentialPercent reduction potential of the measure, %.
 * @see docs/METHODOLOGY.md#seemp.reduction_type1_operational_share
 */
export function reductionType1(ciiAttained: number, voyagePerYear: number, potentialPercent: number): number {
  return ciiAttained - (((ciiAttained * potentialPercent) / 100) * voyagePerYear) / 100;
}

/**
 * Type-2 reduction (fuel switch): the baseline fuel re-rated with the new
 * fuel's C_F at constant mass,
 * `CII_after = ((FC_ME + FC_AE) · C_F,new / (D · Cap)) · 10⁶`.
 *
 * Port of `calculateSecondCiiAndGrade` (`be-legacy/src/utils/seemp/utils.ts`).
 *
 * @method seemp.reduction_type2_fuel_switch
 * @param conversionFactor C_F of the new fuel, t CO2 / t fuel.
 * @see docs/METHODOLOGY.md#seemp.reduction_type2_fuel_switch
 */
export function reductionType2(annual: AnnualFuelBaseline, capacity: number, conversionFactor: number): number {
  return attainedCii(
    co2FromFuel(annual.fuelMeTon + annual.fuelAeTon, conversionFactor),
    annual.distanceNm,
    capacity,
  );
}

/**
 * Auxiliary fuel after an auxiliary-energy measure, t:
 * cold ironing `FC_AE (1 − v/100) + FC_AE · v · 0.8 / 100`, otherwise
 * `FC_AE (1 − p)`.
 *
 * Port of the `totalFuelAe` term of `calculateThirdCiiAndGrade`
 * (`be-legacy/src/utils/seemp/utils.ts`).
 *
 * @method seemp.reduction_type3_auxiliary
 * @param vesselVoyagePercent the vessel's share of the year at sea, % (used when the model's `voyagePercent` is null).
 */
export function auxiliaryFuelAfter(
  fuelAeTon: number,
  model: Extract<SeempReductionModel, { type: 'auxiliary' }>,
  vesselVoyagePercent: number,
): number {
  const voyagePerYear = model.voyagePercent ?? vesselVoyagePercent;
  const fuelAe = fuelAeTon * (1 - voyagePerYear / 100);
  return model.coldIroning
    ? fuelAe + (fuelAeTon * voyagePerYear * COLD_IRONING_SHORE_SHARE) / 100
    : fuelAeTon * (1 - model.potentialShare);
}

/**
 * Type-3 reduction (auxiliary energy substitution):
 * `CII_after = ((FC_AE,after + FC_ME) · C_F / (D · Cap)) · 10⁶`.
 *
 * Port of `calculateThirdCiiAndGrade` (`be-legacy/src/utils/seemp/utils.ts`).
 *
 * @method seemp.reduction_type3_auxiliary
 * @see docs/METHODOLOGY.md#seemp.reduction_type3_auxiliary
 */
export function reductionType3(
  annual: AnnualFuelBaseline,
  capacity: number,
  conversionFactor: number,
  model: Extract<SeempReductionModel, { type: 'auxiliary' }>,
  vesselVoyagePercent: number,
): number {
  const totalFuel = auxiliaryFuelAfter(annual.fuelAeTon, model, vesselVoyagePercent) + annual.fuelMeTon;
  return attainedCii(co2FromFuel(totalFuel, conversionFactor), annual.distanceNm, capacity);
}
