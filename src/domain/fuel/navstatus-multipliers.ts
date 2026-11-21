/** Main / auxiliary engine fuel multipliers of an AIS navigational status. */
export interface FuelMultiplier {
  /** Main engine factor (dimensionless). */
  readonly me: number;
  /** Auxiliary engine factor (dimensionless). */
  readonly ae: number;
}

/**
 * ME/AE fuel multipliers by AIS navigational status (ITU-R M.1371 codes
 * 0–15), legacy `fuelMultipliers` (`be-legacy/src/utils/cii/fuel-calculation.ts`):
 * at anchor (1) ME 0 / AE 0.5, restricted manoeuvrability (3), constrained by
 * draught (4) and fishing (7) ME 0.5, moored (5) ME 0, AIS-SART (14) both 0,
 * every other code 1 / 1.
 *
 * @method fuel.navstatus_multipliers
 * @see docs/METHODOLOGY.md#fuel.navstatus_multipliers
 */
// SOURCE: thesis — needs citation (operating-mode factors of the MVP)
export const FUEL_NAVSTATUS_MULTIPLIERS: Readonly<
  Record<number, FuelMultiplier>
> = Object.freeze({
  0: { me: 1, ae: 1 },
  1: { me: 0, ae: 0.5 },
  2: { me: 1, ae: 1 },
  3: { me: 0.5, ae: 1 },
  4: { me: 0.5, ae: 1 },
  5: { me: 0, ae: 1 },
  6: { me: 1, ae: 1 },
  7: { me: 0.5, ae: 1 },
  8: { me: 1, ae: 1 },
  9: { me: 1, ae: 1 },
  10: { me: 1, ae: 1 },
  11: { me: 1, ae: 1 },
  12: { me: 1, ae: 1 },
  13: { me: 1, ae: 1 },
  14: { me: 0, ae: 0 },
  15: { me: 1, ae: 1 },
});

/** Fuel after applying the navstatus multipliers (same unit as the input). */
export interface NavstatusFuel {
  readonly totalMe: number;
  readonly totalAe: number;
}

/**
 * Applies the multipliers of `navstatus` — the status **reported at the
 * previous fix** (legacy `positions[1].navstatus`) — to an ME and AE fuel
 * estimate; an unknown code yields zero fuel (legacy behaviour).
 *
 * Port of `getFuelByNavStatus` (`be-legacy/src/utils/cii/fuel-calculation.ts`).
 *
 * @method fuel.navstatus_multipliers
 * @param navstatus AIS navigational status code (0–15).
 * @param fuelMe main engine fuel (L/min, t or any unit).
 * @param fuelAe auxiliary engine fuel (same unit).
 */
export function getFuelByNavStatus(
  navstatus: number,
  fuelMe: number,
  fuelAe: number,
): NavstatusFuel {
  const multipliers = FUEL_NAVSTATUS_MULTIPLIERS[navstatus];
  if (multipliers === undefined) return { totalMe: 0, totalAe: 0 };
  return {
    totalMe: fuelMe * multipliers.me,
    totalAe: fuelAe * multipliers.ae,
  };
}
