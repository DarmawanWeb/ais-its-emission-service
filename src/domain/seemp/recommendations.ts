import type { CiiGrade } from '@darmawanweb/ais-its-contracts/domain';

import { costPerYear, formatCost, investmentCost, yearsUntilInferior } from './cost.js';
import { reductionMethodId, type SeempMeasure } from './measures.js';
import { rateAfter, reductionType1, reductionType2, reductionType3 } from './reduction.js';
import type { SeempContext } from './types.js';

/** A measure evaluated for a vessel (legacy `ISEEMPFormulaResult` + name). */
export interface MeasureEvaluation {
  readonly measure: SeempMeasure;
  /** Attained CII after the measure, g CO2 / (capacity · nm). */
  readonly ciiAttainedAfter: number;
  readonly ciiRatingAfter: number;
  readonly ciiGradeAfter: CiiGrade;
  /** Years until D/E used to spread the investment. */
  readonly yearsUntilInferior: number;
  /** Cost per year, USD (mean of the range for ranged measures) — the sort key. */
  readonly cost: number;
  /** Cost text, e.g. `"$107,500"` or `"$25,000 - $200,000"`. */
  readonly costDisplay: string;
  /** Low and high cost per year, USD (equal unless the measure has a range). */
  readonly costRange: { readonly low: number; readonly high: number };
  /** Methodology ids behind the figure. */
  readonly methodIds: readonly string[];
}

/** The attained CII after one measure, by its reduction type. */
export function attainedAfterMeasure(measure: SeempMeasure, context: SeempContext): number {
  const { vessel } = context;
  const model = measure.reduction;
  switch (model.type) {
    case 'operational':
      return reductionType1(context.ciiAttained, vessel.annualVoyagePercentage, model.potentialPercent);
    case 'fuel_switch':
      return reductionType2(context.annual, vessel.capacity, model.conversionFactor);
    case 'auxiliary':
      return reductionType3(context.annual, vessel.capacity, vessel.conversionFactor, model, vessel.annualVoyagePercentage);
  }
}

/** Cost per year of a measure for a rating after, with its display text. */
export function measureCost(
  measures: readonly SeempMeasure[],
  context: SeempContext,
  ciiRatingAfter: number,
): Pick<MeasureEvaluation, 'yearsUntilInferior' | 'cost' | 'costDisplay' | 'costRange'> {
  const years = yearsUntilInferior(ciiRatingAfter, context);
  let low = 0;
  let high = 0;
  let mean = 0;
  let ranged = false;
  for (const measure of measures) {
    const investment = investmentCost(measure.cost, context.vessel);
    const costLow = costPerYear(investment.lowUsd, years);
    const costHigh = costPerYear(investment.highUsd, years);
    ranged ||= measure.cost.type === 'range';
    low += costLow;
    high += costHigh;
    mean += measure.cost.type === 'range' ? (costHigh + costLow) / 2 : costLow;
  }
  return {
    yearsUntilInferior: years,
    cost: mean,
    costDisplay: ranged ? `${formatCost(low)} - ${formatCost(high)}` : formatCost(mean),
    costRange: { low, high },
  };
}

/**
 * Evaluates one measure: attained CII after it (type 1, 2 or 3), rating and
 * grade against the current year's required CII, and the investment spread
 * over the years until D/E.
 *
 * Port of the twelve `calculate*` functions of
 * `be-legacy/src/utils/seemp/{first,second,third}-formula.ts`.
 *
 * @method seemp.reduction_type1_operational_share
 * @method seemp.reduction_type2_fuel_switch
 * @method seemp.reduction_type3_auxiliary
 * @method seemp.cost_by_power
 * @method seemp.cost_amortization
 */
export function evaluateMeasure(measure: SeempMeasure, context: SeempContext): MeasureEvaluation {
  const ciiAttainedAfter = attainedAfterMeasure(measure, context);
  const rated = rateAfter(ciiAttainedAfter, context.ciiRequired, context.vessel.d);
  return {
    measure,
    ciiAttainedAfter,
    ...rated,
    ...measureCost([measure], context, rated.ciiRatingAfter),
    methodIds: [
      measure.methodId,
      reductionMethodId(measure.reduction),
      'seemp.cost_by_power',
      'seemp.cost_amortization',
      'cii.required',
      'cii.rating_grade',
    ],
  };
}

/** Grades kept by the recommender (legacy filter). */
export const RECOMMENDED_GRADES: readonly CiiGrade[] = ['A', 'B', 'C'];

/**
 * SEEMP recommendations: every measure evaluated in legacy order, kept when
 * the grade after is A–C, sorted by cost per year ascending (stable, so ties
 * keep the legacy order).
 *
 * Port of `SEEMPService.calculateSemp` (`be-legacy/src/services/seemp.service.ts`).
 *
 * @method seemp.filter_sort_output
 * @see docs/METHODOLOGY.md#seemp.filter_sort_output
 */
export function recommendMeasures(measures: readonly SeempMeasure[], context: SeempContext): MeasureEvaluation[] {
  return [...measures]
    .sort((a, b) => a.legacyOrder - b.legacyOrder)
    .map((measure) => evaluateMeasure(measure, context))
    .filter((evaluation) => RECOMMENDED_GRADES.includes(evaluation.ciiGradeAfter))
    .sort((a, b) => a.cost - b.cost);
}

/** A recommendation in the output shape of the legacy (camelCase already). */
export interface LegacyRecommendation {
  readonly recommendation: string;
  /** Cost text. */
  readonly cost: string;
  /** Rating after, rounded to 8 decimals (`Number(x.toFixed(8))`). */
  readonly ciiRatingAfter: number;
  readonly ciiGradeAfter: CiiGrade;
  /** Rating of the previous year's annual record, `null` without one (legacy `undefined`). */
  readonly ciiRatingBefore: number | null;
  readonly ciiGradeBefore: CiiGrade | null;
}

/**
 * Maps an evaluation to the legacy output item of
 * `SEEMPService.calculateSEEMPbyMMSI`.
 *
 * @method seemp.filter_sort_output
 */
export function toLegacyRecommendation(
  evaluation: MeasureEvaluation,
  before: { readonly rating: number; readonly grade: CiiGrade } | null,
): LegacyRecommendation {
  return {
    recommendation: evaluation.measure.name,
    cost: evaluation.costDisplay,
    ciiRatingAfter: Number(evaluation.ciiRatingAfter.toFixed(8)),
    ciiGradeAfter: evaluation.ciiGradeAfter,
    ciiRatingBefore: before?.rating ?? null,
    ciiGradeBefore: before?.grade ?? null,
  };
}
