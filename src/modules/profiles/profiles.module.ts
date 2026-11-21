import { Module } from '@nestjs/common';

import { ProfileDirectory } from './profile-directory.js';
import { VesselAccessService } from './vessel-access.service.js';
import { VesselProfilesRepository } from './vessel-profiles.repository.js';

/** FLEET projection: storage, the in-memory directory and tenancy checks. */
@Module({
  providers: [VesselProfilesRepository, ProfileDirectory, VesselAccessService],
  exports: [VesselProfilesRepository, ProfileDirectory, VesselAccessService],
})
export class ProfilesModule {}
