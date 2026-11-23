import { AuditService } from '@darmawanweb/ais-its-nest/audit';
import {
  CurrentPrincipal,
  type Principal,
  RequirePermissions,
  RequirePlatformAdmin,
} from '@darmawanweb/ais-its-nest/auth';
import {
  ApiCursorResponse,
  CursorPageInfoDto,
  cursorPage,
  decodeQueryCursor,
  IntParam,
  MmsiParam,
  resolveQueryTimeRange,
  UuidParam,
} from '@darmawanweb/ais-its-nest/http';
import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  Put,
  Query,
  Req,
  Res,
} from '@nestjs/common';
import {
  ApiAcceptedResponse,
  ApiNoContentResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  getSchemaPath,
} from '@nestjs/swagger';
import type { FastifyReply, FastifyRequest } from 'fastify';
import * as z from 'zod';

import {
  addVary,
  csvDocument,
  TRUNCATED_HEADER,
  wantsCsv,
} from '../../common/csv.js';
import { ApiJsonOrCsvResponse } from '../../common/csv-openapi.js';
import { DdVectorDto } from '../../common/dto.js';
import { AnnualManualNotFoundError } from '../../common/errors.js';
import {
  mergeMethodIds,
  METHOD_IDS,
  segmentMethodIds,
} from '../methodology/method-ids.js';
import { CiiService, currentYear } from './cii.service.js';
import {
  AnnualManualDto,
  PutAnnualManualDto,
} from './dto/annual-manual.dto.js';
import {
  DailyCiiQuery,
  FleetFuelQuery,
  FleetSummaryQuery,
  RecomputeJobsQuery,
  RecomputeQuery,
  SegmentsQuery,
  YearQuery,
} from './dto/cii-queries.js';
import {
  AnnualCiiDto,
  CiiSummaryDto,
  CiiYearDto,
  DailyCiiDto,
  DailyCiiPointDto,
  FleetFuelDto,
  FleetSummaryDto,
  SegmentDto,
  SegmentPageDto,
} from './dto/cii-responses.js';
import { RecomputeJobDto, RecomputeJobPageDto } from './dto/recompute.dto.js';
import { RecomputeService } from './recompute.service.js';
import {
  SEGMENT_CSV_COLUMNS,
  SEGMENTS_CSV_MAX_ROWS,
  segmentsCsv,
} from './segment-csv.js';

