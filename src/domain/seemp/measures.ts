/**
 * The 12 SEEMP measures of the legacy recommender
 * (`be-legacy/src/services/seemp.service.ts#calculateSemp`,
 * `be-legacy/src/utils/seemp/{first,second,third}-formula.ts`): codes, the
 * names exactly as the legacy strings (typos included), the reduction model
 * with the arguments the legacy passes, and the investment cost model.
 * `migrations/0002_seed.sql` seeds `seemp_measures` with the same values (an
 * integration test compares them).
 */

/** How a measure changes the attained CII. */
export type SeempReductionModel =
  /** Type 1 (`calculateFirstCiiAndGrade`): `potentialPercent` of the attained CII, weighted by the share of the year at sea. */
  | { readonly type: 'operational'; readonly potentialPercent: number }
  /** Type 2 (`calculateSecondCiiAndGrade`): the annual fuel re-rated with another C_F. */
  | { readonly type: 'fuel_switch'; readonly conversionFactor: number }
  /**
   * Type 3 (`calculateThirdCiiAndGrade`): auxiliary energy substitution — AE
   * fuel × (1 − `potentialShare`), or for cold ironing the at-berth share of
   * the year (`voyagePercent`; `null` = the vessel's annual voyage
   * percentage) supplied from shore at 80 %. `voyagePercent` has no effect
   * without cold ironing (legacy argument kept as is).
   */
  | {
      readonly type: 'auxiliary';
      readonly potentialShare: number;
      readonly coldIroning: boolean;
      readonly voyagePercent: number | null;
    };

/** How the investment cost of a measure is estimated, USD. */
export type SeempCostModel =
  /** By length overall: the first band whose `maxLoaM` (inclusive; `null` = no limit) is not exceeded. */
  | {
      readonly type: 'loa_bands';
      readonly bands: readonly { readonly maxLoaM: number | null; readonly usd: number }[];
    }
  /** A low–high range; the recommendation cost is the mean of both per-year costs. */
  | { readonly type: 'range'; readonly lowUsd: number; readonly highUsd: number }
  /** Per m² of wetted surface (Holtrop–Mennen S). */
  | { readonly type: 'wetted_surface'; readonly usdPerM2: number }
  /** Per kW of installed power (`calculateCostbyPower`) plus a fixed amount. */
  | {
      readonly type: 'installed_power';
      readonly usdPerKw: number;
      readonly mainEngine: boolean;
      readonly auxEngines: boolean;
      readonly fixedUsd: number;
    };

/** A SEEMP measure of the catalog. */
export interface SeempMeasure {
  /** Stable code (`seemp_measures.code`). */
  readonly code: string;
  /** Recommendation text, exactly the legacy string. */
  readonly name: string;
  readonly category: 'technical' | 'operational' | 'fuel' | 'energy';
  /** Position in the legacy result list before sorting (ties keep it). */
  readonly legacyOrder: number;
  /** Methodology catalog id of the measure. */
  readonly methodId: string;
  readonly reduction: SeempReductionModel;
  readonly cost: SeempCostModel;
}

/**
 * The legacy measures in legacy order.
 *
 * @method seemp.measure.air_lubrication
 * @method seemp.measure.resistance_reduction_devices
 * @method seemp.measure.hull_coating
 * @method seemp.measure.power_system_machinery
 * @method seemp.measure.propulsion_efficiency_devices
 * @method seemp.measure.waste_heat_recovery
 * @method seemp.measure.lng
 * @method seemp.measure.biofuel
 * @method seemp.measure.solar
 * @method seemp.measure.wind
 * @method seemp.measure.cold_ironing
 * @method seemp.measure.fuel_cells
 * @see docs/METHODOLOGY.md#9-seemp-model-reduksi-biaya-dan-12-langkah-emission
 */
