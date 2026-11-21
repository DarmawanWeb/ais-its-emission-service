import type { CiiGrade } from '@darmawanweb/ais-its-contracts/domain';
import type { Principal } from '@darmawanweb/ais-its-nest/auth';
import { Injectable } from '@nestjs/common';

import { CiiNotAvailableError, ReductionFactorMissingError } from '../../common/errors.js';
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
import { elapsedYearFraction, projectCumulativeAttained, projectTotals } from '../../domain/cii-projection.js';
import { mergeMethodIds, METHOD_IDS, segmentMethodIds } from '../methodology/method-ids.js';
import { VesselAccessService } from '../profiles/vessel-access.service.js';
import { ciiRatingProfileOf, type VesselProfile } from '../profiles/vessel-profile.js';
import { VesselProfilesRepository } from '../profiles/vessel-profiles.repository.js';
import { type SegmentRow, SegmentsRepository } from '../segments/segments.repository.js';
import { type AnnualManualInput, type AnnualManualRecord, AnnualManualRepository } from './annual-manual.repository.js';
import { CiiRepository, type DayTotals } from './cii.repository.js';
import { figuresFromManual, figuresFromTotals, type YearFigures } from './cii-figures.js';
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
  /** Year-end attained CII of the trend of the daily cumulative values. */
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

/** Grade distribution of an organization's fleet for a year. */
export interface FleetSummary {
  readonly year: number;
  readonly orgId: string | null;
  readonly grades: Record<CiiGrade, number>;
  readonly notAvailable: number;
  readonly items: { readonly profile: VesselProfile; readonly figures: YearFigures | null }[];
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
  async yearFigures(profile: VesselProfile, year: number, factors?: readonly ReductionFactor[]): Promise<YearFigures | undefined> {
    const zTable = factors ?? (await this.reductionFactors.list());
    const rating = ciiRatingProfileOf(profile.snapshot);
    const totals = await this.repository.yearTotals(profile.mmsi, year);
    if (totals !== undefined && totals.distanceNm > 0) {
      const z = reductionFactorOf(zTable, year);
      if (z === undefined) throw new ReductionFactorMissingError(year);
      return figuresFromTotals(year, totals, rating, z);
    }
    const record = await this.manual.find(profile.mmsi, year);
    return record === undefined ? undefined : figuresFromManual(record, rating, reductionFactorOf(zTable, year));
  }

  /** Years with CII data of a vessel (segments or manual), ascending. */
  async yearsWithData(profile: VesselProfile): Promise<number[]> {
    const [totals, manual] = await Promise.all([this.repository.allYears(profile.mmsi), this.manual.listByMmsi(profile.mmsi)]);
    const years = new Set([
      ...totals.filter((row) => row.distanceNm > 0).map((row) => row.year),
      ...manual.map((record) => record.year),
    ]);
    return [...years].sort((a, b) => a - b);
  }

  /** `GET /cii/vessels/:mmsi/current?year=` — year-to-date CII and projection. */
  async current(mmsi: number, year: number | undefined, principal: Principal, now = new Date()): Promise<CiiSummary> {
    const profile = await this.access.accessible(mmsi, principal);
    return this.summary(profile, year ?? currentYear(now), now);
  }

  /** YTD summary of an accessible vessel (also used for publication). */
  async summary(profile: VesselProfile, year: number, now = new Date()): Promise<CiiSummary> {
    const figures = await this.yearFigures(profile, year);
    if (figures === undefined) throw new CiiNotAvailableError(profile.mmsi, year);
    const rating = ciiRatingProfileOf(profile.snapshot);
    const latest = figures.source === 'segments' ? await this.segments.latestCounted(profile.mmsi) : undefined;
    const projection =
      figures.source === 'segments' && year === currentYear(now) && figures.asOf !== null && figures.required !== null
        ? await this.projection(profile, year, figures, rating)
        : null;
    return {
      profile,
      figures,
      capacity: rating.capacity,
      lastMethod: latest !== undefined && latest.timeStart.getUTCFullYear() === year ? latest.method : null,
      projection,
      methodIds: projection === null ? figures.methodIds : mergeMethodIds(figures.methodIds, METHOD_IDS.projection),
    };
  }

  private async projection(
    profile: VesselProfile,
    year: number,
    figures: YearFigures,
    rating: CiiRatingProfile,
  ): Promise<CiiProjection | null> {
    if (figures.asOf === null || figures.required === null || figures.co2Ton === null) return null;
    const fraction = elapsedYearFraction(year, figures.asOf);
    const totals = projectTotals(
      { distanceNm: figures.distanceNm, fuelMeTon: figures.fuelMeTon, fuelAeTon: figures.fuelAeTon, co2Ton: figures.co2Ton },
      fraction,
    );
    const days = await this.repository.days(profile.mmsi, new Date(Date.UTC(year, 0, 1)), new Date(Date.UTC(year + 1, 0, 1)));
    const attained =
      projectCumulativeAttained(
        days
          .filter((day) => day.ytdDistanceNm > 0)
          .map((day) => ({ day: day.day, cumulativeAttained: attainedCii(day.ytdCo2Ton, day.ytdDistanceNm, rating.capacity) })),
        year,
      ) ?? figures.attained;
    const rated = rateAttained(attained, figures.required, rating.d);
    return { yearFraction: fraction, ...totals, attained, rating: rated.rating, grade: rated.grade };
  }

