import type { Principal } from '@darmawanweb/ais-its-nest/auth';
import { Injectable } from '@nestjs/common';

import { CiiNotAvailableError } from '../../common/errors.js';
import { co2FromFuel } from '../../domain/cii.js';
import { type DcsSummary, UNDER_WAY_MIN_SPEED_KN } from '../../domain/dcs.js';
import { AnnualManualRepository } from '../cii/annual-manual.repository.js';
import { VesselAccessService } from '../profiles/vessel-access.service.js';
import type { VesselProfile } from '../profiles/vessel-profile.js';
import { SegmentsRepository } from '../segments/segments.repository.js';

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
    private readonly segments: SegmentsRepository,
    private readonly manual: AnnualManualRepository,
  ) {}

  async summary(mmsi: number, year: number, principal: Principal): Promise<{ profile: VesselProfile; summary: DcsSummary }> {
    const profile = await this.access.accessible(mmsi, principal);
    const { snapshot } = profile;
    const totals = await this.segments.fuelTotals(
      mmsi,
      new Date(Date.UTC(year, 0, 1)),
      new Date(Date.UTC(year + 1, 0, 1)),
      UNDER_WAY_MIN_SPEED_KN,
    );
    const base = { year, mmsi, imo: snapshot.imo, vesselName: snapshot.name };
    if (totals.length > 0) {
      return {
        profile,
        summary: {
          ...base,
          source: 'segments',
          fuel: totals.map((row) => ({
            fuelCode: row.fuelCode,
            fuelName: row.fuelCode === snapshot.fuel.code ? snapshot.fuel.name : row.fuelCode,
            conversionFactor: row.conversionFactor,
            fuelMeTon: row.fuelMeTon,
            fuelAeTon: row.fuelAeTon,
            totalTon: row.fuelMeTon + row.fuelAeTon,
            co2Ton: row.co2Ton,
          })),
          distanceNm: totals.reduce((sum, row) => sum + row.distanceNm, 0),
          hoursUnderWay: totals.reduce((sum, row) => sum + row.hoursUnderWay, 0),
          co2Ton: totals.reduce((sum, row) => sum + row.co2Ton, 0),
        },
      };
    }
    const record = await this.manual.find(mmsi, year);
    if (record === undefined) throw new CiiNotAvailableError(mmsi, year);
    const totalTon = record.fuelMeTon + record.fuelAeTon;
    const co2Ton = record.co2Ton ?? co2FromFuel(totalTon, snapshot.fuel.conversionFactor);
    return {
      profile,
      summary: {
        ...base,
        source: 'manual',
        fuel: [
          {
            fuelCode: snapshot.fuel.code,
            fuelName: snapshot.fuel.name,
            conversionFactor: snapshot.fuel.conversionFactor,
            fuelMeTon: record.fuelMeTon,
            fuelAeTon: record.fuelAeTon,
            totalTon,
            co2Ton,
          },
        ],
        distanceNm: record.distanceNm,
        hoursUnderWay: null,
        co2Ton,
      },
    };
  }
}
