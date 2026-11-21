import { Module } from '@nestjs/common';

import { CiiModule } from '../cii/cii.module.js';
import { ProfilesModule } from '../profiles/profiles.module.js';
import { SeempController } from './seemp.controller.js';
import { SeempMeasuresRepository } from './seemp-measures.repository.js';
import { SeempScenariosRepository } from './seemp-scenarios.repository.js';
import { SeempService } from './seemp.service.js';

/** SEEMP: measure catalog, recommendations, what-if simulation, scenarios. */
@Module({
  imports: [ProfilesModule, CiiModule],
  controllers: [SeempController],
  providers: [SeempMeasuresRepository, SeempScenariosRepository, SeempService],
})
export class SeempModule {}
