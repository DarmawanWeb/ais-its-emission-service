import type { DdVector } from '@darmawanweb/ais-its-contracts/domain';

import type { ReferenceLine } from '../cii.js';
import type { HullForm } from '../holtrop/types.js';

/** What the SEEMP models need from the vessel profile (legacy `IShipData`). */
export interface SeempVessel {
  /** CII capacity (`type.capacityFixed ?? dimensions.capacity`). */
  readonly capacity: number;
  readonly referenceLine: ReferenceLine;
  readonly d: DdVector;
  /** C_F of the vessel's fuel, t CO2 / t fuel. */
  readonly conversionFactor: number;
  /** Length overall, m. */
  readonly loaM: number;
  readonly hull: HullForm;
  /** Rated power of the main engine, kW (0 without one). */
  readonly mainEnginePowerKw: number;
  readonly mainEngineQuantity: number;
  /** Rated power of the first auxiliary engine, kW (legacy `engine[0].power`). */
  readonly auxEnginePowerKw: number;
  readonly auxEngineQuantity: number;
  /** Share of the year at sea, percent (legacy `annualVoyagePercentage`). */
  readonly annualVoyagePercentage: number;
}

/** Annual fuel and distance of the baseline year (types 2 and 3). */
export interface AnnualFuelBaseline {
  readonly fuelMeTon: number;
  readonly fuelAeTon: number;
  readonly distanceNm: number;
}

/** Inputs of the SEEMP models. */
export interface SeempContext {
  readonly vessel: SeempVessel;
  /** Required CII of {@link currentYear} (legacy: latest daily `ciiRequired`). */
  readonly ciiRequired: number;
  /** Attained CII of the baseline year (type 1; legacy: last annual record). */
  readonly ciiAttained: number;
  /** Fuel and distance of the baseline year (types 2–3; legacy: `annual.cii[0]`). */
  readonly annual: AnnualFuelBaseline;
  /** Year the measures are rated in (legacy `new Date().getFullYear()`). */
  readonly currentYear: number;
  /** Highest year of the reduction factor table (legacy `getHighestYear`). */
  readonly highestYear: number;
  /** Z of a year, percent; `undefined` when the table has none. */
  readonly zOf: (year: number) => number | undefined;
}
