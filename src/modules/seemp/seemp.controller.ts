import {
  CurrentPrincipal,
  type Principal,
  RequirePermissions,
} from '@darmawanweb/ais-its-nest/auth';
import {
  ApiPageResponse,
  MmsiParam,
  pageOffsetOf,
  paginate,
  UuidParam,
} from '@darmawanweb/ais-its-nest/http';
import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Patch,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import {
  ApiCreatedResponse,
  ApiNoContentResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import type { FastifyRequest } from 'fastify';
import { instanceToPlain } from 'class-transformer';

import {
  CreateScenarioDto,
  ListScenariosQuery,
  RenameScenarioDto,
  SeempMeasureListDto,
  SeempRecommendationsDto,
  SeempRecommendationsQuery,
  SeempScenarioDto,
  SeempScenarioPageDto,
  SeempSimulationDto,
  SimulateDto,
} from './dto/seemp.dto.js';
import { SeempService } from './seemp.service.js';

/** SEEMP recommendations, simulation and saved scenarios (`/api/v2/seemp`), tenant-private. */
@ApiTags('seemp')
@Controller('seemp')
export class SeempController {
  constructor(private readonly seemp: SeempService) {}

  @Get('measures')
  @RequirePermissions('seemp:read')
  @ApiOperation({
    summary: 'Catalog of the SEEMP measures (legacy recommender)',
  })
  @ApiOkResponse({ type: SeempMeasureListDto })
  async measures(): Promise<SeempMeasureListDto> {
    return new SeempMeasureListDto(await this.seemp.catalog());
  }

  @Get('vessels/:mmsi/recommendations')
  @RequirePermissions('seemp:read')
  @ApiOperation({
    summary:
      'SEEMP recommendations: measures with grade A–C after, cheapest first (legacy calculateSEEMPbyMMSI); includeAll=true lists every measure',
  })
  @ApiOkResponse({ type: SeempRecommendationsDto })
  async recommendations(
    @MmsiParam() mmsi: number,
    @Query() query: SeempRecommendationsQuery,
    @CurrentPrincipal() principal: Principal,
  ): Promise<SeempRecommendationsDto> {
    return new SeempRecommendationsDto(
      await this.seemp.recommendations(mmsi, query, principal),
    );
  }

  @Post('vessels/:mmsi/simulate')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('seemp:simulate')
  @ApiOperation({ summary: 'What-if simulation of a combination of measures' })
  @ApiOkResponse({ type: SeempSimulationDto })
  async simulate(
    @MmsiParam() mmsi: number,
    @Body() body: SimulateDto,
    @CurrentPrincipal() principal: Principal,
  ): Promise<SeempSimulationDto> {
    return new SeempSimulationDto(
      await this.seemp.simulate(mmsi, body.measureCodes, body, principal),
    );
  }

  @Get('scenarios')
  @RequirePermissions('seemp:read')
  @ApiOperation({
    summary:
      'Saved simulations of the organization (super_admin: all), newest first by default',
  })
  @ApiPageResponse(SeempScenarioDto)
  async listScenarios(
    @Query() query: ListScenariosQuery,
    @CurrentPrincipal() principal: Principal,
  ): Promise<SeempScenarioPageDto> {
    const { rows, total } = await this.seemp.listScenarios(
      { mmsi: query.mmsi, search: query.search, sort: query.sort },
      { offset: pageOffsetOf(query), limit: query.pageSize },
      principal,
    );
    const page = paginate(
      rows.map((row) => new SeempScenarioDto(row)),
      query,
      total,
    );
    return new SeempScenarioPageDto(page.data, page.meta);
  }

  @Post('scenarios')
  @RequirePermissions('seemp:simulate')
  @ApiOperation({ summary: 'Simulate and save a scenario' })
  @ApiCreatedResponse({ type: SeempScenarioDto })
  async createScenario(
    @Body() body: CreateScenarioDto,
    @CurrentPrincipal() principal: Principal,
    @Req() request: FastifyRequest,
  ): Promise<SeempScenarioDto> {
    const scenario = await this.seemp.createScenario(
      body,
      principal,
      (simulation) => instanceToPlain(new SeempSimulationDto(simulation)),
      request,
    );
    return new SeempScenarioDto(scenario);
  }

  @Get('scenarios/:id')
  @RequirePermissions('seemp:read')
  @ApiOperation({ summary: 'A saved scenario' })
  @ApiOkResponse({ type: SeempScenarioDto })
  async getScenario(
    @UuidParam() id: string,
    @CurrentPrincipal() principal: Principal,
  ): Promise<SeempScenarioDto> {
    return new SeempScenarioDto(await this.seemp.getScenario(id, principal));
  }

  @Patch('scenarios/:id')
  @RequirePermissions('seemp:simulate')
  @ApiOperation({
    summary: 'Rename a saved scenario (audited as seemp_scenario.update)',
  })
  @ApiOkResponse({ type: SeempScenarioDto })
  async renameScenario(
    @UuidParam() id: string,
    @Body() body: RenameScenarioDto,
    @CurrentPrincipal() principal: Principal,
    @Req() request: FastifyRequest,
  ): Promise<SeempScenarioDto> {
    return new SeempScenarioDto(
      await this.seemp.renameScenario(id, body.name, principal, request),
    );
  }

  @Delete('scenarios/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequirePermissions('seemp:simulate')
  @ApiOperation({ summary: 'Delete a saved scenario' })
  @ApiNoContentResponse()
  async deleteScenario(
    @UuidParam() id: string,
    @CurrentPrincipal() principal: Principal,
    @Req() request: FastifyRequest,
  ): Promise<void> {
    await this.seemp.deleteScenario(id, principal, request);
  }
}
