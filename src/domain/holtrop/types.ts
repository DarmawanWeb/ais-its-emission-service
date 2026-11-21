import type { VesselDimensions } from '@darmawanweb/ais-its-contracts/events';

/**
 * Hull particulars used by the Holtrop–Mennen / Kwon chain (fleet
 * `vessel_dimensions`, legacy `IShipSize`). Lengths in metres, coefficients
 * dimensionless: `lwl` length on waterline, `lpp` length between
 * perpendiculars, `b` breadth, `t` draught, `cb` block, `cp` prismatic,
 * `cm` midship section, `cwp` waterplane area, `cbnsp` block coefficient at
 * service draught, `cstern` stern shape, `c1 c2 c3 c5` appendage factors,
 * `bulbousBow` (legacy `bulbosbow`).
 */
export type HullForm = Pick<
  VesselDimensions,
  | 'cb'
  | 'lwl'
  | 'b'
  | 't'
  | 'cwp'
  | 'lpp'
  | 'cp'
  | 'cm'
  | 'cbnsp'
  | 'bulbousBow'
  | 'cstern'
  | 'c1'
  | 'c2'
  | 'c3'
  | 'c5'
>;

/** A speed in both units (legacy `ISpeed`). */
export interface Speed {
  /** Knots. */
  readonly speedKn: number;
  /** Metres per second (× 0.5144). */
  readonly speedMs: number;
}
