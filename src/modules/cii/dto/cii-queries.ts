import { CursorQueryDto, TimeRangeQueryDto } from '@darmawanweb/ais-its-nest/http';
import { ApiPropertyOptional, IntersectionType } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsUUID, Max, Min } from 'class-validator';

/** `?year=` (default: the current UTC year). */
export class YearQuery {
  @ApiPropertyOptional({ minimum: 2000, maximum: 2200, example: 2026, description: 'Calendar year (UTC); default the current year' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(2000)
  @Max(2200)
  readonly year?: number;
}

/** `GET /cii/fleet/summary?year=&orgId=`. */
export class FleetSummaryQuery extends YearQuery {
  @ApiPropertyOptional({ format: 'uuid', description: 'Organization (super_admin only; others always see their active organization)' })
  @IsOptional()
  @IsUUID()
  readonly orgId?: string;
}

/** `GET /cii/vessels/:mmsi/daily?from&to` (default: from 1 January of the year of `to`). */
export class DailyCiiQuery extends TimeRangeQueryDto {}

/** `GET /cii/vessels/:mmsi/segments?from&to&cursor&limit` (default: the last 24 h). */
export class SegmentsQuery extends IntersectionType(CursorQueryDto, TimeRangeQueryDto) {}

/** `POST /cii/vessels/:mmsi/recompute?from&to` (default: the 24 h before `to`). */
export class RecomputeQuery extends TimeRangeQueryDto {}
