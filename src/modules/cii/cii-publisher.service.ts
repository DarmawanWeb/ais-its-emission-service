import {
  type CiiUpdatedV1,
  EVENT_TYPES,
} from '@darmawanweb/ais-its-contracts/events';
import { InjectConfig } from '@darmawanweb/ais-its-nest';
import { EventPublisher } from '@darmawanweb/ais-its-nest/nats';
import {
  type BeforeApplicationShutdown,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
} from '@nestjs/common';

import {
  CiiNotAvailableError,
  ReductionFactorMissingError,
} from '../../common/errors.js';
import type { Config } from '../../config.js';
import { VesselProfilesRepository } from '../profiles/vessel-profiles.repository.js';
import { AggregateRefresher } from '../segments/aggregate-refresher.service.js';
import { CiiPublicationRepository } from '../segments/cii-publication.repository.js';
import { SegmentsRepository } from '../segments/segments.repository.js';
import { CiiService } from './cii.service.js';

/** Vessels published per poll. */
const BATCH_SIZE = 100;

/**
 * Throttled producer of `emission.cii.updated.v1` (stream `EMISSION`): every
 * CII_PUBLISH_POLL_MS it claims the vessels whose segments changed and whose
 * last publication is at least CII_PUBLISH_INTERVAL_S old (shared state in
 * `cii_publication`, so replicas never publish the same vessel twice in an
 * interval) and publishes their year-to-date CII of the year of the latest
 * segment. A failed publication marks the vessel dirty again.
 */
@Injectable()
export class CiiPublisherService
  implements OnApplicationBootstrap, BeforeApplicationShutdown
{
  private readonly logger = new Logger(CiiPublisherService.name);
  private timer: NodeJS.Timeout | undefined;
  private tick: Promise<void> | undefined;

  constructor(
    @InjectConfig() private readonly config: Config,
    private readonly publication: CiiPublicationRepository,
    private readonly refresher: AggregateRefresher,
    private readonly profiles: VesselProfilesRepository,
    private readonly segments: SegmentsRepository,
    private readonly cii: CiiService,
    private readonly events: EventPublisher,
  ) {}

  onApplicationBootstrap(): void {
    this.timer = setInterval(() => {
      this.tick ??= this.publishDue()
        .then(() => undefined)
        .catch((error: unknown) => {
          this.logger.warn({ err: error }, 'CII publication round failed');
        })
        .finally(() => {
          this.tick = undefined;
        });
    }, this.config.CII_PUBLISH_POLL_MS);
    this.timer.unref();
  }

  async beforeApplicationShutdown(): Promise<void> {
    if (this.timer !== undefined) clearInterval(this.timer);
    await this.tick;
  }

  /** Publishes every due vessel once; a failing vessel is marked dirty again without stopping the round. */
  async publishDue(): Promise<number> {
    // Late changes must reach the aggregates before their figures are published.
    await this.refresher.flush().catch((error: unknown) => {
      this.logger.warn(
        { err: error },
        'CII aggregate refresh before publication failed',
      );
    });
    const due = await this.publication.claimDue(
      this.config.CII_PUBLISH_INTERVAL_S,
      BATCH_SIZE,
    );
    let published = 0;
    for (const mmsi of due) {
      try {
        if (await this.publishOne(mmsi)) published += 1;
      } catch (error) {
        this.logger.warn(
          { err: error, mmsi },
          'CII publication of a vessel failed',
        );
        await this.publication.settle(mmsi, 'failed');
      }
    }
    return published;
  }

  private async publishOne(mmsi: number): Promise<boolean> {
    const [profile, latest] = await Promise.all([
      this.profiles.findByMmsi(mmsi),
      this.segments.latestCounted(mmsi),
    ]);
    if (profile === undefined || latest === undefined) return false;
    const year = latest.timeStart.getUTCFullYear();
    let data: CiiUpdatedV1;
    try {
      const summary = await this.cii.summary(profile, year);
      const { figures } = summary;
      if (
        figures.required === null ||
        figures.rating === null ||
        figures.grade === null ||
        figures.co2Ton === null
      )
        return false;
      data = {
        mmsi,
        vesselId: profile.vesselId,
        orgId: profile.orgId,
        year,
        asOf: (figures.asOf ?? latest.timeEnd).toISOString(),
        distanceNm: figures.distanceNm,
        fuelMeTon: figures.fuelMeTon,
        fuelAeTon: figures.fuelAeTon,
        co2Ton: figures.co2Ton,
        attained: figures.attained,
        required: figures.required,
        rating: figures.rating,
        grade: figures.grade,
        lastMethod: latest.method,
      };
    } catch (error) {
      if (
        error instanceof CiiNotAvailableError ||
        error instanceof ReductionFactorMissingError
      ) {
        this.logger.warn({ mmsi, year, code: error.code }, 'CII not published');
        return false;
      }
      throw error;
    }
    try {
      await this.events.publishEvent(EVENT_TYPES.EMISSION_CII_UPDATED, data);
      await this.publication.settle(mmsi, { year });
      return true;
    } catch (error) {
      this.logger.warn(
        { err: error, mmsi },
        'emission.cii.updated.v1 publication failed',
      );
      await this.publication.settle(mmsi, 'failed');
      return false;
    }
  }
}