  /** `GET /cii/vessels/:mmsi/daily?from&to` — daily points with the cumulative CII. */
  async daily(mmsi: number, from: Date, to: Date, principal: Principal): Promise<{ profile: VesselProfile; points: DailyCiiPoint[] }> {
    const profile = await this.access.accessible(mmsi, principal);
    const rating = ciiRatingProfileOf(profile.snapshot);
    const factors = await this.reductionFactors.list();
    const reference = referenceCii(rating.referenceLine, rating.capacity);
    const days = await this.repository.days(mmsi, from, to);
    const points = days.map((day): DailyCiiPoint => {
      const z = reductionFactorOf(factors, day.day.getUTCFullYear());
      const required = z === undefined ? null : requiredCii(z, reference);
      const cumulativeAttained = day.ytdDistanceNm > 0 ? attainedCii(day.ytdCo2Ton, day.ytdDistanceNm, rating.capacity) : null;
      const rated = cumulativeAttained === null || required === null ? null : rateAttained(cumulativeAttained, required, rating.d);
      return {
        totals: day,
        attained: day.distanceNm > 0 ? attainedCii(day.co2Ton, day.distanceNm, rating.capacity) : null,
        cumulativeAttained,
        required,
        cumulativeRating: rated?.rating ?? null,
        cumulativeGrade: rated?.grade ?? null,
      };
    });
    return { profile, points };
  }

  /** `GET /cii/vessels/:mmsi/annual` — every year with data and the absolute boundaries. */
  async annual(mmsi: number, principal: Principal): Promise<{ profile: VesselProfile; years: YearFigures[] }> {
    const profile = await this.access.accessible(mmsi, principal);
    const rating = ciiRatingProfileOf(profile.snapshot);
    const factors = await this.reductionFactors.list();
    const [totals, manual] = await Promise.all([this.repository.allYears(mmsi), this.manual.listByMmsi(mmsi)]);
    const years = new Map<number, YearFigures>();
    for (const record of manual) {
      years.set(record.year, figuresFromManual(record, rating, reductionFactorOf(factors, record.year)));
    }
    for (const year of totals) {
      if (year.distanceNm <= 0) continue;
      const z = reductionFactorOf(factors, year.year);
      if (z === undefined) throw new ReductionFactorMissingError(year.year);
      years.set(year.year, figuresFromTotals(year.year, year, rating, z));
    }
    return { profile, years: [...years.values()].sort((a, b) => a.year - b.year) };
  }

  /** `GET /cii/vessels/:mmsi/segments` — one page, newest first. */
  async segmentPage(
    mmsi: number,
    range: { readonly from: Date; readonly to: Date },
    before: Date | undefined,
    limit: number,
    principal: Principal,
  ): Promise<SegmentRow[]> {
    await this.access.accessible(mmsi, principal);
    return this.segments.page(mmsi, range.from, range.to, before, limit);
  }

  /** `GET /cii/fleet/summary?year=` — grade distribution of the visible fleet. */
  async fleetSummary(year: number, principal: Principal, orgId?: string): Promise<FleetSummary> {
    const scope = orgScopeOf(principal);
    const profiles = await this.profiles.list(scope, scope.kind === 'all' ? orgId : undefined);
    const factors = await this.reductionFactors.list();
    const mmsis = profiles.map((profile) => profile.mmsi);
    const [totals, manual] = await Promise.all([this.repository.years(mmsis, year), this.manual.listByMmsis(mmsis, year)]);
    const totalsByMmsi = new Map(totals.map((row) => [row.mmsi, row]));
    const manualByMmsi = new Map(manual.map((row) => [row.mmsi, row]));
    const z = reductionFactorOf(factors, year);
    const grades: Record<CiiGrade, number> = { A: 0, B: 0, C: 0, D: 0, E: 0 };
    let notAvailable = 0;
    const items = profiles.map((profile) => {
      const rating = ciiRatingProfileOf(profile.snapshot);
      const row = totalsByMmsi.get(profile.mmsi);
      const record = manualByMmsi.get(profile.mmsi);
      const figures =
        row !== undefined && row.distanceNm > 0 && z !== undefined
          ? figuresFromTotals(year, row, rating, z)
          : record === undefined
            ? null
            : figuresFromManual(record, rating, z);
      if (figures?.grade == null) notAvailable += 1;
      else grades[figures.grade] += 1;
      return { profile, figures };
    });
    return { year, orgId: scope.kind === 'org' ? scope.orgId : (orgId ?? null), grades, notAvailable, items };
  }

  /** `GET /cii/vessels/:mmsi/annual-manual/:year`. */
  async getManual(mmsi: number, year: number, principal: Principal): Promise<{ profile: VesselProfile; record: AnnualManualRecord | undefined }> {
    const profile = await this.access.accessible(mmsi, principal);
    return { profile, record: await this.manual.find(mmsi, year) };
  }

  /** `PUT /cii/vessels/:mmsi/annual-manual/:year`. */
  async putManual(
    mmsi: number,
    year: number,
    input: Omit<AnnualManualInput, 'updatedBy'>,
    principal: Principal,
  ): Promise<{ profile: VesselProfile; record: AnnualManualRecord }> {
    const profile = await this.access.accessible(mmsi, principal);
    const record = await this.manual.upsert(mmsi, year, { ...input, updatedBy: principal.kind === 'user' ? principal.id : null });
    return { profile, record };
  }
}
