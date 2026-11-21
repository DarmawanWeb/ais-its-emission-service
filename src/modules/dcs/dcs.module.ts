import { Module } from '@nestjs/common';

import { AnnualManualRepository } from '../cii/annual-manual.repository.js';
import { ProfilesModule } from '../profiles/profiles.module.js';
import { SegmentsModule } from '../segments/segments.module.js';
import { DcsController } from './dcs.controller.js';
import { DcsService } from './dcs.service.js';

/** IMO DCS-style annual summary (JSON and CSV). */
@Module({
  imports: [ProfilesModule, SegmentsModule],
  controllers: [DcsController],
  providers: [DcsService, AnnualManualRepository],
})
export class DcsModule {}
