import { Controller, Get } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';

import { EmissionMethodologyService } from './emission-methodology.service.js';
import { EmissionMethodologyDto } from './methodology.dto.js';

@ApiTags('methodology')
@Controller('emission/methodology')
export class MethodologyController {
  constructor(private readonly methodology: EmissionMethodologyService) {}

  /** No permission decorator: any signed-in user (the global guard denies anonymous calls). */
  @Get()
  @ApiOperation({
    summary: 'Methods implemented by this service with formulas, variables and sources; active reduction factors; vessel type parameters',
  })
  @ApiOkResponse({ type: EmissionMethodologyDto })
  async describe(): Promise<EmissionMethodologyDto> {
    return new EmissionMethodologyDto(await this.methodology.describe());
  }
}
