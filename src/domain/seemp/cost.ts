import { gradeAgainstRequired, referenceCii, requiredCii } from '../cii.js';
import { wettedSurface } from '../holtrop/wetted-surface.js';
import type { SeempCostModel } from './measures.js';
import type { SeempContext, SeempVessel } from './types.js';

/** A year without a reduction factor was needed. */
export class MissingReductionFactorError extends Error {
  override readonly name = 'MissingReductionFactorError';

  constructor(readonly year: number) {
    super(`No reduction factor (Z) for ${year}`);
  }
}

/**
 * Investment cost from installed power, USD:
 * `(P_AE · n_AE + P_ME · n_ME) · cost_per_kW` with the first auxiliary
 * engine's power for every auxiliary engine (legacy).
 *
 * Port of `calculateCostbyPower` (`be-legacy/src/utils/seemp/utils.ts`).
 *
 * @method seemp.cost_by_power
 * @see docs/METHODOLOGY.md#seemp.cost_by_power
 */
export function costByPower(
  vessel: SeempVessel,
  costPerKw: number,
  useMe = true,
  useAe = true,
): number {
  const totalPowerAe = useAe
    ? vessel.auxEnginePowerKw * vessel.auxEngineQuantity
    : 0;
  const totalPowerMe = useMe
    ? vessel.mainEnginePowerKw * vessel.mainEngineQuantity
    : 0;
  return (totalPowerAe + totalPowerMe) * costPerKw;
}

/**
 * Cost text of the legacy: `$` and the amount rounded to whole dollars with
 * en-US grouping (`Number(cost.toFixed(0)).toLocaleString()` on an en-US host).
 *
 * @method seemp.cost_by_power
 */
export function formatCost(cost: number): string {
  const costData = Number(cost.toFixed(0));
  return `$${costData.toLocaleString('en-US')}`;
}

/** The investment of a measure, USD (low = high except for ranges). */
export interface Investment {
  readonly lowUsd: number;
  readonly highUsd: number;
}

/**
 * Investment cost of a measure for a vessel, USD: LOA bands (air
 * lubrication), wetted surface × 100 (hull coating), installed power, or a
 * fixed range.
 *
 * Port of the cost terms of `be-legacy/src/utils/seemp/{first,second,third}-formula.ts`.
 *
 * @method seemp.cost_by_power
 */
export function investmentCost(
  model: SeempCostModel,
  vessel: SeempVessel,
): Investment {
  switch (model.type) {
    case 'loa_bands': {
      const band = model.bands.find(
        (candidate) =>
          candidate.maxLoaM === null || vessel.loaM <= candidate.maxLoaM,
      );
      const usd = band?.usd ?? 0;
      return { lowUsd: usd, highUsd: usd };
    }
    case 'range':
      return { lowUsd: model.lowUsd, highUsd: model.highUsd };
    case 'wetted_surface': {
      const usd = wettedSurface(vessel.hull) * model.usdPerM2;
      return { lowUsd: usd, highUsd: usd };
    }
    case 'installed_power': {
      const usd =
        costByPower(
          vessel,
          model.usdPerKw,
          model.mainEngine,
          model.auxEngines,
        ) + model.fixedUsd;
      return { lowUsd: usd, highUsd: usd };
    }
  }
}

/**
 * Years until the vessel would fall to grade D or E with the rating after
 * the measure: the attained CII `rating · CII_req(current year)` is kept
 * constant and graded against `d_i · CII_req(y)` for y = current year …
 * highest year of the Z table; the first D/E year gives `y − current`, else
 * `highest − current`.
 *
 * Port of `calculatedYear` (`be-legacy/src/utils/seemp/cost-calc.ts`).
 *
 * @method seemp.cost_amortization
 * @throws MissingReductionFactorError when a year of the range has no Z.
 * @see docs/METHODOLOGY.md#seemp.cost_amortization
 */
export function yearsUntilInferior(
  ciiRating: number,
  context: Omit<SeempContext, 'ciiRequired' | 'ciiAttained' | 'annual'>,
): number {
  const { vessel, currentYear, highestYear } = context;
  const reference = referenceCii(vessel.referenceLine, vessel.capacity);
  const requiredOf = (year: number): number => {
    const z = context.zOf(year);
    if (z === undefined) throw new MissingReductionFactorError(year);
    return requiredCii(z, reference);
  };
  const ciiAttained = ciiRating * requiredOf(currentYear);
  for (let year = currentYear; year <= highestYear; year++) {
    const grade = gradeAgainstRequired(vessel.d, ciiAttained, requiredOf(year));
    if (grade === 'D' || grade === 'E') return year - currentYear;
  }
  return highestYear - currentYear;
}

/**
 * Cost per year: the investment spread over the years until D/E
 * (`total / years`), or the full investment when that is at most one year.
 *
 * Port of `calculateCostPerYear` (`be-legacy/src/utils/seemp/cost-calc.ts`).
 *
 * @method seemp.cost_amortization
 */
export function costPerYear(totalCost: number, years: number): number {
  if (years <= 1) return totalCost;
  return totalCost / years;
}
