import { APP_CONFIG, type BaseConfig } from '@darmawanweb/ais-its-nest';
import { Module } from '@nestjs/common';

import { CiiModule } from '../cii/cii.module.js';
import { ProfilesModule } from '../profiles/profiles.module.js';
import { EmissionMethodologyService } from './emission-methodology.service.js';
import { IMPLEMENTED_METHOD_IDS } from './implemented-methods.js';
import { CONTRACTS_METHOD_CATALOG } from './method-catalog.js';
import { MethodologyController } from './methodology.controller.js';
import { MethodologyService } from './methodology.service.js';

/** `GET /api/v2/emission/methodology` (spec §17 traceability). */
@Module({
  imports: [CiiModule, ProfilesModule],
  controllers: [MethodologyController],
  providers: [
    {
      provide: MethodologyService,
      useFactory: (config: BaseConfig): MethodologyService =>
        new MethodologyService(config.SERVICE_NAME, IMPLEMENTED_METHOD_IDS, CONTRACTS_METHOD_CATALOG),
      inject: [APP_CONFIG],
    },
    EmissionMethodologyService,
  ],
})
export class MethodologyModule {}
