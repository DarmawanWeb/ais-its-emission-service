import { Injectable } from '@nestjs/common';

import { ReductionFactorsService } from '../cii/reduction-factors.service.js';
import { VesselProfilesRepository } from '../profiles/vessel-profiles.repository.js';
import { VESSEL_TYPE_SOURCE_METHOD_IDS } from './implemented-methods.js';
import {
  type EmissionMethodology,
  MethodologyService,
} from './methodology.service.js';

/**
 * Composes `GET /emission/methodology` (spec §17): the implemented methods
 * resolved against the contracts catalog, the active reduction factors with
 * their sources and the reference-line parameters of the vessel types of the
 * FLEET projection with the sources of those parameters.
 */
@Injectable()
export class EmissionMethodologyService {
  constructor(
    private readonly methodology: MethodologyService,
    private readonly reductionFactors: ReductionFactorsService,
    private readonly profiles: VesselProfilesRepository,
  ) {}

  async describe(): Promise<EmissionMethodology> {
    const [reductionFactors, types] = await Promise.all([
      this.reductionFactors.list(),
      this.profiles.vesselTypes(),
    ]);
    const references = this.methodology.referencesOf(
      VESSEL_TYPE_SOURCE_METHOD_IDS,
    );
    return {
      ...this.methodology.describe(),
      reductionFactors,
      vesselTypes: types.map((type) => ({ type, references })),
    };
  }
}
