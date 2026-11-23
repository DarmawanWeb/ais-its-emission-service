import {
  CII_GRADES,
  type CiiGrade,
} from '@darmawanweb/ais-its-contracts/domain';
import {
  CursorQueryDto,
  PageQueryDto,
  TimeRangeQueryDto,
} from '@darmawanweb/ais-its-nest/http';
import { ApiPropertyOptional, IntersectionType } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Max,
  Min,
} from 'class-validator';

import {
  commaList,
  signedSortKeys,
  trimString,
  upperCommaList,
} from '../../../common/query.js';
import { SEGMENT_METHODS, type SegmentMethod } from '../../../db/schema.js';
import {
  SEGMENT_FLAGS,
  type SegmentFlag,
} from '../../../domain/segment-fuel.js';

/** `?year=` (default: the current UTC year). */
export class YearQuery {
  @ApiPropertyOptional({
    minimum: 2000,
    maximum: 2200,
    example: 2026,
    description: 'Calendar year (UTC); default the current year',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(2000)
  @Max(2200)
  readonly year?: number;
}

/** `?orgId=` of the fleet-wide reads (platform administrators only). */
export class OrgQuery {
  @ApiPropertyOptional({
    format: 'uuid',
    description:
      'Organization (super_admin only; others always see their active organization)',
  })
  @IsOptional()
  @IsUUID()
  readonly orgId?: string;
}

/** Sort keys of the fleet summary items. */
export const FLEET_SORT_KEYS = [
  'mmsi',
  'name',
  'grade',
  'rating',
  'attained',
] as const;
/** A fleet sort key; a leading `-` sorts descending. */
export type FleetSort =
  (typeof FLEET_SORT_KEYS)[number] | `-${(typeof FLEET_SORT_KEYS)[number]}`;
const FLEET_SORTS = signedSortKeys(FLEET_SORT_KEYS);

/**
 * `GET /cii/fleet/summary?year&orgId&grade&search&sort&page&pageSize`: the
 * filters and the page apply to `items`; the grade distribution and
 * `vessels` always cover the whole fleet.
 */
export class FleetSummaryQuery extends IntersectionType(
  YearQuery,
  OrgQuery,
  PageQueryDto,
) {
  @ApiPropertyOptional({
    type: String,
    example: 'D,E',
    description:
      'Only items with one of these grades of the year (comma-separated A–E); vessels without CII data never match',
  })
  @IsOptional()
  @Transform(upperCommaList)
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(CII_GRADES.length)
  @IsIn(CII_GRADES, { each: true })
  readonly grade?: CiiGrade[];

  @ApiPropertyOptional({
    maxLength: 120,
    description:
      'Name (case-insensitive substring), MMSI or IMO number (prefix of digits)',
  })
  @IsOptional()
  @Transform(trimString)
  @IsString()
  @Length(1, 120)
  readonly search?: string;

  @ApiPropertyOptional({
    enum: FLEET_SORTS,
    default: 'mmsi',
    description:
      'Order of `items`; a leading `-` sorts descending. grade A→E, rating and attained ascending = best first; vessels without CII data come last in both directions; ties by MMSI',
  })
  @IsOptional()
  @IsIn(FLEET_SORTS)
  readonly sort: FleetSort = 'mmsi';
}

/** `GET /cii/fleet/fuel?year&month&orgId`. */
export class FleetFuelQuery extends IntersectionType(YearQuery, OrgQuery) {
  @ApiPropertyOptional({
    minimum: 1,
    maximum: 12,
    example: 11,
    description:
      'Month of `year` (1–12) for the monthly totals; default the current UTC month',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(12)
  readonly month?: number;
}

/** `GET /emission/fleet/dcs?year&orgId`. */
export class FleetDcsQuery extends IntersectionType(YearQuery, OrgQuery) {}

/** `GET /cii/vessels/:mmsi/daily?from&to` (default: from 1 January of the year of `to`). */
export class DailyCiiQuery extends TimeRangeQueryDto {}

/** `GET /cii/vessels/:mmsi/segments?from&to&method&flag&cursor&limit` (default: the last 24 h). */
export class SegmentsQuery extends IntersectionType(
  CursorQueryDto,
  TimeRangeQueryDto,
) {
  @ApiPropertyOptional({
    type: String,
    example: 'first_formula,holtrop',
    description: `Only segments of these fuel methods (comma-separated: ${SEGMENT_METHODS.join(', ')})`,
  })
  @IsOptional()
  @Transform(commaList)
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(SEGMENT_METHODS.length)
  @IsIn(SEGMENT_METHODS, { each: true })
  readonly method?: SegmentMethod[];

  @ApiPropertyOptional({
    enum: SEGMENT_FLAGS,
    description: 'Only segments carrying this flag',
  })
  @IsOptional()
  @IsIn(SEGMENT_FLAGS)
  readonly flag?: SegmentFlag;
}

/** `POST /cii/vessels/:mmsi/recompute?from&to` (default: the 24 h before `to`). */
export class RecomputeQuery extends TimeRangeQueryDto {}

/** Statuses of a recomputation job. */
export const RECOMPUTE_JOB_STATUSES = [
  'running',
  'succeeded',
  'failed',
] as const;

/** `GET /cii/recompute-jobs?mmsi&status&cursor&limit` (newest first). */
export class RecomputeJobsQuery extends CursorQueryDto {
  @ApiPropertyOptional({ example: 525005223 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(100_000_000)
  @Max(999_999_999)
  readonly mmsi?: number;

  @ApiPropertyOptional({ enum: RECOMPUTE_JOB_STATUSES })
  @IsOptional()
  @IsIn(RECOMPUTE_JOB_STATUSES)
  readonly status?: (typeof RECOMPUTE_JOB_STATUSES)[number];
}
