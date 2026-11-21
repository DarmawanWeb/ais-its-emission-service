import type { CiiGrade } from '@darmawanweb/ais-its-contracts/domain';

import { attainedCii, co2FromFuel } from '../cii.js';
import { reductionMethodId, type SeempMeasure } from './measures.js';
import { measureCost } from './recommendations.js';
import { auxiliaryFuelAfter, rateAfter, reductionType1 } from './reduction.js';
import type { SeempContext } from './types.js';

/** Two measures that cannot be combined (e.g. two fuel switches). */
export class IncompatibleMeasuresError extends Error {
  override readonly name = 'IncompatibleMeasuresError';

  constructor(readonly codes: readonly string[]) {
    super(`Measures ${codes.join(', ')} cannot be combined`);
  }
}

/** Result of a what-if simulation of several measures. */
export interface SimulationResult {
  readonly measures: readonly SeempMeasure[];
  /** Baseline attained CII and its rating against the current year's required CII. */
  readonly before: {
    readonly attained: number;
    readonly rating: number;
    readonly grade: CiiGrade;
  };
  readonly after: {
    readonly attained: number;
    readonly rating: number;
    readonly grade: CiiGrade;
  };
  /** `1 − after / before`, percent. */
  readonly reductionPercent: number;
  /** Annual fuel after the fuel-side measures (types 2–3), t; C_F after. */
  readonly fuelAfter: {
    readonly meTon: number;
    readonly aeTon: number;
    readonly conversionFactor: number;
  };
  readonly yearsUntilInferior: number;
  /** Total cost per year of the selected measures, USD. */
  readonly costUsdPerYear: number;
  readonly costRange: { readonly low: number; readonly high: number };
  readonly costDisplay: string;
  readonly methodIds: readonly string[];
}

/**
 * What-if combination of SEEMP measures — sequential multiplicative model
 * that reduces to the legacy formulas for a single measure:
 *
 * 1. Fuel side (types 2 and 3), applied to the baseline annual fuel in
 *    legacy order: a fuel switch replaces C_F (at most one per simulation),
 *    each auxiliary-energy measure multiplies the remaining AE fuel by its
 *    factor (`FC_AE ← f_k(FC_AE)`), so two substitutions act on what the
 *    first left.
 * 2. Attained CII: re-rated from the fuel side when a type-2/3 measure is
 *    selected, `((FC_ME + FC_AE') · C_F' / (D · Cap)) · 10⁶`, otherwise the
 *    baseline attained CII.
 * 3. Operational / technical measures (type 1) then reduce the attained CII
 *    one after the other: `CII ← CII − (CII · p / 100) · v / 100`, i.e. a
 *    product of `(1 − p_k v / 10⁴)` factors.
 *
 * Costs: the per-year cost of every selected measure (legacy amortization)
 * with the combined rating after, summed.
 *
 * @method seemp.simulation_combination
 * @method seemp.reduction_type1_operational_share
 * @method seemp.reduction_type2_fuel_switch
 * @method seemp.reduction_type3_auxiliary
 * @method seemp.cost_amortization
 * @throws IncompatibleMeasuresError for more than one fuel switch.
 */
export function simulateMeasures(
  selected: readonly SeempMeasure[],
  context: SeempContext,
): SimulationResult {
  const measures = [
    ...new Map(selected.map((measure) => [measure.code, measure])).values(),
  ].sort((a, b) => a.legacyOrder - b.legacyOrder);
  const fuelSwitches = measures.filter(
    (measure) => measure.reduction.type === 'fuel_switch',
  );
  if (fuelSwitches.length > 1) {
    throw new IncompatibleMeasuresError(
      fuelSwitches.map((measure) => measure.code),
    );
  }
  const { vessel, annual } = context;
  let conversionFactor = vessel.conversionFactor;
  let fuelAeTon = annual.fuelAeTon;
  let fuelSide = false;
  for (const measure of measures) {
    const model = measure.reduction;
    if (model.type === 'fuel_switch') {
      conversionFactor = model.conversionFactor;
      fuelSide = true;
    } else if (model.type === 'auxiliary') {
      fuelAeTon = auxiliaryFuelAfter(
        fuelAeTon,
        model,
        vessel.annualVoyagePercentage,
      );
      fuelSide = true;
    }
  }
  let attained = fuelSide
    ? attainedCii(
        co2FromFuel(fuelAeTon + annual.fuelMeTon, conversionFactor),
        annual.distanceNm,
        vessel.capacity,
      )
    : context.ciiAttained;
  for (const measure of measures) {
    if (measure.reduction.type === 'operational') {
      attained = reductionType1(
        attained,
        vessel.annualVoyagePercentage,
        measure.reduction.potentialPercent,
      );
    }
  }
  const before = rateAfter(context.ciiAttained, context.ciiRequired, vessel.d);
  const after = rateAfter(attained, context.ciiRequired, vessel.d);
  const cost = measureCost(measures, context, after.ciiRatingAfter);
  return {
    measures,
    before: {
      attained: context.ciiAttained,
      rating: before.ciiRatingAfter,
      grade: before.ciiGradeAfter,
    },
    after: {
      attained,
      rating: after.ciiRatingAfter,
      grade: after.ciiGradeAfter,
    },
    reductionPercent: (1 - attained / context.ciiAttained) * 100,
    fuelAfter: { meTon: annual.fuelMeTon, aeTon: fuelAeTon, conversionFactor },
    yearsUntilInferior: cost.yearsUntilInferior,
    costUsdPerYear: cost.cost,
    costRange: cost.costRange,
    costDisplay: cost.costDisplay,
    methodIds: [
      'seemp.simulation_combination',
      ...new Set(
        measures.flatMap((measure) => [
          measure.methodId,
          reductionMethodId(measure.reduction),
        ]),
      ),
      'seemp.cost_amortization',
      'cii.required',
      'cii.rating_grade',
    ],
  };
}
