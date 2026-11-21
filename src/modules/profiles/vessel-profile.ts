import { ciiCapacity } from '@darmawanweb/ais-its-contracts/domain';
import type { VesselSnapshotV1 } from '@darmawanweb/ais-its-contracts/events';

import type { CiiRatingProfile } from '../../domain/cii.js';
import { prepareFuelFlowFormula } from '../../domain/fuel/first-formula.js';
import type { SegmentFuelProfile } from '../../domain/segment-fuel.js';
import type { HullForm } from '../../domain/holtrop/types.js';
import type { SeempVessel } from '../../domain/seemp/types.js';

/** A vessel of the FLEET projection (`vessel_profiles`). */
export interface VesselProfile {
  readonly vesselId: string;
  readonly mmsi: number;
  readonly orgId: string | null;
  readonly snapshot: VesselSnapshotV1;
  /** `snapshot.updatedAt`: the version of the snapshot. */
  readonly snapshotUpdatedAt: Date;
}

/** The profile of a snapshot. */
export function profileOfSnapshot(snapshot: VesselSnapshotV1): VesselProfile {
  return {
    vesselId: snapshot.id,
    mmsi: snapshot.mmsi,
    orgId: snapshot.orgId,
    snapshot,
    snapshotUpdatedAt: new Date(snapshot.updatedAt),
  };
}

/** Hull particulars of the Holtrop chain (legacy `sizeData`). */
export function hullFormOf(snapshot: VesselSnapshotV1): HullForm {
  const d = snapshot.dimensions;
  return {
    cb: d.cb,
    lwl: d.lwl,
    b: d.b,
    t: d.t,
    cwp: d.cwp,
    lpp: d.lpp,
    cp: d.cp,
    cm: d.cm,
    cbnsp: d.cbnsp,
    bulbousBow: d.bulbousBow,
    cstern: d.cstern,
    c1: d.c1,
    c2: d.c2,
    c3: d.c3,
    c5: d.c5,
  };
}

/**
 * Rating inputs: capacity `type.capacityFixed ?? dimensions.capacity` (spec
 * §13.5), reference line a/c and d-vector of the ship type.
 */
export function ciiRatingProfileOf(
  snapshot: VesselSnapshotV1,
): CiiRatingProfile {
  return {
    capacity: ciiCapacity(snapshot),
    referenceLine: { a: snapshot.type.a, c: snapshot.type.c },
    d: snapshot.type.d,
  };
}

/** SEEMP inputs of a vessel (legacy `IShipData` members used by the measures). */
export function seempVesselOf(snapshot: VesselSnapshotV1): SeempVessel {
  const rating = ciiRatingProfileOf(snapshot);
  return {
    ...rating,
    conversionFactor: snapshot.fuel.conversionFactor,
    loaM: snapshot.dimensions.loa,
    hull: hullFormOf(snapshot),
    mainEnginePowerKw: snapshot.mainEngine?.powerKw ?? 0,
    mainEngineQuantity: snapshot.mainEngine?.quantity ?? 0,
    auxEnginePowerKw: snapshot.auxEngines[0]?.powerKw ?? 0,
    auxEngineQuantity: snapshot.auxEngineQuantity,
    annualVoyagePercentage: snapshot.annualVoyagePercentage,
  };
}

/** Segment fuel inputs of a snapshot (formulas compiled once). */
export function segmentFuelProfileOf(
  snapshot: VesselSnapshotV1,
): SegmentFuelProfile {
  const formula = snapshot.firstFuelFormula;
  return {
    fuelCode: snapshot.fuel.code,
    conversionFactor: snapshot.fuel.conversionFactor,
    densityKgPerL: snapshot.fuel.density,
    hull: hullFormOf(snapshot),
    mainEngineSfoc: snapshot.mainEngine?.sfoc ?? null,
    firstFormula:
      formula === null
        ? null
        : {
            mainEngine: prepareFuelFlowFormula(formula.mainEngineFormula),
            auxiliaryEngine: prepareFuelFlowFormula(
              formula.auxiliaryEngineFormula,
            ),
          },
  };
}
