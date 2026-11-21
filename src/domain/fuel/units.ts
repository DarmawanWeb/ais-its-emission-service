/**
 * Fuel volume to mass: `m [t] = V [L] × ρ [kg/L] / 1000`.
 *
 * Port of `calculateTotalFuelTon` (`be-legacy/src/utils/cii/fuel-calculation.ts`);
 * the litre unit of the regressions is implied by this conversion.
 *
 * @method fuel.density_conversion
 * @param litres fuel volume, L.
 * @param densityKgPerL fuel density, kg/L (= t/m³).
 * @returns fuel mass, t.
 * @see docs/METHODOLOGY.md#fuel.density_conversion
 * @see https://www.iso.org/standard/76286.html (ISO 8217 densities)
 */
export function litresToTonnes(litres: number, densityKgPerL: number): number {
  return (litres * densityKgPerL) / 1000;
}
