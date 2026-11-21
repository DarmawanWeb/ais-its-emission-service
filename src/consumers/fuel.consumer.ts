import {
  type ConsumerEnvelope,
  EventHandler,
} from '@darmawanweb/ais-its-nest/nats';
import { Injectable, Logger } from '@nestjs/common';

import { TelemetryAttributionService } from '../modules/segments/telemetry-attribution.service.js';

/**
 * Telemetry readings (durable consumer `emission-fuel`): stored by
 * `(mmsi, time)` (natural-key dedup) and attributed to the vessel's
 * segments (idempotent, re-run on redelivery).
 */
@Injectable()
export class FuelConsumer {
  private readonly logger = new Logger(FuelConsumer.name);

  constructor(private readonly attribution: TelemetryAttributionService) {}

  @EventHandler({ consumer: 'emission-fuel', concurrency: 4 })
  async onReading(event: ConsumerEnvelope<'emission-fuel'>): Promise<void> {
    const outcome = await this.attribution.onReading(event.data);
    if (outcome.reattributed > 0) {
      this.logger.debug(
        {
          mmsi: event.data.mmsi,
          outcome: outcome.kind,
          reattributed: outcome.reattributed,
        },
        'segments re-attributed to telemetry',
      );
    }
  }
}
