import { EVENT_TYPES } from '@darmawanweb/ais-its-contracts/events';
import {
  type ConsumerEnvelope,
  EventHandler,
} from '@darmawanweb/ais-its-nest/nats';
import { Injectable, Logger } from '@nestjs/common';

import { ProfileDirectory } from '../modules/profiles/profile-directory.js';
import { profileOfSnapshot } from '../modules/profiles/vessel-profile.js';
import { VesselProfilesRepository } from '../modules/profiles/vessel-profiles.repository.js';

/**
 * FLEET projection (durable consumer `emission-fleet`): upserts the vessel
 * snapshot into `vessel_profiles` (older snapshots never win, by `updatedAt`)
 * and removes deleted vessels; idempotent by natural key (vessel id + version).
 */
@Injectable()
export class FleetConsumer {
  private readonly logger = new Logger(FleetConsumer.name);

  constructor(
    private readonly profiles: VesselProfilesRepository,
    private readonly directory: ProfileDirectory,
  ) {}

  @EventHandler({ consumer: 'emission-fleet' })
  async onVessel(event: ConsumerEnvelope<'emission-fleet'>): Promise<void> {
    // The contracts entry keeps its literal event types, so the envelope is
    // exactly the two fleet events and this switch is exhaustive.
    switch (event.type) {
      case EVENT_TYPES.FLEET_VESSEL_UPSERTED: {
        const outcome = await this.profiles.upsert(event.data);
        if (outcome !== 'stale')
          this.directory.apply(profileOfSnapshot(event.data));
        this.logger.debug(
          { vesselId: event.data.id, mmsi: event.data.mmsi, outcome },
          'vessel profile',
        );
        return;
      }
      case EVENT_TYPES.FLEET_VESSEL_DELETED:
        await this.profiles.delete(event.data.id);
        this.directory.remove(event.data.id);
        this.logger.debug(
          { vesselId: event.data.id, mmsi: event.data.mmsi },
          'vessel profile deleted',
        );
        return;
      default: {
        const unreachable: never = event;
        return unreachable;
      }
    }
  }
}
