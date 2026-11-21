import { Module } from '@nestjs/common';

import { ProfilesModule } from '../modules/profiles/profiles.module.js';
import { SegmentsModule } from '../modules/segments/segments.module.js';
import { FleetConsumer } from './fleet.consumer.js';
import { FuelConsumer } from './fuel.consumer.js';
import { PositionsConsumer } from './positions.consumer.js';

/** The durable NATS consumers of the service (spec §7.3). */
@Module({
  imports: [ProfilesModule, SegmentsModule],
  providers: [FleetConsumer, FuelConsumer, PositionsConsumer],
})
export class ConsumersModule {}
