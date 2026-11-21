import type { HullForm } from './types.js';

/** Open-water and relative-rotative efficiencies of the legacy (η₀ = 0.42 · η_R = 0.96). */
// SOURCE: thesis — needs citation (0.96 and 0.42)
const PROPULSIVE_FACTOR = 0.96 * 0.42;
/** Shaft and gearbox transmission efficiency (each 0.98). */
// SOURCE: thesis — needs citation
export const TRANSMISSION_EFFICIENCY = 0.98;
/** Engine load at service relative to MCR (85 %). */
// SOURCE: thesis — needs citation
export const MCR_SERVICE_LOAD = 0.85;

/**
 * Taylor wake fraction `w = 0.5 C_B − 0.05`.
 *
 * Port of `calculateW` (`be-legacy/src/utils/cii/second-formula/power-calculation.ts`).
 *
 * @method resistance.power.propulsive_efficiency
 */
export function wakeFraction(hull: Pick<HullForm, 'cb'>): number {
  return 0.5 * hull.cb - 0.05;
}

/**
 * Effective power, kW: `P_E = V · R_T,SM` (V in m/s, R in kN).
 *
 * Port of `calculateEHP`.
 *
 * @method resistance.power.effective_power
 * @see docs/METHODOLOGY.md#resistance.power.effective_power
 */
export function effectivePower(speedMs: number, rtPlusSm: number): number {
  return speedMs * rtPlusSm;
}

/**
 * Delivered power, kW: `P_D = P_E / (η_R η₀ η_H)` with thrust deduction
 * `t = 0.9 w` and hull efficiency `η_H = (1 − t) / (1 − w)`.
 *
 * Port of `calculateDHP`.
 *
 * @method resistance.power.propulsive_efficiency
 * @see docs/METHODOLOGY.md#resistance.power.propulsive_efficiency
 */
export function deliveredPower(
  effectivePowerKw: number,
  hull: Pick<HullForm, 'cb'>,
): number {
  const w = wakeFraction(hull);
  const t = w * 0.9;
  const nh = (1 - t) / (1 - w);
  const pc = PROPULSIVE_FACTOR * nh;
  return effectivePowerKw / pc;
}

/**
 * Shaft power, kW: `P_S = P_D / 0.98`.
 *
 * Port of `calculateSHP`.
 *
 * @method resistance.power.transmission_mcr
 */
export function shaftPower(deliveredPowerKw: number): number {
  return deliveredPowerKw / TRANSMISSION_EFFICIENCY;
}

/**
 * Brake power at MCR, kW: `P_B,MCR = P_S / 0.98 / 0.85`.
 *
 * Port of `calculateBHPMCR`.
 *
 * @method resistance.power.transmission_mcr
 * @see docs/METHODOLOGY.md#resistance.power.transmission_mcr
 */
export function mcrPower(shaftPowerKw: number): number {
  return shaftPowerKw / TRANSMISSION_EFFICIENCY / MCR_SERVICE_LOAD;
}
