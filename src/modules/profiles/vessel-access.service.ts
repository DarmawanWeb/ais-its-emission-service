import { assertOrgAccess, type Principal } from '@darmawanweb/ais-its-nest/auth';
import { Injectable } from '@nestjs/common';

import { VesselNotFoundError } from '../../common/errors.js';
import { VesselProfilesRepository } from './vessel-profiles.repository.js';
import type { VesselProfile } from './vessel-profile.js';

/**
 * Tenancy of CII, SEEMP and DCS data (spec §8.5: tenant-private): the vessel's
 * organization (from the FLEET projection, never from the client) must be the
 * principal's active organization, unless the principal is `super_admin`.
 */
@Injectable()
export class VesselAccessService {
  constructor(private readonly profiles: VesselProfilesRepository) {}

  /**
   * The profile of a vessel the principal may read; `404 VESSEL_NOT_FOUND`
   * when the MMSI is not in the fleet, `403 FORBIDDEN` for another tenant.
   */
  async accessible(mmsi: number, principal: Principal): Promise<VesselProfile> {
    const profile = await this.profiles.findByMmsi(mmsi);
    if (profile === undefined) throw new VesselNotFoundError(mmsi);
    assertOrgAccess(principal, profile.orgId);
    return profile;
  }
}
