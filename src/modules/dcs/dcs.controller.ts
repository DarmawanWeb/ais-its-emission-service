import {
  CurrentPrincipal,
  type Principal,
  RequirePermissions,
} from '@darmawanweb/ais-its-nest/auth';
import { MmsiParam } from '@darmawanweb/ais-its-nest/http';
import { Controller, Get, Query, Req, Res } from '@nestjs/common';
import { ApiOperation, ApiTags, getSchemaPath } from '@nestjs/swagger';
import type { FastifyReply, FastifyRequest } from 'fastify';

import { addVary, csvDocument, wantsCsv } from '../../common/csv.js';
import { ApiJsonOrCsvResponse } from '../../common/csv-openapi.js';
import {
  DCS_CSV_COLUMNS,
  type DcsSummary,
  dcsCsv,
  fleetDcsCsv,
} from '../../domain/dcs.js';
import { FleetDcsQuery, YearQuery } from '../cii/dto/cii-queries.js';
import { currentYear } from '../cii/cii.service.js';
import { mergeMethodIds, METHOD_IDS } from '../methodology/method-ids.js';
import { DcsSummaryDto, FleetDcsDto, FleetDcsMissingDto } from './dcs.dto.js';
import { DcsService } from './dcs.service.js';

/** Method ids of DCS summaries of the given sources. */
function dcsMethodIds(summaries: readonly DcsSummary[]): string[] {
  return mergeMethodIds(
    METHOD_IDS.dcs,
    METHOD_IDS.segment,
    summaries.some((summary) => summary.source === 'manual')
      ? METHOD_IDS.manual
      : [],
  );
}

/**
 * IMO DCS-style annual summaries (`/api/v2/emission/vessels/:mmsi/dcs`,
 * `/api/v2/emission/fleet/dcs`), tenant-private.
 */
@ApiTags('emission')
@Controller('emission')
export class DcsController {
  constructor(private readonly dcs: DcsService) {}

  @Get('vessels/:mmsi/dcs')
  @RequirePermissions('cii:read')
  @ApiOperation({
    summary:
      'Annual fuel by type, distance, hours under way and CO2 (Accept: text/csv for CSV; default: current year)',
  })
  @ApiJsonOrCsvResponse({
    description:
      'DCS summary of the vessel-year (JSON), or its CSV with one row per fuel type (Accept: text/csv)',
    json: { $ref: getSchemaPath(DcsSummaryDto) },
    models: [DcsSummaryDto],
    csvExample: csvDocument(DCS_CSV_COLUMNS, []),
    filename: 'dcs-<mmsi>-<year>.csv',
  })
  async summary(
    @MmsiParam() mmsi: number,
    @Query() query: YearQuery,
    @CurrentPrincipal() principal: Principal,
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<DcsSummaryDto | string> {
    addVary(reply, 'Accept');
    const year = query.year ?? currentYear();
    const { profile, summary } = await this.dcs.summary(mmsi, year, principal);
    if (wantsCsv(request.headers.accept)) {
      void reply
        .header('content-type', 'text/csv; charset=utf-8')
        .header(
          'content-disposition',
          `attachment; filename="dcs-${mmsi}-${year}.csv"`,
        );
      return dcsCsv(summary);
    }
    return new DcsSummaryDto(
      profile.vesselId,
      summary,
      dcsMethodIds([summary]),
    );
  }

  @Get('fleet/dcs')
  @RequirePermissions('cii:read')
  @ApiOperation({
    summary:
      "DCS-style annual summaries of every vessel of the fleet (an organization's annual submission; Accept: text/csv for one CSV)",
    description:
      'Fleet of the active organization (super_admin: all or ?orgId), by MMSI. Each vessel as GET /emission/vessels/{mmsi}/dcs; vessels without segments or a manual record for the year are listed in `withoutData` (and left out of the CSV, which has the per-vessel layout with one header).',
  })
  @ApiJsonOrCsvResponse({
    description:
      'DCS summaries of the fleet (JSON), or one CSV of every vessel with data in the per-vessel layout (Accept: text/csv)',
    json: { $ref: getSchemaPath(FleetDcsDto) },
    models: [FleetDcsDto],
    csvExample: csvDocument(DCS_CSV_COLUMNS, []),
    filename: 'dcs-fleet-<orgId or all>-<year>.csv',
  })
  async fleet(
    @Query() query: FleetDcsQuery,
    @CurrentPrincipal() principal: Principal,
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<FleetDcsDto | string> {
    addVary(reply, 'Accept');
    const year = query.year ?? currentYear();
    const fleet = await this.dcs.fleet(year, query.orgId, principal);
    const summaries = fleet.items.flatMap((item) =>
      item.summary === undefined ? [] : [item.summary],
    );
    if (wantsCsv(request.headers.accept)) {
      void reply
        .header('content-type', 'text/csv; charset=utf-8')
        .header(
          'content-disposition',
          `attachment; filename="dcs-fleet-${fleet.orgId ?? 'all'}-${year}.csv"`,
        );
      return fleetDcsCsv(summaries);
    }
    return new FleetDcsDto(
      { year, orgId: fleet.orgId, vessels: fleet.items.length },
      fleet.items.flatMap((item) =>
        item.summary === undefined
          ? []
          : [
              new DcsSummaryDto(
                item.vessel.vesselId,
                item.summary,
                dcsMethodIds([item.summary]),
              ),
            ],
      ),
      fleet.items.flatMap((item) =>
        item.summary === undefined ? [new FleetDcsMissingDto(item.vessel)] : [],
      ),
      dcsMethodIds(summaries),
    );
  }
}
