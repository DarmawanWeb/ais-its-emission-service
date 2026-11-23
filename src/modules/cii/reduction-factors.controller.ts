import {
  CurrentPrincipal,
  type Principal,
  RequirePermissions,
} from '@darmawanweb/ais-its-nest/auth';
import { IntParam } from '@darmawanweb/ais-its-nest/http';
import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Put,
  Req,
} from '@nestjs/common';
import {
  ApiConflictResponse,
  ApiNoContentResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
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

  @Delete(':year')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequirePermissions('reference:write')
  @ApiOperation({
    summary: 'Remove the reduction factor of a year that no CII figure uses',
    description:
      'Only the first or the last year of the table can be removed (409 REDUCTION_FACTOR_TABLE_GAP otherwise: the SEEMP cost model needs Z for every year up to the last one), and only while no vessel has CII data (segments or a manual record) for the year (409 REDUCTION_FACTOR_IN_USE: correct the value with PUT instead). Audited as reduction_factor.delete.',
  })
  @ApiNoContentResponse({ description: 'Removed' })
  @ApiNotFoundResponse({ description: 'REDUCTION_FACTOR_NOT_FOUND' })
  @ApiConflictResponse({
    description: 'REDUCTION_FACTOR_IN_USE or REDUCTION_FACTOR_TABLE_GAP',
  })
  async remove(
    @IntParam('year', {
      min: 2000,
      max: 2200,
      description: 'Calendar year 2000–2200',
    })
    year: number,
    @CurrentPrincipal() principal: Principal,
    @Req() request: FastifyRequest,
  ): Promise<void> {
    await this.factors.remove(year, principal, request);
  }
}
