import { MetricsService } from '@darmawanweb/ais-its-nest/metrics';
import { type ConsumerEnvelope, EventHandler } from '@darmawanweb/ais-its-nest/nats';
import { Injectable } from '@nestjs/common';
import type { Counter } from 'prom-client';

import { type PositionOutcome, SegmentBuilderService } from '../modules/segments/segment-builder.service.js';

/**
 * AIS positions (durable consumer `emission-positions`, the whole AIS feed):
 * one segment `previous → current` per event of a fleet vessel. Messages of
 * one vessel are handled in stream order (`orderBySubject`); storage is
 * idempotent by `(mmsi, time_start)`. Metric `aisits_emission_positions_total{outcome}`.
 */
@Injectable()
export class PositionsConsumer {
  private readonly outcomes: Counter<'outcome'>;

  constructor(
    private readonly builder: SegmentBuilderService,
    metrics: MetricsService,
  ) {
    this.outcomes = metrics.counter({
      name: 'emission_positions_total',
      help: 'Position events handled by outcome (stored, duplicate, unknown_vessel, no_previous, not_after_previous)',
      labelNames: ['outcome'],
    });
  }

  @EventHandler({ consumer: 'emission-positions', concurrency: 8 })
  async onPosition(event: ConsumerEnvelope<'emission-positions'>): Promise<void> {
    const outcome: PositionOutcome = await this.builder.handlePosition(event.data);
    this.outcomes.inc({ outcome });
  }
}
