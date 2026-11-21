import {
  CurrentPrincipal,
  type Principal,
  RequirePermissions,
} from '@darmawanweb/ais-its-nest/auth';
import { Body, Controller, Get, Put, Req } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { FastifyRequest } from 'fastify';

import {
  PutReductionFactorsDto,
  ReductionFactorListDto,
} from './dto/reduction-factor.dto.js';
import { ReductionFactorsService } from './reduction-factors.service.js';

/** Reduction factors Z of the required CII (`/api/v2/reduction-factors`). */
@ApiTags('reduction-factors')
@Controller('reduction-factors')
export class ReductionFactorsController {
  constructor(private readonly factors: ReductionFactorsService) {}

  @Get()
  @RequirePermissions('cii:read')
  @ApiOperation({ summary: 'Reduction factors Z per year with their sources' })
  @ApiOkResponse({ type: ReductionFactorListDto })
  async list(): Promise<ReductionFactorListDto> {
    return new ReductionFactorListDto(await this.factors.list());
  }

  @Put()
  @RequirePermissions('reference:write')
  @ApiOperation({
    summary:
      'Insert or replace reduction factors of the given years (other years are kept)',
  })
  @ApiOkResponse({ type: ReductionFactorListDto })
  async put(
    @Body() body: PutReductionFactorsDto,
    @CurrentPrincipal() principal: Principal,
    @Req() request: FastifyRequest,
  ): Promise<ReductionFactorListDto> {
    return new ReductionFactorListDto(
      await this.factors.upsert(
        body.items.map((item) => ({
          year: item.year,
          zPercent: item.zPercent,
          source: item.source,
        })),
        principal,
        request,
      ),
    );
  }
}
