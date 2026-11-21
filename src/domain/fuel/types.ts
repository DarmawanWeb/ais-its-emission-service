/**
 * Fuel consumed during a segment, metric tonnes (legacy `IFuelConsumption`,
 * `be-legacy/src/types/second-formula.types.ts`).
 */
export interface FuelConsumption {
  /** Main engine fuel, t. */
  readonly meTon: number;
  /** Auxiliary engine fuel, t. */
  readonly aeTon: number;
  /**
   * Total fuel, t. Kept separately because the legacy computes it with its own
   * operation order (first formula: `(ME + AE) × minutes × ρ / 1000`).
   */
  readonly totalTon: number;
}
