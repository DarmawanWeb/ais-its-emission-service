import type { FuelEstimationMethod } from '@darmawanweb/ais-its-contracts/domain';

/**
 * Methodology ids behind the figures of the API responses (`methodIds`,
 * spec §17), grouped by what produced the figure.
 */
export const METHOD_IDS = {
  /** Every segment: distance, speed and the gap rule; CO2 from fuel. */
  segment: [
    'geo.haversine_distance',
    'geo.speed_from_positions',
    'emission.segment_window',
    'emission.co2_conversion',
  ],
  /** Fuel by estimation method. */
  fuel: {
    telemetry: ['fuel.method_selection', 'telemetry.fuel_reading_usage'],
    first_formula: [
      'fuel.method_selection',
      'fuel.first_formula',
      'fuel.navstatus_multipliers',
      'fuel.density_conversion',
    ],
    holtrop: [
      'fuel.method_selection',
      'weather.open_meteo_current',
      'weather.beaufort_number',
      'weather.encounter_angle',
      'weather.kwon_speed_coefficient',
      'weather.kwon_direction_coefficient',
      'weather.kwon_form_coefficient',
      'weather.speed_loss_correction',
      'geo.rhumb_line_course',
      'resistance.hull_volumes_and_lengths',
      'resistance.holtrop.reynolds_froude',
      'resistance.holtrop.friction_line',
      'resistance.holtrop.friction',
      'resistance.holtrop.form_factor',
      'resistance.holtrop.lcb_length_of_run',
      'resistance.holtrop.appendage',
      'resistance.holtrop.wetted_surface',
      'resistance.holtrop.wave_c1_c7_ie',
      'resistance.holtrop.wave_bulb_transom',
      'resistance.holtrop.wave_m1_m2_lambda',
      'resistance.holtrop.wave',
      'resistance.holtrop.correlation_allowance',
      'resistance.total_and_sea_margin',
      'resistance.power.effective_power',
      'resistance.power.propulsive_efficiency',
      'resistance.power.transmission_mcr',
      'fuel.second_formula_me',
      'fuel.second_formula_ae',
      'fuel.ae_regression',
      'fuel.navstatus_multipliers',
      'fuel.density_conversion',
    ],
  } satisfies Record<FuelEstimationMethod, readonly string[]>,
  /** Attained, required, rating, grade and boundaries. */
  rating: [
    'cii.attained_accumulation',
    'cii.reference_line',
    'cii.reduction_factor_z',
    'cii.required',
    'cii.rating_grade',
    'cii.dd_vector_boundaries',
  ],
  manual: ['cii.annual_manual'],
  projection: ['cii.year_end_projection'],
  dcs: ['emission.dcs_summary'],
} as const;

/** Segment counts per fuel method. */
export interface MethodCounts {
  readonly telemetry: number;
  readonly firstFormula: number;
  readonly holtrop: number;
}

/** Method ids of figures computed from segments with the given method counts. */
export function segmentMethodIds(counts: MethodCounts): string[] {
  const ids: string[] = [...METHOD_IDS.segment];
  if (counts.telemetry > 0) ids.push(...METHOD_IDS.fuel.telemetry);
  if (counts.firstFormula > 0) ids.push(...METHOD_IDS.fuel.first_formula);
  if (counts.holtrop > 0) ids.push(...METHOD_IDS.fuel.holtrop);
  return [...new Set(ids)];
}

/** Deduplicated concatenation of method id lists (declaration order kept). */
export function mergeMethodIds(
  ...lists: readonly (readonly string[])[]
): string[] {
  return [...new Set(lists.flat())];
}
