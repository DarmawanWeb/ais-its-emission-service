import { CurrentPrincipal, type Principal, RequirePermissions } from '@darmawanweb/ais-its-nest/auth';
import { ApiCursorResponse, cursorPage, decodeQueryCursor, resolveQueryTimeRange } from '@darmawanweb/ais-its-nest/http';
import { Body, Controller, Get, HttpCode, HttpStatus, Param, ParseUUIDPipe, Post, Put, Query, Req } from '@nestjs/common';
import { ApiAcceptedResponse, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { FastifyRequest } from 'fastify';
import * as z from 'zod';

import { DdVectorDto } from '../../common/dto.js';
import { AnnualManualNotFoundError } from '../../common/errors.js';
import { ParseMmsiPipe, ParseYearPipe } from '../../common/pipes.js';
import { mergeMethodIds, METHOD_IDS, segmentMethodIds } from '../methodology/method-ids.js';
import { CiiService, currentYear } from './cii.service.js';
import { AnnualManualDto, PutAnnualManualDto } from './dto/annual-manual.dto.js';
import { DailyCiiQuery, FleetSummaryQuery, RecomputeQuery, SegmentsQuery, YearQuery } from './dto/cii-queries.js';
import {
  AnnualCiiDto,
  CiiSummaryDto,
  CiiYearDto,
  DailyCiiDto,
  DailyCiiPointDto,
  FleetSummaryDto,
  SegmentDto,
  SegmentPageDto,
} from './dto/cii-responses.js';
import { RecomputeJobDto } from './dto/recompute.dto.js';
import { RecomputeService } from './recompute.service.js';
import { AuditService } from '@darmawanweb/ais-its-nest/audit';

const DAY_MS = 86_400_000;
const SegmentCursorSchema = z.object({ t: z.iso.datetime() });

/**
 * CII of vessels (spec §13.5), tenant-private: the vessel's organization
 * (FLEET projection) must be the principal's, unless `super_admin`.
 */
@ApiTags('cii')
@Controller('cii')
export class CiiController {
  constructor(
    private readonly cii: CiiService,
    private readonly recompute: RecomputeService,
    private readonly audit: AuditService,
  ) {}

  @Get('vessels/:mmsi/current')
  @RequirePermissions('cii:read')
  @ApiOperation({ summary: 'Year-to-date CII of a vessel with a linear year-end projection' })
  @ApiOkResponse({ type: CiiSummaryDto })
  async current(
    @Param('mmsi', ParseMmsiPipe) mmsi: number,
    @Query() query: YearQuery,
    @CurrentPrincipal() principal: Principal,
  ): Promise<CiiSummaryDto> {
    return new CiiSummaryDto(await this.cii.current(mmsi, query.year, principal));
  }

  @Get('vessels/:mmsi/daily')
  @RequirePermissions('cii:read')
  @ApiOperation({ summary: 'Daily CII points with the cumulative (year-to-date) attained CII; default from 1 January of the year of to' })
  @ApiOkResponse({ type: DailyCiiDto })
  async daily(
    @Param('mmsi', ParseMmsiPipe) mmsi: number,
    @Query() query: DailyCiiQuery,
    @CurrentPrincipal() principal: Principal,
  ): Promise<DailyCiiDto> {
    const to = query.to === undefined ? new Date() : new Date(query.to);
    const { from } = resolveQueryTimeRange(
      { from: query.from ?? new Date(Date.UTC(to.getUTCFullYear(), 0, 1)).toISOString(), to: to.toISOString() },
      { defaultDurationMs: 366 * DAY_MS, maxDurationMs: 3 * 366 * DAY_MS },
    );
    const { profile, points } = await this.cii.daily(mmsi, from, to, principal);
    const counts = points.reduce(
      (sum, point) => ({
        telemetry: sum.telemetry + point.totals.telemetrySegments,
        firstFormula: sum.firstFormula + point.totals.firstFormulaSegments,
        holtrop: sum.holtrop + point.totals.holtropSegments,
      }),
      { telemetry: 0, firstFormula: 0, holtrop: 0 },
    );
    return new DailyCiiDto(
      profile.mmsi,
      from,
      to,
      points.map((point) => new DailyCiiPointDto(point)),
      mergeMethodIds(segmentMethodIds(counts), METHOD_IDS.rating),
    );
  }

  @Get('vessels/:mmsi/annual')
  @RequirePermissions('cii:read')
  @ApiOperation({ summary: 'Annual CII per year with the grade boundaries d_i × required' })
  @ApiOkResponse({ type: AnnualCiiDto })
  async annual(@Param('mmsi', ParseMmsiPipe) mmsi: number, @CurrentPrincipal() principal: Principal): Promise<AnnualCiiDto> {
    const { profile, years } = await this.cii.annual(mmsi, principal);
    return new AnnualCiiDto(
      profile.mmsi,
      profile.vesselId,
      new DdVectorDto(profile.snapshot.type.d),
      years.map((figures) => new CiiYearDto(figures)),
    );
  }

  @Get('vessels/:mmsi/segments')
  @RequirePermissions('cii:read')
  @ApiOperation({ summary: 'Voyage segments of a vessel, newest first (default: the last 24 h, at most 31 days)' })
  @ApiCursorResponse(SegmentDto)
  async segments(
    @Param('mmsi', ParseMmsiPipe) mmsi: number,
    @Query() query: SegmentsQuery,
    @CurrentPrincipal() principal: Principal,
  ): Promise<SegmentPageDto> {
    const range = resolveQueryTimeRange(query, { defaultDurationMs: DAY_MS, maxDurationMs: 31 * DAY_MS });
    const cursor = decodeQueryCursor(query, SegmentCursorSchema);
    const rows = await this.cii.segmentPage(mmsi, range, cursor === undefined ? undefined : new Date(cursor.t), query.limit + 1, principal);
    const page = cursorPage(rows, query.limit, (row) => ({ t: row.timeStart.toISOString() }));
    return new SegmentPageDto(
      page.data.map((row) => new SegmentDto(row)),
      page.page,
    );
  }

  @Get('fleet/summary')
  @RequirePermissions('cii:read')
  @ApiOperation({ summary: 'CII grade distribution of the fleet of the active organization (super_admin: all or ?orgId)' })
  @ApiOkResponse({ type: FleetSummaryDto })
  async fleetSummary(@Query() query: FleetSummaryQuery, @CurrentPrincipal() principal: Principal): Promise<FleetSummaryDto> {
    const summary = await this.cii.fleetSummary(query.year ?? currentYear(), principal, query.orgId);
    return new FleetSummaryDto(summary, mergeMethodIds(METHOD_IDS.rating));
  }

  @Get('vessels/:mmsi/annual-manual/:year')
  @RequirePermissions('vessel:write')
  @ApiOperation({ summary: 'Manual / imported annual CII record of a vessel-year' })
  @ApiOkResponse({ type: AnnualManualDto })
  async getManual(
    @Param('mmsi', ParseMmsiPipe) mmsi: number,
    @Param('year', ParseYearPipe) year: number,
    @CurrentPrincipal() principal: Principal,
  ): Promise<AnnualManualDto> {
    const { record } = await this.cii.getManual(mmsi, year, principal);
    if (record === undefined) throw new AnnualManualNotFoundError(mmsi, year);
    return new AnnualManualDto(record);
  }

  @Put('vessels/:mmsi/annual-manual/:year')
  @RequirePermissions('vessel:write')
  @ApiOperation({ summary: 'Create or replace the manual annual CII of a vessel-year (used when the year has no segments)' })
  @ApiOkResponse({ type: AnnualManualDto })
  async putManual(
    @Param('mmsi', ParseMmsiPipe) mmsi: number,
    @Param('year', ParseYearPipe) year: number,
    @Body() body: PutAnnualManualDto,
    @CurrentPrincipal() principal: Principal,
    @Req() request: FastifyRequest,
  ): Promise<AnnualManualDto> {
    const { profile, record } = await this.cii.putManual(
      mmsi,
      year,
      {
        attained: body.attained,
        required: body.required ?? null,
        rating: body.rating ?? null,
        grade: body.grade ?? null,
        distanceNm: body.distanceNm,
        fuelMeTon: body.fuelMeTon,
        fuelAeTon: body.fuelAeTon,
        co2Ton: body.co2Ton ?? null,
        note: body.note ?? null,
      },
      principal,
    );
    await this.audit.record(
      { action: 'cii_annual_manual.update', targetType: 'vessel', targetId: profile.vesselId, orgId: profile.orgId, meta: { mmsi, year } },
      principal,
      request,
    );
    return new AnnualManualDto(record);
  }

  @Post('vessels/:mmsi/recompute')
  @HttpCode(HttpStatus.ACCEPTED)
  @RequirePermissions('cii:read')
  @ApiOperation({ summary: 'Recompute the segments of a range by replaying AIS_POSITION (super_admin, ≤ 7 days)' })
  @ApiAcceptedResponse({ type: RecomputeJobDto })
  async startRecompute(
    @Param('mmsi', ParseMmsiPipe) mmsi: number,
    @Query() query: RecomputeQuery,
    @CurrentPrincipal() principal: Principal,
    @Req() request: FastifyRequest,
  ): Promise<RecomputeJobDto> {
    const job = await this.recompute.start(
      mmsi,
      {
        from: query.from === undefined ? undefined : new Date(query.from),
        to: query.to === undefined ? undefined : new Date(query.to),
      },
      principal,
      request,
    );
    return new RecomputeJobDto(job);
  }

  @Get('recompute-jobs/:id')
  @RequirePermissions('cii:read')
  @ApiOperation({ summary: 'Status of a recomputation (super_admin)' })
  @ApiOkResponse({ type: RecomputeJobDto })
  async recomputeJob(@Param('id', new ParseUUIDPipe()) id: string, @CurrentPrincipal() principal: Principal): Promise<RecomputeJobDto> {
    return new RecomputeJobDto(await this.recompute.get(id, principal));
  }
}
