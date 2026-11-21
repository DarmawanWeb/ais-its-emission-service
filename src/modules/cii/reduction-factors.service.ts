import { AuditService } from '@darmawanweb/ais-its-nest/audit';
import type { Principal } from '@darmawanweb/ais-its-nest/auth';
import { Injectable } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';

import type { ReductionFactor } from '../../domain/cii.js';
import { CiiPublicationRepository } from '../segments/cii-publication.repository.js';
import { ReductionFactorsRepository } from './reduction-factors.repository.js';

/**
 * Reduction factors Z (MEPC.338(76), MEPC.400(83)): read by every CII
 * computation; a change re-rates every vessel, so all published CIIs are
 * marked for republication.
 *
 * @method cii.reduction_factor_z
 */
@Injectable()
export class ReductionFactorsService {
  constructor(
    private readonly repository: ReductionFactorsRepository,
    private readonly publication: CiiPublicationRepository,
    private readonly audit: AuditService,
  ) {}

  list(): Promise<ReductionFactor[]> {
    return this.repository.list();
  }

  /** Inserts or replaces the given years (others kept) and returns the full table. */
  async upsert(
    factors: readonly ReductionFactor[],
    principal: Principal,
    request?: FastifyRequest,
  ): Promise<ReductionFactor[]> {
    await this.repository.upsertMany(factors);
    await this.publication.markAllDirty();
    await this.audit.record(
      {
        action: 'reduction_factor.update',
        targetType: 'reduction_factor',
        targetId: null,
        meta: { years: factors.map((factor) => factor.year) },
      },
      principal,
      request,
    );
    return this.repository.list();
  }
}
