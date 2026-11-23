import type { CiiGrade } from '@darmawanweb/ais-its-contracts/domain';
import type { Principal } from '@darmawanweb/ais-its-nest/auth';
import { Injectable } from '@nestjs/common';

import {
  AnnualManualNotFoundError,
  CiiNotAvailableError,
  ReductionFactorMissingError,
} from '../../common/errors.js';
import { orgScopeOf } from '../../common/tenancy.js';
import {
  attainedCii,
  type CiiRatingProfile,
  co2FromFuel,
  rateAttained,
  reductionFactorOf,
  referenceCii,
  requiredCii,
  type ReductionFactor,
} from '../../domain/cii.js';
import {
  elapsedYearFraction,
  projectYearEnd,
} from '../../domain/cii-projection.js';
import {
  type MethodCounts,
  mergeMethodIds,
  METHOD_IDS,
  segmentMethodIds,
} from '../methodology/method-ids.js';
import { VesselAccessService } from '../profiles/vessel-access.service.js';
import {
  ciiRatingProfileOf,
  type VesselProfile,
} from '../profiles/vessel-profile.js';
import {
  type FleetRatingRow,
  VesselProfilesRepository,
} from '../profiles/vessel-profiles.repository.js';
import {
  type SegmentFilters,
  type SegmentRow,
  SegmentsRepository,
} from '../segments/segments.repository.js';
import {
  type AnnualManualInput,
  type AnnualManualRecord,
  AnnualManualRepository,
} from './annual-manual.repository.js';
import { CiiRepository, type DayTotals } from './cii.repository.js';
import {
  figuresFromManual,
  figuresFromTotals,
  methodCountsOf,
  type YearFigures,
} from './cii-figures.js';
import type { FleetSort } from './dto/cii-queries.js';
import { filterFleetItems, sortFleetItems } from './fleet-items.js';
import { ReductionFactorsService } from './reduction-factors.service.js';

/** Year-to-date CII of a vessel with the linear year-end projection. */
export interface CiiSummary {
  readonly profile: VesselProfile;
  readonly figures: YearFigures;
  readonly capacity: number;
  readonly lastMethod: 'telemetry' | 'first_formula' | 'holtrop' | null;
  readonly projection: CiiProjection | null;
  readonly methodIds: string[];
}

/** Linear year-end projection of a year in progress. */
export interface CiiProjection {
  readonly yearFraction: number;
  readonly distanceNm: number;
  readonly fuelMeTon: number;
  readonly fuelAeTon: number;
  readonly co2Ton: number;
  /** Attained CII of the projected totals (equals the year-to-date value). */
  readonly attained: number;
  readonly rating: number;
  readonly grade: CiiGrade;
}

/** A daily point with the cumulative (year-to-date) CII at its end. */
export interface DailyCiiPoint {
  readonly totals: DayTotals;
  readonly attained: number | null;
  readonly cumulativeAttained: number | null;
  readonly required: number | null;
  readonly cumulativeRating: number | null;
  readonly cumulativeGrade: CiiGrade | null;
}

/** Rating and grade of a vessel-year (the trend of the fleet summary). */
export interface RatedYear {
  readonly source: 'segments' | 'manual';
  readonly rating: number | null;
  readonly grade: CiiGrade | null;
}

/** A vessel of the fleet summary with its figures of the year. */
export interface FleetSummaryItem {
  readonly vessel: FleetRatingRow;
  readonly figures: YearFigures | null;
  /** The previous year (`null` without CII data then). */
  readonly previousYear: RatedYear | null;
}

/** Grade distribution of an organization's fleet for a year, with one page of its vessels. */
export interface FleetSummary {
  readonly year: number;
  readonly orgId: string | null;
  /** Vessels of the fleet (all pages, no filter). */
  readonly vessels: number;
  readonly grades: Record<CiiGrade, number>;
  readonly notAvailable: number;
  /** Vessels matching the filters (all pages). */
  readonly matched: number;
  /** The requested page of the matching vessels, in the requested order. */
  readonly items: FleetSummaryItem[];
  readonly page: number;
  readonly pageSize: number;
}

/** Query of the fleet summary. */
export interface FleetSummaryRequest {
  readonly year: number;
  /** Organization (platform administrators only). */
  readonly orgId?: string | undefined;
  readonly grades?: readonly CiiGrade[] | undefined;
  readonly search?: string | undefined;
  readonly sort: FleetSort;
  readonly page: number;
  readonly pageSize: number;
}

