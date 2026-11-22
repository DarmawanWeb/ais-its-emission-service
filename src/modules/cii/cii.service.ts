import type { CiiGrade } from '@darmawanweb/ais-its-contracts/domain';
import type { Principal } from '@darmawanweb/ais-its-nest/auth';
import { Injectable } from '@nestjs/common';

import {
  CiiNotAvailableError,
  ReductionFactorMissingError,
} from '../../common/errors.js';
import { orgScopeOf } from '../../common/tenancy.js';
import {
  attainedCii,
  type CiiRatingProfile,
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
import { mergeMethodIds, METHOD_IDS } from '../methodology/method-ids.js';
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
  type YearFigures,
} from './cii-figures.js';
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

/** A vessel of the fleet summary with its figures of the year. */
export interface FleetSummaryItem {
  readonly vessel: FleetRatingRow;
  readonly figures: YearFigures | null;
}

/** Grade distribution of an organization's fleet for a year, with one page of its vessels. */
export interface FleetSummary {
  readonly year: number;
  readonly orgId: string | null;
  /** Vessels of the fleet (all pages). */
  readonly vessels: number;
  readonly grades: Record<CiiGrade, number>;
  readonly notAvailable: number;
  /** The requested page of vessels, ordered by MMSI. */
  readonly items: FleetSummaryItem[];
  readonly page: number;
  readonly pageSize: number;
}

/** Query of the fleet summary. */
export interface FleetSummaryRequest {
  readonly year: number;
  /** Organization (platform administrators only). */
  readonly orgId?: string | undefined;
  readonly page: number;
  readonly pageSize: number;
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
    principal: Principal,
  ): Promise<SegmentRow[]> {
    const profile = await this.access.accessible(mmsi, principal);
    return this.segments.page(
      profile.vesselId,
      range.from,
      range.to,
      before,
      limit,
    );
  }

  /**
   * `GET /cii/fleet/summary?year=` — grade distribution of the visible fleet
   * (all its vessels) and one page of the vessels with their figures. Only
   * the rating fields of the snapshots are loaded.
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
    const ids = vessels.map((vessel) => vessel.vesselId);
    const [totals, manual] = await Promise.all([
      this.repository.years(ids, year),
      this.manual.listByVessels(ids, year),
    ]);
    const totalsByVessel = new Map(totals.map((row) => [row.vesselId, row]));
    const manualByVessel = new Map(manual.map((row) => [row.vesselId, row]));
    const z = reductionFactorOf(factors, year);
    const grades: Record<CiiGrade, number> = { A: 0, B: 0, C: 0, D: 0, E: 0 };
    let notAvailable = 0;
    const items = vessels.map((vessel): FleetSummaryItem => {
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
      const grade = figures?.grade ?? null;
      if (grade === null) notAvailable += 1;
      else grades[grade] += 1;
      return { vessel, figures };
    });
    const offset = (request.page - 1) * request.pageSize;
    return {
      year,
      orgId: scope.kind === 'org' ? scope.orgId : (request.orgId ?? null),
      vessels: vessels.length,
      grades,
      notAvailable,
      items: items.slice(offset, offset + request.pageSize),
      page: request.page,
      pageSize: request.pageSize,
    };
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
