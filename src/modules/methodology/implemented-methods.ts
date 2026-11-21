/**
 * Ids of the methodology catalog methods this service implements
 * (docs/references/methods.json, docs/PLATFORM_SPEC.md §17). Keep it in sync
 * with the `@method` TSDoc tags of the implementing functions and with the
 * README section "Methodology & references". Ids marked "v2" are not in the
 * shipped catalog yet (proposed ids, reported for a catalog release).
 */
export const IMPLEMENTED_METHOD_IDS: readonly string[] = [
  // Segments (src/domain/segment.ts)
  'geo.haversine_distance',
  'geo.speed_from_positions',
  'geo.rhumb_line_course',
  'emission.segment_window', // v2
  // Fuel (src/domain/fuel/*)
  'fuel.method_selection',
  'telemetry.fuel_reading_usage',
  'fuel.navstatus_multipliers',
  'fuel.first_formula',
  'fuel.ae_regression',
  'fuel.density_conversion',
  // Holtrop–Mennen resistance and power (src/domain/holtrop/*)
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
  // Weather (src/domain/weather/*, src/modules/weather/*)
  'weather.open_meteo_current',
  'weather.beaufort_number',
  'weather.encounter_angle',
  'weather.kwon_direction_coefficient',
  'weather.kwon_speed_coefficient',
  'weather.kwon_form_coefficient',
  'weather.speed_loss_correction',
  'fuel.second_formula_me',
  'fuel.second_formula_ae',
  // CO2 and CII (src/domain/cii.ts, src/domain/cii-projection.ts)
  'emission.co2_conversion',
  'cii.attained_accumulation',
  'cii.reference_line',
  'cii.reduction_factor_z',
  'cii.required',
  'cii.rating_grade',
  'cii.dd_vector_boundaries',
  'cii.annual_manual',
  'cii.year_end_projection', // v2
  // SEEMP (src/domain/seemp/*)
  'seemp.reduction_type1_operational_share',
  'seemp.reduction_type2_fuel_switch',
  'seemp.reduction_type3_auxiliary',
  'seemp.cost_by_power',
  'seemp.cost_amortization',
  'seemp.filter_sort_output',
  'seemp.measure.air_lubrication',
  'seemp.measure.resistance_reduction_devices',
  'seemp.measure.hull_coating',
  'seemp.measure.power_system_machinery',
  'seemp.measure.propulsion_efficiency_devices',
  'seemp.measure.waste_heat_recovery',
  'seemp.measure.lng',
  'seemp.measure.biofuel',
  'seemp.measure.solar',
  'seemp.measure.wind',
  'seemp.measure.cold_ironing',
  'seemp.measure.fuel_cells',
  'seemp.simulation_combination', // v2
  // DCS (src/domain/dcs.ts)
  'emission.dcs_summary', // v2
];

/**
 * Catalog methods whose references are the sources of the CII reference
 * lines and rating vectors of the vessel types (MEPC.353(78), MEPC.354(78)).
 */
export const VESSEL_TYPE_SOURCE_METHOD_IDS: readonly string[] = [
  'cii.reference_line',
  'cii.rating_grade',
];
