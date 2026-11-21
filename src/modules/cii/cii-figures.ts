import { assignCiiGrade, type CiiGrade, ciiGradeBoundaries, type DdVector } from '@darmawanweb/ais-its-contracts/domain';

import {
  type CiiRatingProfile,
  rateCii,
  referenceCii,
  requiredCii,
} from '../../domain/cii.js';
import { type MethodCounts, mergeMethodIds, METHOD_IDS, segmentMethodIds } from '../methodology/method-ids.js';
import type { AnnualManualRecord } from './annual-manual.repository.js';
import type { PeriodTotals } from './cii.repository.js';

/** Rated CII of a vessel-year, from segments or from a manual record. */
export interface YearFigures {
  readonly year: number;
  readonly source: 'segments' | 'manual';
  readonly distanceNm: number;
  readonly fuelMeTon: number;
  readonly fuelAeTon: number;
  /** CO2, t (`null` for a manual record without it). */
  readonly co2Ton: number | null;
  /** Counted segments and their methods (`null` for manual records). */
  readonly segments: number | null;
  readonly methods: MethodCounts | null;
  readonly asOf: Date | null;
  readonly zPercent: number | null;
  readonly attained: number;
  /** Required CII; `null` for a manual record of a year without Z and without a stored value. */
  readonly required: number | null;
  readonly rating: number | null;
  readonly grade: CiiGrade | null;
  readonly boundaries: DdVector | null;
  readonly methodIds: string[];
}

/** Method counts of period totals. */
export function methodCountsOf(totals: PeriodTotals): MethodCounts {
  return {
    telemetry: totals.telemetrySegments,
    firstFormula: totals.firstFormulaSegments,
    holtrop: totals.holtropSegments,
  };
}

/** Figures of a vessel-year from the aggregated segments and the year's Z. */
export function figuresFromTotals(year: number, totals: PeriodTotals, profile: CiiRatingProfile, zPercent: number): YearFigures {
  const figures = rateCii(totals, profile, zPercent);
  const methods = methodCountsOf(totals);
  return {
    year,
    source: 'segments',
    distanceNm: totals.distanceNm,
    fuelMeTon: totals.fuelMeTon,
    fuelAeTon: totals.fuelAeTon,
    co2Ton: totals.co2Ton,
    segments: totals.segments,
    methods,
    asOf: totals.lastTime,
    zPercent,
    attained: figures.attained,
    required: figures.required,
    rating: figures.rating,
    grade: figures.grade,
    boundaries: figures.boundaries,
    methodIds: mergeMethodIds(segmentMethodIds(methods), METHOD_IDS.rating),
  };
}

/**
 * Figures of a manual / imported record: stored values win (legacy imported
 * records keep their numbers); a missing required CII is computed from Z.
 */
export function figuresFromManual(record: AnnualManualRecord, profile: CiiRatingProfile, zPercent: number | undefined): YearFigures {
  const required =
    record.required ?? (zPercent === undefined ? null : requiredCii(zPercent, referenceCii(profile.referenceLine, profile.capacity)));
  const rating = record.rating ?? (required === null ? null : record.attained / required);
  return {
    year: record.year,
    source: 'manual',
    distanceNm: record.distanceNm,
    fuelMeTon: record.fuelMeTon,
    fuelAeTon: record.fuelAeTon,
    co2Ton: record.co2Ton,
    segments: null,
    methods: null,
    asOf: null,
    zPercent: zPercent ?? null,
    attained: record.attained,
    required,
    rating,
    grade: record.grade ?? (rating === null ? null : assignCiiGrade(rating, profile.d)),
    boundaries: required === null ? null : ciiGradeBoundaries(required, profile.d),
    methodIds: mergeMethodIds(METHOD_IDS.manual, METHOD_IDS.rating),
  };
}
