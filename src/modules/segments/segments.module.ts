import { Module } from '@nestjs/common';

import { ProfilesModule } from '../profiles/profiles.module.js';
import { WeatherModule } from '../weather/weather.module.js';
import { CiiPublicationRepository } from './cii-publication.repository.js';
import { FuelReadingsRepository } from './fuel-readings.repository.js';
import { SegmentBuilderService } from './segment-builder.service.js';
import { SegmentsRepository } from './segments.repository.js';
import { TelemetryAttributionService } from './telemetry-attribution.service.js';

/** Voyage segments: building from positions and telemetry attribution. */
@Module({
  imports: [ProfilesModule, WeatherModule],
  providers: [
    FuelReadingsRepository,
    SegmentsRepository,
    CiiPublicationRepository,
    SegmentBuilderService,
    TelemetryAttributionService,
  ],
  exports: [SegmentsRepository, CiiPublicationRepository, SegmentBuilderService, TelemetryAttributionService],
})
export class SegmentsModule {}
