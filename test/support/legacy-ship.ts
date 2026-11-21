import {
  type VesselSnapshotV1,
  VesselSnapshotV1Schema,
} from '@darmawanweb/ais-its-contracts/events';
import * as z from 'zod';

/**
 * A populated legacy ship document (`IShipData`, be-legacy
 * `src/types/ship.type.ts`) as recorded by the golden harness
 * (`test/fixtures/golden/holtrop.json` → `ships`).
 */
export const LegacyShipSchema = z.object({
  mmsi: z.string(),
  generalData: z.object({
    name: z.string(),
    flag: z.string(),
    imoNumber: z.string(),
    annualVoyagePercentage: z.number(),
    shipStatus: z.string(),
  }),
  sizeData: z.object({
    capacity: z.number(),
    cb: z.number(),
    lwl: z.number(),
    b: z.number(),
    t: z.number(),
    cwp: z.number(),
    loa: z.number(),
    lpp: z.number(),
    cp: z.number(),
    cm: z.number(),
    cbnsp: z.number(),
    bulbosbow: z.boolean(),
    cstern: z.number(),
    c1: z.number(),
    c2: z.number(),
    c3: z.number(),
    c5: z.number(),
    vs: z.number(),
  }),
  typeData: z.object({
    name: z.string(),
    capacityUnit: z.enum(['DWT', 'GT']),
    a: z.number(),
    c: z.number(),
    d: z.object({
      d1: z.number(),
      d2: z.number(),
      d3: z.number(),
      d4: z.number(),
    }),
  }),
  fuelType: z.object({
    fuelType: z.string(),
    carbonContent: z.number(),
    conversionFactor: z.number(),
    fuelDensity: z.number(),
  }),
  engineSpecs: z.object({
    mainEngine: z.object({
      engine: z.object({
        engineName: z.string(),
        rpm: z.number(),
        power: z.number(),
        specificFuelOilConsumption: z.number(),
      }),
      quantity: z.number(),
    }),
    auxiliaryEngine: z.object({
      engine: z.array(
        z.object({
          generatorType: z.string(),
          rpm: z.number(),
          power: z.number(),
          specificFuelOilConsumption: z.number(),
        }),
      ),
      quantity: z.number(),
    }),
  }),
  fuelFormulas: z.object({
    firstFuelFormula: z
      .object({
        mainEngineFormula: z.string(),
        auxiliaryEngineFormula: z.string(),
      })
      .optional(),
  }),
});

export type LegacyShip = z.output<typeof LegacyShipSchema>;

/** A deterministic UUID (v7 layout) for test entity `n`. */
export function testUuid(n: number): string {
  return `0190d5c0-0000-7000-8000-${n.toString(16).padStart(12, '0')}`;
}

/** Overrides of {@link snapshotOfLegacyShip}. */
export interface SnapshotOverrides {
  readonly id?: string;
  readonly orgId?: string | null;
  readonly mmsi?: number;
  readonly updatedAt?: string;
  /** `false` removes the first fuel formula (Holtrop path). */
  readonly firstFuelFormula?: boolean;
  readonly capacityFixed?: number | null;
}

/**
 * The fleet `VesselSnapshotV1` of a legacy ship document, field by field as
 * the MVP→v2 migrator maps it (`sizeData` → `dimensions`, `bulbosbow` →
 * `bulbousBow`, `fuelDensity` → `density`, engine `power` → `powerKw`,
 * `specificFuelOilConsumption` → `sfoc`); validated with the contracts schema.
 */
export function snapshotOfLegacyShip(
  ship: LegacyShip,
  index: number,
  overrides: SnapshotOverrides = {},
): VesselSnapshotV1 {
  const size = ship.sizeData;
  const formula = ship.fuelFormulas.firstFuelFormula;
  const withFormula = overrides.firstFuelFormula ?? formula !== undefined;
  return VesselSnapshotV1Schema.parse({
    id: overrides.id ?? testUuid(index * 100 + 1),
    orgId: overrides.orgId === undefined ? testUuid(9000) : overrides.orgId,
    mmsi: overrides.mmsi ?? Number(ship.mmsi),
    imo: ship.generalData.imoNumber,
    name: ship.generalData.name,
    flag: ship.generalData.flag,
    builtYear: 1990,
    status: 'active',
    annualVoyagePercentage: ship.generalData.annualVoyagePercentage,
    dimensions: {
      capacity: size.capacity,
      dwt: null,
      gt: null,
      cb: size.cb,
      lwl: size.lwl,
      b: size.b,
      t: size.t,
      cwp: size.cwp,
      loa: size.loa,
      lpp: size.lpp,
      cp: size.cp,
      cm: size.cm,
      cbnsp: size.cbnsp,
      bulbousBow: size.bulbosbow,
      cstern: size.cstern,
      c1: size.c1,
      c2: size.c2,
      c3: size.c3,
      c5: size.c5,
      vs: size.vs,
    },
    type: {
      id: testUuid(index * 100 + 2),
      code: ship.typeData.name.toLowerCase().replaceAll(/[^a-z0-9]+/g, '_'),
      name: ship.typeData.name,
      capacityUnit: ship.typeData.capacityUnit,
      a: ship.typeData.a,
      c: ship.typeData.c,
      capacityFixed: overrides.capacityFixed ?? null,
      d: ship.typeData.d,
    },
    fuel: {
      id: testUuid(index * 100 + 3),
      code: ship.fuelType.fuelType.toLowerCase().replaceAll(/[^a-z0-9]+/g, '_'),
      name: ship.fuelType.fuelType,
      carbonContent: ship.fuelType.carbonContent,
      conversionFactor: ship.fuelType.conversionFactor,
      density: ship.fuelType.fuelDensity,
    },
    mainEngine: {
      id: testUuid(index * 100 + 4),
      name: ship.engineSpecs.mainEngine.engine.engineName,
      rpm: ship.engineSpecs.mainEngine.engine.rpm,
      powerKw: ship.engineSpecs.mainEngine.engine.power,
      sfoc: ship.engineSpecs.mainEngine.engine.specificFuelOilConsumption,
      quantity: ship.engineSpecs.mainEngine.quantity,
    },
    auxEngines: ship.engineSpecs.auxiliaryEngine.engine.map(
      (engine, position) => ({
        id: testUuid(index * 100 + 10 + position),
        name: engine.generatorType,
        rpm: engine.rpm,
        powerKw: engine.power,
        sfoc: engine.specificFuelOilConsumption,
      }),
    ),
    auxEngineQuantity: ship.engineSpecs.auxiliaryEngine.quantity,
    firstFuelFormula:
      withFormula && formula !== undefined
        ? {
            id: testUuid(index * 100 + 5),
            mainEngineFormula: formula.mainEngineFormula,
            auxiliaryEngineFormula: formula.auxiliaryEngineFormula,
          }
        : null,
    portIds: [],
    updatedAt: overrides.updatedAt ?? '2026-01-01T00:00:00.000Z',
  });
}