// SOURCE: thesis — needs citation (reduction potentials and unit costs of the 12 measures)
export const LEGACY_SEEMP_MEASURES: readonly SeempMeasure[] = Object.freeze([
  {
    code: 'air_lubrication',
    name: 'Modified and install hull air cavity lubrication system on ship',
    category: 'technical',
    legacyOrder: 1,
    methodId: 'seemp.measure.air_lubrication',
    reduction: { type: 'operational', potentialPercent: 8 },
    cost: {
      type: 'loa_bands',
      bands: [
        { maxLoaM: 100, usd: 430000 },
        { maxLoaM: 200, usd: 850000 },
        { maxLoaM: null, usd: 1280000 },
      ],
    },
  },
  {
    code: 'resistance_reduction_devices',
    name: 'Modified and install resistance reduction devices on ship',
    category: 'technical',
    legacyOrder: 2,
    methodId: 'seemp.measure.resistance_reduction_devices',
    reduction: { type: 'operational', potentialPercent: 9 },
    cost: { type: 'range', lowUsd: 300000, highUsd: 700000 },
  },
  {
    code: 'hull_coating',
    name: 'Hull coating maintenance on the hull surface',
    category: 'operational',
    legacyOrder: 3,
    methodId: 'seemp.measure.hull_coating',
    reduction: { type: 'operational', potentialPercent: 10 },
    cost: { type: 'wetted_surface', usdPerM2: 100 },
  },
  {
    code: 'power_system_machinery',
    name: 'Variable speed electric power generation',
    category: 'technical',
    legacyOrder: 4,
    methodId: 'seemp.measure.power_system_machinery',
    reduction: { type: 'operational', potentialPercent: 10 },
    cost: { type: 'installed_power', usdPerKw: 500, mainEngine: true, auxEngines: false, fixedUsd: 0 },
  },
  {
    code: 'propulsion_efficiency_devices',
    name: 'Install propulsion exfficiency devices',
    category: 'technical',
    legacyOrder: 5,
    methodId: 'seemp.measure.propulsion_efficiency_devices',
    reduction: { type: 'operational', potentialPercent: 13 },
    cost: { type: 'range', lowUsd: 100000, highUsd: 800000 },
  },
  {
    code: 'waste_heat_recovery',
    name: 'Utilize waste heat recovery from machinery devices on ship',
    category: 'technical',
    legacyOrder: 6,
    methodId: 'seemp.measure.waste_heat_recovery',
    reduction: { type: 'operational', potentialPercent: 10 },
    cost: { type: 'installed_power', usdPerKw: 100, mainEngine: true, auxEngines: true, fixedUsd: 0 },
  },
  {
    code: 'lng',
    name: 'Using LNG for main engine and auxiliary engine',
    category: 'fuel',
    legacyOrder: 7,
    methodId: 'seemp.measure.lng',
    reduction: { type: 'fuel_switch', conversionFactor: 2.75 },
    cost: { type: 'installed_power', usdPerKw: 1580, mainEngine: true, auxEngines: true, fixedUsd: 0 },
  },
  {
    code: 'biofuel',
    name: 'Using biofuels for main engine and auxiliary engine',
    category: 'fuel',
    legacyOrder: 8,
    methodId: 'seemp.measure.biofuel',
    reduction: { type: 'fuel_switch', conversionFactor: 2.45 },
    cost: { type: 'installed_power', usdPerKw: 20, mainEngine: true, auxEngines: true, fixedUsd: 0 },
  },
  {
    code: 'solar',
    name: 'Using solar panel energy source for supply electricity demand on ship',
    category: 'energy',
    legacyOrder: 9,
    methodId: 'seemp.measure.solar',
    reduction: { type: 'auxiliary', potentialShare: 0.12, coldIroning: false, voyagePercent: 42 },
    cost: { type: 'installed_power', usdPerKw: 3000, mainEngine: false, auxEngines: true, fixedUsd: 0 },
  },
  {
    code: 'wind',
    name: 'Using wind power energy source for supply electricity demand on ship',
    category: 'energy',
    legacyOrder: 10,
    methodId: 'seemp.measure.wind',
    reduction: { type: 'auxiliary', potentialShare: 0.15, coldIroning: false, voyagePercent: 0 },
    cost: { type: 'installed_power', usdPerKw: 4000, mainEngine: false, auxEngines: true, fixedUsd: 0 },
  },
  {
    code: 'cold_ironing',
    name: 'Using cold ironing energy source for supply electricity demand on ship',
    category: 'energy',
    legacyOrder: 11,
    methodId: 'seemp.measure.cold_ironing',
    reduction: { type: 'auxiliary', potentialShare: 0.1, coldIroning: true, voyagePercent: null },
    cost: { type: 'installed_power', usdPerKw: 0.5, mainEngine: false, auxEngines: true, fixedUsd: 800150 },
  },
  {
    code: 'fuel_cells',
    name: 'Using fuel cells energy source for supply electricity demand on ship',
    category: 'energy',
    legacyOrder: 12,
    methodId: 'seemp.measure.fuel_cells',
    reduction: { type: 'auxiliary', potentialShare: 0.2, coldIroning: false, voyagePercent: 0 },
    cost: { type: 'installed_power', usdPerKw: 1780, mainEngine: false, auxEngines: true, fixedUsd: 0 },
  },
]);

/** Methodology ids of the reduction model of a measure. */
export function reductionMethodId(model: SeempReductionModel): string {
  switch (model.type) {
    case 'operational':
      return 'seemp.reduction_type1_operational_share';
    case 'fuel_switch':
      return 'seemp.reduction_type2_fuel_switch';
    case 'auxiliary':
      return 'seemp.reduction_type3_auxiliary';
  }
}
