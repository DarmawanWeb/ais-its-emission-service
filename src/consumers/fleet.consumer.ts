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
    // WORKAROUND (platform issue): contracts `fleetProjection()` widens the
    // consumer definition, so the envelope type is the union of every event;
    // the kit only delivers the two fleet types to this handler.
    if (event.type === EVENT_TYPES.FLEET_VESSEL_UPSERTED) {
      const outcome = await this.profiles.upsert(event.data);
      if (outcome !== 'stale')
        this.directory.apply(profileOfSnapshot(event.data));
      this.logger.debug(
        { vesselId: event.data.id, mmsi: event.data.mmsi, outcome },
        'vessel profile',
      );
    } else if (event.type === EVENT_TYPES.FLEET_VESSEL_DELETED) {
      await this.profiles.delete(event.data.id);
      this.directory.remove(event.data.id);
      this.logger.debug(
        { vesselId: event.data.id, mmsi: event.data.mmsi },
        'vessel profile deleted',
      );
    }
  }
}
