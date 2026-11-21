import {
  assignCiiGrade,
  type CiiGrade,
  ciiGradeBoundaries,
  type DdVector,
} from '@darmawanweb/ais-its-contracts/domain';

/**
 * CO2 emitted by a fuel mass: `CO2 [t] = FC [t] × C_F [t CO2 / t fuel]`.
 *
 * @method emission.co2_conversion
 * @param fuelTon fuel mass, t.
 * @param conversionFactor C_F of the fuel (MEPC.364(79)), t CO2 / t fuel.
 * @see docs/METHODOLOGY.md#emission.co2_conversion
 * @see https://www.imo.org/en/OurWork/Environment/Pages/Air-Pollution.aspx (MEPC.364(79))
 */
export function co2FromFuel(fuelTon: number, conversionFactor: number): number {
  return fuelTon * conversionFactor;
}

/**
 * Attained CII (IMO G1, MEPC.352(78)):
 * `CII = Σ(FC_j · C_F,j) / (Capacity · Σ D) · 10⁶` g CO2 / (capacity · nm),
 * written with the legacy operation order `(CO2 / (D · Cap)) · 10⁶`.
 *
 * Port of the attained term of `calculateCII`
 * (`be-legacy/src/utils/cii/cii-calculation.ts`); v2 sums per calendar year
 * (spec §15.3) instead of the legacy lifetime accumulation.
 *
 * @method cii.attained_accumulation
 * @param co2Ton CO2 emitted, t.
 * @param distanceNm distance sailed, nm.
 * @param capacity CII capacity (DWT or GT, see `ciiCapacity`).
 * @see docs/METHODOLOGY.md#cii.attained_accumulation
 */
export function attainedCii(co2Ton: number, distanceNm: number, capacity: number): number {
  return (co2Ton / (distanceNm * capacity)) * 10 ** 6;
}

/** Reference line parameters of a ship type (MEPC.353(78)). */
export interface ReferenceLine {
  readonly a: number;
  readonly c: number;
}

/**
 * CII reference line `CII_ref = a · Capacity^(−c)` (MEPC.353(78)).
 *
 * Port of the `CIref` term of `calculateCIIRequired`
 * (`be-legacy/src/utils/cii/cii-calculation.ts`).
 *
 * @method cii.reference_line
 * @see docs/METHODOLOGY.md#cii.reference_line
 */
export function referenceCii(line: ReferenceLine, capacity: number): number {
  return line.a * capacity ** -line.c;
}

/** A reduction factor Z of a year (`reduction_factors`). */
export interface ReductionFactor {
  readonly year: number;
  /** Z, percent. */
  readonly zPercent: number;
  readonly source: string;
}

/** Last year of the legacy reduction factor table when it is empty (`getHighestYear`). */
export const DEFAULT_HIGHEST_REDUCTION_YEAR = 2030;

/**
 * The reduction factor Z of `year` (MEPC.338(76): 2023–2026, MEPC.400(83):
 * 2027–2030), `undefined` when the table has none (legacy threw
 * "Z value not found for the given year").
 *
 * @method cii.reduction_factor_z
 * @see docs/METHODOLOGY.md#cii.reduction_factor_z
 */
export function reductionFactorOf(factors: readonly ReductionFactor[], year: number): number | undefined {
  return factors.find((factor) => factor.year === year)?.zPercent;
}

/**
 * Highest year of the reduction factor table, 2030 when empty (legacy
 * `ZValueRepository.getHighestYear`).
 *
 * @method cii.reduction_factor_z
 */
export function highestReductionFactorYear(factors: readonly ReductionFactor[]): number {
  const highest = Math.max(...factors.map((factor) => factor.year));
  return Number.isFinite(highest) && highest !== 0 ? highest : DEFAULT_HIGHEST_REDUCTION_YEAR;
}

/**
 * Required CII `CII_req = (1 − Z/100) · CII_ref` (MEPC.338(76), MEPC.400(83)).
 *
 * Port of `calculateCIIRequired` (`be-legacy/src/utils/cii/cii-calculation.ts`)
 * with the year's Z supplied by the caller.
 *
 * @method cii.required
 * @param zPercent reduction factor of the year, percent.
 * @param reference reference CII, g CO2 / (capacity · nm).
 * @see docs/METHODOLOGY.md#cii.required
 */
export function requiredCii(zPercent: number, reference: number): number {
  return (1 - zPercent / 100) * reference;
}

/**
 * CII rating `attained / required` and A–E grade by the d-vector
 * (MEPC.354(78), legacy `assignGradeBasedOnDdVector`, contracts `assignCiiGrade`).
 *
 * @method cii.rating_grade
 * @see docs/METHODOLOGY.md#cii.rating_grade
 */
export function rateAttained(attained: number, required: number, d: DdVector): { rating: number; grade: CiiGrade } {
  const rating = attained / required;
  return { rating, grade: assignCiiGrade(rating, d) };
}

/**
 * Grade of an attained CII against absolute boundaries `d_i · required`
 * (legacy `assignGradeBasedOnDdVectorNew`, used by the SEEMP cost amortization).
 *
 * @method cii.rating_grade
 * @method cii.dd_vector_boundaries
 */
export function gradeAgainstRequired(d: DdVector, attained: number, required: number): CiiGrade {
  const { d1, d2, d3, d4 } = ciiGradeBoundaries(required, d);
  if (attained < d1) return 'A';
  else if (attained >= d1 && attained < d2) return 'B';
  else if (attained >= d2 && attained < d3) return 'C';
  else if (attained >= d3 && attained < d4) return 'D';
  return 'E';
}

/** What the rating of a vessel needs from its profile. */
export interface CiiRatingProfile {
  /** CII capacity (`type.capacityFixed ?? dimensions.capacity`). */
  readonly capacity: number;
  readonly referenceLine: ReferenceLine;
  readonly d: DdVector;
}

/** CII figures of a period. */
export interface CiiFigures {
  /** Attained CII, g CO2 / (capacity · nm). */
  readonly attained: number;
  /** Reference CII, g CO2 / (capacity · nm). */
  readonly reference: number;
  /** Required CII, g CO2 / (capacity · nm). */
  readonly required: number;
  readonly rating: number;
  readonly grade: CiiGrade;
  /** Absolute grade boundaries `d_i · required` (legacy `ddVector`). */
  readonly boundaries: DdVector;
}

/**
 * CII figures of a period from its totals: attained, required (with the
 * year's Z), rating, grade and boundaries — the application-level rating
 * layer over `cii_daily` / `cii_annual`.
 *
 * @method cii.attained_accumulation
 * @method cii.reference_line
 * @method cii.required
 * @method cii.rating_grade
 * @method cii.dd_vector_boundaries
 * @param totals CO2 (t) and distance (nm) of the period.
 * @param zPercent reduction factor of the period's year, percent.
 */
export function rateCii(
  totals: { readonly co2Ton: number; readonly distanceNm: number },
  profile: CiiRatingProfile,
  zPercent: number,
): CiiFigures {
  const attained = attainedCii(totals.co2Ton, totals.distanceNm, profile.capacity);
  const reference = referenceCii(profile.referenceLine, profile.capacity);
  const required = requiredCii(zPercent, reference);
  const { rating, grade } = rateAttained(attained, required, profile.d);
  return { attained, reference, required, rating, grade, boundaries: ciiGradeBoundaries(required, profile.d) };
}