/** Fuel and CO2 of the fleet over a period. */
export interface FleetFuelPeriod {
  readonly from: Date;
  /** Exclusive end. */
  readonly to: Date;
  readonly fuelMeTon: number;
  readonly fuelAeTon: number;
  readonly co2Ton: number;
  /** Vessels with counted segments (or, for the year, a manual record). */
  readonly vesselsWithData: number;
  /** Vessels whose figures come from their manual annual record (year only). */
  readonly manualVessels: number;
  /** Counted segments per fuel method. */
  readonly methods: MethodCounts;
}

/** Fuel totals of the visible fleet for a year and one of its months. */
export interface FleetFuel {
  readonly year: number;
  readonly month: number;
  readonly orgId: string | null;
  /** Vessels of the fleet. */
  readonly vessels: number;
  readonly yearTotals: FleetFuelPeriod;
  readonly monthTotals: FleetFuelPeriod;
  readonly methodIds: string[];
}

/** Totals of one vessel added to a {@link FleetFuelPeriod}. */
interface FuelAddend {
  readonly fuelMeTon: number;
  readonly fuelAeTon: number;
  readonly co2Ton: number;
  readonly methods: MethodCounts | null;
}

/** Sums the totals of the vessels of a period. */
function fuelPeriod(
  from: Date,
  to: Date,
  addends: readonly FuelAddend[],
): FleetFuelPeriod {
  const methods = { telemetry: 0, firstFormula: 0, holtrop: 0 };
  let fuelMeTon = 0;
  let fuelAeTon = 0;
  let co2Ton = 0;
  let manualVessels = 0;
  for (const addend of addends) {
    fuelMeTon += addend.fuelMeTon;
    fuelAeTon += addend.fuelAeTon;
    co2Ton += addend.co2Ton;
    if (addend.methods === null) manualVessels += 1;
    else {
      methods.telemetry += addend.methods.telemetry;
      methods.firstFormula += addend.methods.firstFormula;
      methods.holtrop += addend.methods.holtrop;
    }
  }
  return {
    from,
    to,
    fuelMeTon,
    fuelAeTon,
    co2Ton,
    vesselsWithData: addends.length,
    manualVessels,
    methods,
  };
}

/** The current calendar year (UTC). */
export function currentYear(now: Date = new Date()): number {
  return now.getUTCFullYear();
}

/**
 * CII use cases (spec §13.5): YTD, daily, annual, segments, fleet summary and
 * manual records, with tenancy on the vessel's organization. The rating layer
 * combines the aggregate sums with the vessel profile and `reduction_factors`;
 * a year without segments falls back to `cii_annual_manual`, and without
 * either the answer is `404 CII_NOT_AVAILABLE` (no default CII, spec §15.2).
 * The history is read by vessel id: the MMSI of a request only resolves the
 * vessel that holds it now (spec §8.5).
 */
@Injectable()
export class CiiService {
  constructor(
    private readonly access: VesselAccessService,
    private readonly profiles: VesselProfilesRepository,
    private readonly repository: CiiRepository,
    private readonly manual: AnnualManualRepository,
    private readonly segments: SegmentsRepository,
    private readonly reductionFactors: ReductionFactorsService,
  ) {}

  /** Figures of a vessel-year (segments, else manual), `undefined` without data. */
  async yearFigures(
    profile: VesselProfile,
    year: number,
    factors?: readonly ReductionFactor[],
  ): Promise<YearFigures | undefined> {
    const zTable = factors ?? (await this.reductionFactors.list());
    const rating = ciiRatingProfileOf(profile.snapshot);
    const totals = await this.repository.yearTotals(profile.vesselId, year);
    if (totals !== undefined && totals.distanceNm > 0) {
      const z = reductionFactorOf(zTable, year);
      if (z === undefined) throw new ReductionFactorMissingError(year);
      return figuresFromTotals(year, totals, rating, z);
    }
    const record = await this.manual.find(profile.vesselId, year);
    return record === undefined
      ? undefined
      : figuresFromManual(record, rating, reductionFactorOf(zTable, year));
  }

  /** Years with CII data of a vessel (segments or manual), ascending. */
  async yearsWithData(profile: VesselProfile): Promise<number[]> {
    const [totals, manual] = await Promise.all([
      this.repository.allYears(profile.vesselId),
      this.manual.listByVessel(profile.vesselId),
    ]);
    const years = new Set([
      ...totals.filter((row) => row.distanceNm > 0).map((row) => row.year),
      ...manual.map((record) => record.year),
    ]);
    return [...years].sort((a, b) => a - b);
  }

  /** `GET /cii/vessels/:mmsi/current?year=` — year-to-date CII and projection. */
  async current(
    mmsi: number,
    year: number | undefined,
    principal: Principal,
    now = new Date(),
  ): Promise<CiiSummary> {
    const profile = await this.access.accessible(mmsi, principal);
    return this.summary(profile, year ?? currentYear(now), now);
  }