const DAY_MS = 86_400_000;
const SegmentCursorSchema = z.object({ t: z.iso.datetime() });
const JobCursorSchema = z.object({ t: z.iso.datetime(), id: z.uuid() });
/** `:year` of the manual records (as the `year` query parameters). */
const YEAR_PARAM = {
  min: 2000,
  max: 2200,
  description: 'Calendar year 2000–2200',
} as const;

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
  @ApiOperation({
    summary: 'Year-to-date CII of a vessel with a linear year-end projection',
  })
  @ApiOkResponse({ type: CiiSummaryDto })
  async current(
    @MmsiParam() mmsi: number,
    @Query() query: YearQuery,
    @CurrentPrincipal() principal: Principal,
  ): Promise<CiiSummaryDto> {
    return new CiiSummaryDto(
      await this.cii.current(mmsi, query.year, principal),
    );
  }

  @Get('vessels/:mmsi/daily')
  @RequirePermissions('cii:read')
  @ApiOperation({
    summary:
      'Daily CII points with the cumulative (year-to-date) attained CII; default from 1 January of the year of to',
  })
  @ApiOkResponse({ type: DailyCiiDto })
  async daily(
    @MmsiParam() mmsi: number,
    @Query() query: DailyCiiQuery,
    @CurrentPrincipal() principal: Principal,
  ): Promise<DailyCiiDto> {
    const to = query.to === undefined ? new Date() : new Date(query.to);
    const { from } = resolveQueryTimeRange(
      {
        from:
          query.from ??
          new Date(Date.UTC(to.getUTCFullYear(), 0, 1)).toISOString(),
        to: to.toISOString(),
      },
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
  @ApiOperation({
    summary: 'Annual CII per year with the grade boundaries d_i × required',
  })
  @ApiOkResponse({ type: AnnualCiiDto })
  async annual(
    @MmsiParam() mmsi: number,
    @CurrentPrincipal() principal: Principal,
  ): Promise<AnnualCiiDto> {
    const { profile, years } = await this.cii.annual(mmsi, principal);
    return new AnnualCiiDto(
      profile,
      new DdVectorDto(profile.snapshot.type.d),
      years.map((figures) => new CiiYearDto(figures)),
    );
  }

  @Get('vessels/:mmsi/segments')
  @RequirePermissions('cii:read')
  @ApiOperation({
    summary:
      'Voyage segments of a vessel, newest first (default: the last 24 h, at most 31 days); Accept: text/csv exports the range',
    description: `With \`Accept: text/csv\` the response is a CSV of every matching segment of the range, oldest first, without cursor paging; at most ${SEGMENTS_CSV_MAX_ROWS.toLocaleString('en')} rows, and \`${TRUNCATED_HEADER}: true\` when the range holds more (narrow \`from\`/\`to\`).`,
  })
  @ApiJsonOrCsvResponse({
    description:
      'One page of the time-ordered list (JSON), or the CSV of the range (Accept: text/csv)',
    json: {
      type: 'object',
      required: ['data', 'page'],
      properties: {
        data: { type: 'array', items: { $ref: getSchemaPath(SegmentDto) } },
        page: { $ref: getSchemaPath(CursorPageInfoDto) },
      },
    },
    models: [SegmentDto, CursorPageInfoDto],
    csvExample: csvDocument(SEGMENT_CSV_COLUMNS, []),
    filename: 'segments-<mmsi>-<YYYY-MM-DD of from>.csv',
    truncatedWhen: `the range holds more than ${SEGMENTS_CSV_MAX_ROWS.toLocaleString('en')} matching segments (the CSV holds the oldest ${SEGMENTS_CSV_MAX_ROWS.toLocaleString('en')})`,
  })
  async segments(
    @MmsiParam() mmsi: number,
    @Query() query: SegmentsQuery,
    @CurrentPrincipal() principal: Principal,
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<SegmentPageDto | string> {
    addVary(reply, 'Accept');
    const range = resolveQueryTimeRange(query, {
      defaultDurationMs: DAY_MS,
      maxDurationMs: 31 * DAY_MS,
    });
    const filters = { methods: query.method, flag: query.flag };
    if (wantsCsv(request.headers.accept)) {
      const { rows } = await this.cii.segmentRange(
        mmsi,
        range,
        SEGMENTS_CSV_MAX_ROWS + 1,
        filters,
        principal,
      );
      const truncated = rows.length > SEGMENTS_CSV_MAX_ROWS;
      void reply
        .header('content-type', 'text/csv; charset=utf-8')
        .header(
          'content-disposition',
          `attachment; filename="segments-${mmsi}-${range.from.toISOString().slice(0, 10)}.csv"`,
        )
        .header(TRUNCATED_HEADER, String(truncated));
      return segmentsCsv(rows.slice(0, SEGMENTS_CSV_MAX_ROWS));
    }
    const cursor = decodeQueryCursor(query, SegmentCursorSchema);
    const rows = await this.cii.segmentPage(
      mmsi,
      range,
      cursor === undefined ? undefined : new Date(cursor.t),
      query.limit + 1,
      filters,
      principal,
    );
    const page = cursorPage(rows, query.limit, (row) => ({
      t: row.timeStart.toISOString(),
    }));
    return new SegmentPageDto(
      page.data.map((row) => new SegmentDto(row)),
      page.page,
    );
  }

  @Get('fleet/summary')
  @RequirePermissions('cii:read')
  @ApiOperation({
    summary:
      'CII grade distribution of the fleet of the active organization (super_admin: all or ?orgId) with one page of its vessels',
    description:
      "`grade`, `search` and `sort` select and order `items` (and `meta.total`); `vessels`, `grades` and `notAvailable` always describe the whole fleet. Each item carries the previous year's rating and grade for the trend.",
  })
  @ApiOkResponse({ type: FleetSummaryDto })
  async fleetSummary(
    @Query() query: FleetSummaryQuery,
    @CurrentPrincipal() principal: Principal,
  ): Promise<FleetSummaryDto> {
    const summary = await this.cii.fleetSummary(
      {
        year: query.year ?? currentYear(),
        orgId: query.orgId,
        grades: query.grade,
        search: query.search,
        sort: query.sort,
        page: query.page,
        pageSize: query.pageSize,
      },
      principal,
    );
    return new FleetSummaryDto(
      summary,
      mergeMethodIds(
        METHOD_IDS.rating,
        summary.items.some((item) => item.figures?.source === 'manual')
          ? METHOD_IDS.manual
          : [],
      ),
    );
  }

  @Get('fleet/fuel')
  @RequirePermissions('cii:read')
  @ApiOperation({
    summary:
      'Fuel (ME, AE, total) and CO2 of the fleet in a calendar year and one of its months (UTC)',
    description:
      'Per vessel, the counted segments of the period. For the year, a vessel without counted segments contributes its manual annual record (CO2 from its current fuel when the record has none); the month counts segments only. Fleet of the active organization (super_admin: all or ?orgId).',
  })
  @ApiOkResponse({ type: FleetFuelDto })
  async fleetFuel(
    @Query() query: FleetFuelQuery,
    @CurrentPrincipal() principal: Principal,
  ): Promise<FleetFuelDto> {
    const now = new Date();
    return new FleetFuelDto(
      await this.cii.fleetFuel(
        {
          year: query.year ?? currentYear(now),
          month: query.month ?? now.getUTCMonth() + 1,
          orgId: query.orgId,
        },
        principal,
      ),
    );
  }

  @Get('vessels/:mmsi/annual-manual/:year')
  @RequirePermissions('vessel:write')
  @ApiOperation({
    summary: 'Manual / imported annual CII record of a vessel-year',
  })
  @ApiOkResponse({ type: AnnualManualDto })
  async getManual(
    @MmsiParam() mmsi: number,
    @IntParam('year', YEAR_PARAM) year: number,
    @CurrentPrincipal() principal: Principal,
  ): Promise<AnnualManualDto> {
    const { record } = await this.cii.getManual(mmsi, year, principal);
    if (record === undefined) throw new AnnualManualNotFoundError(mmsi, year);
    return new AnnualManualDto(record);
  }

  @Put('vessels/:mmsi/annual-manual/:year')
  @RequirePermissions('vessel:write')
  @ApiOperation({
    summary:
      'Create or replace the manual annual CII of a vessel-year (used when the year has no segments)',
  })
  @ApiOkResponse({ type: AnnualManualDto })
  async putManual(
    @MmsiParam() mmsi: number,
    @IntParam('year', YEAR_PARAM) year: number,
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
      {
        action: 'cii_annual_manual.update',
        targetType: 'vessel',
        targetId: profile.vesselId,
        orgId: profile.orgId,
        meta: { mmsi, year },
      },
      principal,
      request,
    );
    return new AnnualManualDto(record);
  }

  @Delete('vessels/:mmsi/annual-manual/:year')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequirePermissions('vessel:write')
  @ApiOperation({
    summary: 'Remove the manual / imported annual CII record of a vessel-year',
    description:
      'The year falls back to its segments (or answers 404 CII_NOT_AVAILABLE without any). Audited as cii_annual_manual.delete.',
  })
  @ApiNoContentResponse({ description: 'Removed' })
  @ApiNotFoundResponse({
    description: 'VESSEL_NOT_FOUND or CII_ANNUAL_MANUAL_NOT_FOUND',
  })
  async deleteManual(
    @MmsiParam() mmsi: number,
    @IntParam('year', YEAR_PARAM) year: number,
    @CurrentPrincipal() principal: Principal,
    @Req() request: FastifyRequest,
  ): Promise<void> {
    const { profile } = await this.cii.deleteManual(mmsi, year, principal);
    await this.audit.record(
      {
        action: 'cii_annual_manual.delete',
        targetType: 'vessel',
        targetId: profile.vesselId,
        orgId: profile.orgId,
        meta: { mmsi, year },
      },
      principal,
      request,
    );
  }

  @Post('vessels/:mmsi/recompute')
  @HttpCode(HttpStatus.ACCEPTED)
  @RequirePlatformAdmin()
  @RequirePermissions('cii:read')
  @ApiOperation({
    summary:
      'Recompute the segments of a range by replaying AIS_POSITION (≤ 7 days)',
  })
  @ApiAcceptedResponse({ type: RecomputeJobDto })
  async startRecompute(
    @MmsiParam() mmsi: number,
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

  @Get('recompute-jobs')
  @RequirePlatformAdmin()
  @RequirePermissions('cii:read')
  @ApiOperation({
    summary:
      'Recomputation jobs, newest first, optionally of one vessel and status',
    description:
      'Shows the jobs started by any administrator or instance (e.g. the running job behind 409 RECOMPUTE_IN_PROGRESS); running jobs of a stopped instance are failed first.',
  })
  @ApiCursorResponse(RecomputeJobDto)
  async recomputeJobs(
    @Query() query: RecomputeJobsQuery,
  ): Promise<RecomputeJobPageDto> {
    const cursor = decodeQueryCursor(query, JobCursorSchema);
    const rows = await this.recompute.list(
      { mmsi: query.mmsi, status: query.status },
      cursor === undefined
        ? undefined
        : { createdAt: new Date(cursor.t), id: cursor.id },
      query.limit + 1,
    );
    const page = cursorPage(rows, query.limit, (row) => ({
      t: row.createdAt.toISOString(),
      id: row.id,
    }));
    return new RecomputeJobPageDto(
      page.data.map((row) => new RecomputeJobDto(row)),
      page.page,
    );
  }

  @Get('recompute-jobs/:id')
  @RequirePlatformAdmin()
  @RequirePermissions('cii:read')
  @ApiOperation({ summary: 'Status of a recomputation' })
  @ApiOkResponse({ type: RecomputeJobDto })
  async recomputeJob(@UuidParam() id: string): Promise<RecomputeJobDto> {
    return new RecomputeJobDto(await this.recompute.get(id));
  }
}
