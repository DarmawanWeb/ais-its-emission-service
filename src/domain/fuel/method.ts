import type { FuelEstimationMethod } from '@darmawanweb/ais-its-contracts/domain';

/** What is available to estimate the fuel of a segment. */
export interface FuelMethodInputs {
  /** Telemetry is active for the segment (see `isTelemetryActive`). */
  readonly telemetryActive: boolean;
  /** The vessel has a first fuel formula (fleet `firstFuelFormula`). */
  readonly hasFirstFormula: boolean;
  /** The vessel has a main engine with an SFOC (needed by the Holtrop path). */
  readonly hasMainEngine: boolean;
}

/**
 * Fuel estimation method by priority (spec §13.5, legacy
 * `CIIService.calculateCII`): telemetry → first formula → Holtrop. `null`
 * when no method applies (no telemetry, no formula and no main engine: the
 * legacy threw a TypeError there).
 *
 * @method fuel.method_selection
 * @see docs/METHODOLOGY.md#fuel.method_selection
 */
export function selectFuelMethod(inputs: FuelMethodInputs): FuelEstimationMethod | null {
  if (inputs.telemetryActive) return 'telemetry';
  if (inputs.hasFirstFormula) return 'first_formula';
  if (inputs.hasMainEngine) return 'holtrop';
  return null;
}