  /** YTD summary of an accessible vessel (also used for publication). */
  async summary(
    profile: VesselProfile,
    year: number,
    now = new Date(),
  ): Promise<CiiSummary> {
    const figures = await this.yearFigures(profile, year);
    if (figures === undefined)
      throw new CiiNotAvailableError(profile.mmsi, year);
    const rating = ciiRatingProfileOf(profile.snapshot);
    const latest =
      figures.source === 'segments'
        ? await this.segments.latestCounted(profile.vesselId)
        : undefined;
    const projection =
      figures.source === 'segments' && year === currentYear(now)
        ? projectionOf(year, figures, rating)
        : null;
    return {
      profile,
      figures,
      capacity: rating.capacity,
      lastMethod:
        latest?.timeStart.getUTCFullYear() === year ? latest.method : null,
      projection,
      methodIds:
        projection === null
          ? figures.methodIds
          : mergeMethodIds(figures.methodIds, METHOD_IDS.projection),
    };
  }

  /** `GET /cii/vessels/:mmsi/daily?from&to` — daily points with the cumulative CII. */
  async daily(
    mmsi: number,
    from: Date,
    to: Date,
    principal: Principal,
  ): Promise<{ profile: VesselProfile; points: DailyCiiPoint[] }> {
    const profile = await this.access.accessible(mmsi, principal);
    const rating = ciiRatingProfileOf(profile.snapshot);
    const factors = await this.reductionFactors.list();
    const reference = referenceCii(rating.referenceLine, rating.capacity);
    const days = await this.repository.days(profile.vesselId, from, to);
    const points = days.map((day): DailyCiiPoint => {
      const z = reductionFactorOf(factors, day.day.getUTCFullYear());
      const required = z === undefined ? null : requiredCii(z, reference);
      const cumulativeAttained =
        day.ytdDistanceNm > 0
          ? attainedCii(day.ytdCo2Ton, day.ytdDistanceNm, rating.capacity)
          : null;
      const rated =
        cumulativeAttained === null || required === null
          ? null
          : rateAttained(cumulativeAttained, required, rating.d);
      return {
        totals: day,
        attained:
          day.distanceNm > 0
            ? attainedCii(day.co2Ton, day.distanceNm, rating.capacity)
            : null,
        cumulativeAttained,
        required,
        cumulativeRating: rated?.rating ?? null,
        cumulativeGrade: rated?.grade ?? null,
      };
    });
    return { profile, points };
  }

  /** `GET /cii/vessels/:mmsi/annual` — every year with data and the absolute boundaries; `404 CII_NOT_AVAILABLE` without any. */
  async annual(
    mmsi: number,
    principal: Principal,
  ): Promise<{ profile: VesselProfile; years: YearFigures[] }> {
    const profile = await this.access.accessible(mmsi, principal);
    const rating = ciiRatingProfileOf(profile.snapshot);
    const factors = await this.reductionFactors.list();
    const [totals, manual] = await Promise.all([
      this.repository.allYears(profile.vesselId),
      this.manual.listByVessel(profile.vesselId),
    ]);
    const years = new Map<number, YearFigures>();
    for (const record of manual) {
      years.set(
        record.year,
        figuresFromManual(
          record,
          rating,
          reductionFactorOf(factors, record.year),
        ),
      );
    }
    for (const year of totals) {
      if (year.distanceNm <= 0) continue;
      const z = reductionFactorOf(factors, year.year);
      if (z === undefined) throw new ReductionFactorMissingError(year.year);
      years.set(year.year, figuresFromTotals(year.year, year, rating, z));
    }
    if (years.size === 0) throw new CiiNotAvailableError(mmsi);
    return {
      profile,
      years: [...years.values()].sort((a, b) => a.year - b.year),
    };
  }

  /** `GET /cii/vessels/:mmsi/segments` — one page, newest first. */
  async segmentPage(
    mmsi: number,
    range: { readonly from: Date; readonly to: Date },
    before: Date | undefined,
    limit: number,
    filters: SegmentFilters,
    principal: Principal,
  ): Promise<SegmentRow[]> {
    const profile = await this.access.accessible(mmsi, principal);
    return this.segments.page(
      profile.vesselId,
      range.from,
      range.to,
      before,
      limit,
      filters,
    );
  }

