import {
  CurrentPrincipal,
  type Principal,
  RequirePermissions,
} from '@darmawanweb/ais-its-nest/auth';
import {
  Controller,
  Get,
  Header,
  Param,
  Query,
  Req,
  Res,
} from '@nestjs/common';
import {
  ApiOkResponse,
  ApiOperation,
  ApiProduces,
  ApiTags,
} from '@nestjs/swagger';
import type { FastifyReply, FastifyRequest } from 'fastify';

import { ParseMmsiPipe } from '../../common/pipes.js';
import { dcsCsv } from '../../domain/dcs.js';
import { YearQuery } from '../cii/dto/cii-queries.js';
import { currentYear } from '../cii/cii.service.js';
import { mergeMethodIds, METHOD_IDS } from '../methodology/method-ids.js';
import { DcsSummaryDto } from './dcs.dto.js';
import { DcsService } from './dcs.service.js';

/** IMO DCS-style annual summary (`/api/v2/emission/vessels/:mmsi/dcs`), tenant-private. */
@ApiTags('emission')
@Controller('emission/vessels')
export class DcsController {
  constructor(private readonly dcs: DcsService) {}

  @Get(':mmsi/dcs')
  @RequirePermissions('cii:read')
  @Header('vary', 'accept')
  @ApiOperation({
    summary:
      'Annual fuel by type, distance, hours under way and CO2 (Accept: text/csv for CSV; default: current year)',
  })
  @ApiProduces('application/json', 'text/csv')
  @ApiOkResponse({ type: DcsSummaryDto })
  async summary(
    @Param('mmsi', ParseMmsiPipe) mmsi: number,
    @Query() query: YearQuery,
    @CurrentPrincipal() principal: Principal,
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<DcsSummaryDto | string> {
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
    const methodIds = mergeMethodIds(
      METHOD_IDS.dcs,
      METHOD_IDS.segment,
      summary.source === 'manual' ? METHOD_IDS.manual : [],
    );
    return new DcsSummaryDto(profile.vesselId, summary, methodIds);
  }
}

/** `true` when the client prefers CSV (`Accept: text/csv`) over JSON. */
export function wantsCsv(accept: string | undefined): boolean {
  if (accept === undefined) return false;
  const types = accept
    .split(',')
    .map((part) => part.split(';')[0]?.trim().toLowerCase());
  const csv = types.indexOf('text/csv');
  const json = types.findIndex(
    (type) => type === 'application/json' || type === 'application/*',
  );
  return csv !== -1 && (json === -1 || csv < json);
}
