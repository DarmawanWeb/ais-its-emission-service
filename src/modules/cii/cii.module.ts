import { Module } from '@nestjs/common';

import { ProfilesModule } from '../profiles/profiles.module.js';
import { SegmentsModule } from '../segments/segments.module.js';
import { AnnualManualRepository } from './annual-manual.repository.js';
import { CiiController } from './cii.controller.js';
import { CiiRepository } from './cii.repository.js';
import { CiiService } from './cii.service.js';
import { CiiPublisherService } from './cii-publisher.service.js';
import { RecomputeService } from './recompute.service.js';
import { RecomputeJobsRepository } from './recompute-jobs.repository.js';
import { ReductionFactorsController } from './reduction-factors.controller.js';
import { ReductionFactorsRepository } from './reduction-factors.repository.js';
import { ReductionFactorsService } from './reduction-factors.service.js';

/** CII: aggregates, rating layer, manual records, reduction factors, publication, recomputation. */
@Module({
  imports: [ProfilesModule, SegmentsModule],
  controllers: [CiiController, ReductionFactorsController],
  providers: [
    CiiRepository,
    AnnualManualRepository,
    ReductionFactorsRepository,
    ReductionFactorsService,
    CiiService,
    CiiPublisherService,
    RecomputeJobsRepository,
    RecomputeService,
  ],
  exports: [CiiService, ReductionFactorsService],
})
export class CiiModule {}