  /** `GET /cii/vessels/:mmsi/segments` as CSV — the range oldest first, at most `limit` rows. */
  async segmentRange(
    mmsi: number,
    range: { readonly from: Date; readonly to: Date },
    limit: number,
    filters: SegmentFilters,
    principal: Principal,
  ): Promise<{ profile: VesselProfile; rows: SegmentRow[] }> {
    const profile = await this.access.accessible(mmsi, principal);
    const rows = await this.segments.range(
      profile.vesselId,
      range.from,
      range.to,
      limit,
      filters,
    );
    return { profile, rows };
  }

  /**
   * `GET /cii/fleet/summary` — grade distribution of the visible fleet (all
   * its vessels) and one page of the vessels matching the filters, in the
   * requested order, with their figures and the previous year's rating.
   * Only the needed fields of the snapshots are loaded.
   */
  async fleetSummary(
    request: FleetSummaryRequest,
    principal: Principal,
  ): Promise<FleetSummary> {
    const { year } = request;
    const scope = orgScopeOf(principal);
    const vessels = await this.profiles.ratingRows(
      scope,
      scope.kind === 'all' ? request.orgId : undefined,
    );
    const factors = await this.reductionFactors.list();
    const rated = await this.fleetFigures(vessels, year, factors);
    const grades: Record<CiiGrade, number> = { A: 0, B: 0, C: 0, D: 0, E: 0 };
    let notAvailable = 0;
    for (const { figures } of rated) {
      const grade = figures?.grade ?? null;
      if (grade === null) notAvailable += 1;
      else grades[grade] += 1;
    }
    const matched = sortFleetItems(
      filterFleetItems(rated, {
        grades: request.grades,
        search: request.search,
      }),
      request.sort,
    );
    const offset = (request.page - 1) * request.pageSize;
    const page = matched.slice(offset, offset + request.pageSize);
    // The trend of the page only: one more read of the aggregates.
    const previous = new Map(
      (
        await this.fleetFigures(
          page.map((item) => item.vessel),
          year - 1,
          factors,
        )
      ).map((item) => [item.vessel.vesselId, item.figures]),
    );
    return {
      year,
      orgId: scope.kind === 'org' ? scope.orgId : (request.orgId ?? null),
      vessels: vessels.length,
      grades,
      notAvailable,
      matched: matched.length,
      items: page.map((item) => {
        const before = previous.get(item.vessel.vesselId) ?? null;
        return {
          ...item,
          previousYear:
            before === null
              ? null
              : {
                  source: before.source,
                  rating: before.rating,
                  grade: before.grade,
                },
        };
      }),
      page: request.page,
      pageSize: request.pageSize,
    };
  }

  /**
   * `GET /cii/fleet/fuel` — fuel and CO2 of the visible fleet in a calendar
   * year and one of its months (UTC). Per vessel, the counted segments of
   * the period; for the year, a vessel without counted segments contributes
   * its manual annual record (CO2 from its current fuel when the record has
   * none, as the DCS summary). Manual records are annual, so the month only
   * counts segments.
   */
  async fleetFuel(
    request: {
      readonly year: number;
      readonly month: number;
      readonly orgId?: string | undefined;
    },
    principal: Principal,
  ): Promise<FleetFuel> {
    const { year, month } = request;
    const scope = orgScopeOf(principal);
    const vessels = await this.profiles.ratingRows(
      scope,
      scope.kind === 'all' ? request.orgId : undefined,
    );
    const ids = vessels.map((vessel) => vessel.vesselId);
    const yearFrom = new Date(Date.UTC(year, 0, 1));
    const yearTo = new Date(Date.UTC(year + 1, 0, 1));
    const monthFrom = new Date(Date.UTC(year, month - 1, 1));
    const monthTo = new Date(Date.UTC(year, month, 1));
    const [yearRows, manual, monthRows] = await Promise.all([
      this.repository.years(ids, year),
      this.manual.listByVessels(ids, year),
      this.repository.periodTotals(ids, monthFrom, monthTo),
    ]);
    const yearByVessel = new Map(yearRows.map((row) => [row.vesselId, row]));
    const manualByVessel = new Map(manual.map((row) => [row.vesselId, row]));
    const yearAddends = vessels.flatMap((vessel): FuelAddend[] => {
      const row = yearByVessel.get(vessel.vesselId);
      if (row !== undefined) return [{ ...row, methods: methodCountsOf(row) }];
      const record = manualByVessel.get(vessel.vesselId);
      if (record === undefined) return [];
      return [
        {
          fuelMeTon: record.fuelMeTon,
          fuelAeTon: record.fuelAeTon,
          co2Ton:
            record.co2Ton ??
            co2FromFuel(
              record.fuelMeTon + record.fuelAeTon,
              vessel.fuelConversionFactor,
            ),
          methods: null,
        },
      ];
    });
    const yearTotals = fuelPeriod(yearFrom, yearTo, yearAddends);
    const monthTotals = fuelPeriod(
      monthFrom,
      monthTo,
      monthRows.map((row) => ({ ...row, methods: methodCountsOf(row) })),
    );
    return {
      year,
      month,
      orgId: scope.kind === 'org' ? scope.orgId : (request.orgId ?? null),
      vessels: vessels.length,
      yearTotals,
      monthTotals,
      methodIds: mergeMethodIds(
        segmentMethodIds(yearTotals.methods),
        segmentMethodIds(monthTotals.methods),
        yearTotals.manualVessels > 0 ? METHOD_IDS.manual : [],
      ),
    };
  }

