import type { Principal } from '@darmawanweb/ais-its-nest/auth';
import { Injectable } from '@nestjs/common';

import { CiiNotAvailableError } from '../../common/errors.js';
import { orgScopeOf } from '../../common/tenancy.js';
import { co2FromFuel } from '../../domain/cii.js';
import { type DcsSummary, UNDER_WAY_MIN_SPEED_KN } from '../../domain/dcs.js';
import {
  type AnnualManualRecord,
  AnnualManualRepository,
} from '../cii/annual-manual.repository.js';
import { VesselAccessService } from '../profiles/vessel-access.service.js';
import type { VesselProfile } from '../profiles/vessel-profile.js';
import {
  type FleetRatingRow,
  VesselProfilesRepository,
} from '../profiles/vessel-profiles.repository.js';
import {
  type FuelTotalsRow,
  SegmentsRepository,
} from '../segments/segments.repository.js';

/** The vessel fields a DCS summary shows. */
interface DcsVessel {
  readonly mmsi: number;
  readonly imo: string | null;
  readonly name: string;
  /** The vessel's current fuel (manual records carry no fuel type). */
  readonly fuel: {
    readonly code: string;
    readonly name: string;
    readonly conversionFactor: number;
  };
}

/** A vessel of the fleet-wide DCS export with its summary, if it has data. */
export interface FleetDcsItem {
  readonly vessel: FleetRatingRow;
  readonly summary: DcsSummary | undefined;
}

/** The fleet-wide DCS export of a year. */
export interface FleetDcs {
  readonly year: number;
  readonly orgId: string | null;
  readonly items: readonly FleetDcsItem[];
}

/**
 * The DCS summary of a vessel-year: the counted segments per fuel when the
 * year has any, else the manual record (fuel of the vessel's current fuel
 * type, CO2 from it when the record has none, hours unknown), else
 * `undefined`.
 *
 * @method emission.dcs_summary
 */
export function dcsSummaryOf(
  vessel: DcsVessel,
  year: number,
  totals: readonly FuelTotalsRow[],
  record: AnnualManualRecord | undefined,
): DcsSummary | undefined {
  const base = {
    year,
    mmsi: vessel.mmsi,
    imo: vessel.imo,
    vesselName: vessel.name,
  };
  if (totals.length > 0) {
    return {
      ...base,
      source: 'segments',
      fuel: totals.map((row) => ({
        fuelCode: row.fuelCode,
        fuelName:
          row.fuelCode === vessel.fuel.code ? vessel.fuel.name : row.fuelCode,
        conversionFactor: row.conversionFactor,
        fuelMeTon: row.fuelMeTon,
        fuelAeTon: row.fuelAeTon,
        totalTon: row.fuelMeTon + row.fuelAeTon,
        co2Ton: row.co2Ton,
      })),
      distanceNm: totals.reduce((sum, row) => sum + row.distanceNm, 0),
      hoursUnderWay: totals.reduce((sum, row) => sum + row.hoursUnderWay, 0),
      co2Ton: totals.reduce((sum, row) => sum + row.co2Ton, 0),
    };
  }
  if (record === undefined) return undefined;
  const totalTon = record.fuelMeTon + record.fuelAeTon;
  const co2Ton =
    record.co2Ton ?? co2FromFuel(totalTon, vessel.fuel.conversionFactor);
  return {
    ...base,
    source: 'manual',
    fuel: [
      {
        fuelCode: vessel.fuel.code,
        fuelName: vessel.fuel.name,
        conversionFactor: vessel.fuel.conversionFactor,
        fuelMeTon: record.fuelMeTon,
        fuelAeTon: record.fuelAeTon,
        totalTon,
        co2Ton,
      },
    ],
    distanceNm: record.distanceNm,
    hoursUnderWay: null,
    co2Ton,
  };
}

/**
 * IMO DCS-style annual summary (spec §13.5): fuel per fuel type (ME/AE),
 * distance, hours under way and CO2 from the counted segments of the
 * calendar year; a year without segments falls back to the manual record
 * (fuel of the vessel's current fuel type, hours unknown).
 *
 * @method emission.dcs_summary
 */
@Injectable()
export class DcsService {
  constructor(
    private readonly access: VesselAccessService,
    private readonly profiles: VesselProfilesRepository,
    private readonly segments: SegmentsRepository,
    private readonly manual: AnnualManualRepository,
  ) {}

  async summary(
    mmsi: number,
    year: number,
    principal: Principal,
  ): Promise<{ profile: VesselProfile; summary: DcsSummary }> {
    const profile = await this.access.accessible(mmsi, principal);
    const { snapshot } = profile;
    const { from, to } = yearRange(year);
    const totals = await this.segments.fuelTotals(
      profile.vesselId,
      from,
      to,
      UNDER_WAY_MIN_SPEED_KN,
    );
    const record =
      totals.length > 0
        ? undefined
        : await this.manual.find(profile.vesselId, year);
    const summary = dcsSummaryOf(
      { mmsi, imo: snapshot.imo, name: snapshot.name, fuel: snapshot.fuel },
      year,
      totals,
      record,
    );
    if (summary === undefined) throw new CiiNotAvailableError(mmsi, year);
    return { profile, summary };
  }

  /**
   * The DCS summaries of every vessel of the visible fleet for a year (an
   * organization's annual submission; super_admin: all or `orgId`), by
   * MMSI; vessels without data have no summary.
   */
  async fleet(
    year: number,
    orgId: string | undefined,
    principal: Principal,
  ): Promise<FleetDcs> {
    const scope = orgScopeOf(principal);
    const vessels = await this.profiles.ratingRows(
      scope,
      scope.kind === 'all' ? orgId : undefined,
    );
    const ids = vessels.map((vessel) => vessel.vesselId);
    const { from, to } = yearRange(year);
    const [totals, manual] = await Promise.all([
      this.segments.fleetFuelTotals(ids, from, to, UNDER_WAY_MIN_SPEED_KN),
      this.manual.listByVessels(ids, year),
    ]);
    const totalsByVessel = new Map<string, FuelTotalsRow[]>();
    for (const row of totals) {
      const rows = totalsByVessel.get(row.vesselId);
      if (rows === undefined) totalsByVessel.set(row.vesselId, [row]);
      else rows.push(row);
    }
    const manualByVessel = new Map(manual.map((row) => [row.vesselId, row]));
    return {
      year,
      orgId: scope.kind === 'org' ? scope.orgId : (orgId ?? null),
      items: vessels.map((vessel) => ({
        vessel,
        summary: dcsSummaryOf(
          {
            mmsi: vessel.mmsi,
            imo: vessel.imo,
            name: vessel.name,
            fuel: {
              code: vessel.fuelCode,
              name: vessel.fuelName,
              conversionFactor: vessel.fuelConversionFactor,
            },
          },
          year,
          totalsByVessel.get(vessel.vesselId) ?? [],
          manualByVessel.get(vessel.vesselId),
        ),
      })),
    };
  }
}

/** `[1 January year, 1 January year + 1)`, UTC. */
function yearRange(year: number): { from: Date; to: Date } {
  return {
    from: new Date(Date.UTC(year, 0, 1)),
    to: new Date(Date.UTC(year + 1, 0, 1)),
  };
}