  /** Figures of a year of several vessels (segments, else manual; `null` without data or Z). */
  private async fleetFigures(
    vessels: readonly FleetRatingRow[],
    year: number,
    factors: readonly ReductionFactor[],
  ): Promise<{ vessel: FleetRatingRow; figures: YearFigures | null }[]> {
    const ids = vessels.map((vessel) => vessel.vesselId);
    const [totals, manual] = await Promise.all([
      this.repository.years(ids, year),
      this.manual.listByVessels(ids, year),
    ]);
    const totalsByVessel = new Map(totals.map((row) => [row.vesselId, row]));
    const manualByVessel = new Map(manual.map((row) => [row.vesselId, row]));
    const z = reductionFactorOf(factors, year);
    return vessels.map((vessel) => {
      const rating = ciiRatingProfileOf({
        type: vessel.type,
        dimensions: { capacity: vessel.capacity },
      });
      const row = totalsByVessel.get(vessel.vesselId);
      const record = manualByVessel.get(vessel.vesselId);
      const figures =
        row !== undefined && row.distanceNm > 0 && z !== undefined
          ? figuresFromTotals(year, row, rating, z)
          : record === undefined
            ? null
            : figuresFromManual(record, rating, z);
      return { vessel, figures };
    });
  }

  /** `GET /cii/vessels/:mmsi/annual-manual/:year`. */
  async getManual(
    mmsi: number,
    year: number,
    principal: Principal,
  ): Promise<{
    profile: VesselProfile;
    record: AnnualManualRecord | undefined;
  }> {
    const profile = await this.access.accessible(mmsi, principal);
    return { profile, record: await this.manual.find(profile.vesselId, year) };
  }

  /** `PUT /cii/vessels/:mmsi/annual-manual/:year`. */
  async putManual(
    mmsi: number,
    year: number,
    input: Omit<AnnualManualInput, 'updatedBy'>,
    principal: Principal,
  ): Promise<{ profile: VesselProfile; record: AnnualManualRecord }> {
    const profile = await this.access.accessible(mmsi, principal);
    const record = await this.manual.upsert(profile, year, {
      ...input,
      updatedBy: principal.kind === 'user' ? principal.id : null,
    });
    return { profile, record };
  }

  /** `DELETE /cii/vessels/:mmsi/annual-manual/:year`; `404 CII_ANNUAL_MANUAL_NOT_FOUND` without a record. */
  async deleteManual(
    mmsi: number,
    year: number,
    principal: Principal,
  ): Promise<{ profile: VesselProfile; record: AnnualManualRecord }> {
    const profile = await this.access.accessible(mmsi, principal);
    const record = await this.manual.delete(profile.vesselId, year);
    if (record === undefined) throw new AnnualManualNotFoundError(mmsi, year);
    return { profile, record };
  }
}

/**
 * Linear year-end projection of a year in progress (`null` without a
 * required CII): projected totals, and the attained CII, rating and grade of
 * those totals — equal to the year-to-date values under the linear model.
 *
 * @method cii.year_end_projection
 */
function projectionOf(
  year: number,
  figures: YearFigures,
  rating: CiiRatingProfile,
): CiiProjection | null {
  if (
    figures.asOf === null ||
    figures.required === null ||
    figures.co2Ton === null
  )
    return null;
  const fraction = elapsedYearFraction(year, figures.asOf);
  const projection = projectYearEnd(
    {
      distanceNm: figures.distanceNm,
      fuelMeTon: figures.fuelMeTon,
      fuelAeTon: figures.fuelAeTon,
      co2Ton: figures.co2Ton,
    },
    fraction,
    rating.capacity,
  );
  const rated = rateAttained(projection.attained, figures.required, rating.d);
  return {
    yearFraction: fraction,
    ...projection.totals,
    attained: projection.attained,
    rating: rated.rating,
    grade: rated.grade,
  };
}
