import { AuditService } from '@darmawanweb/ais-its-nest/audit';
import type { Principal } from '@darmawanweb/ais-its-nest/auth';
import { Injectable } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';

import {
  ReductionFactorInUseError,
  ReductionFactorNotFoundError,
  ReductionFactorTableGapError,
} from '../../common/errors.js';
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

  /**
   * Removes the factor of a year that no CII figure uses: `404
   * REDUCTION_FACTOR_NOT_FOUND`, `409 REDUCTION_FACTOR_IN_USE` (a vessel has
   * segments or a manual record that year: correct the value with PUT
   * instead) or `409 REDUCTION_FACTOR_TABLE_GAP` (only the first or the last
   * year may go: the SEEMP cost model needs Z for every year up to the last).
   * No published CII changes (no figure used the year), so nothing is
   * marked for republication.
   */
  async remove(
    year: number,
    principal: Principal,
    request?: FastifyRequest,
  ): Promise<void> {
    const result = await this.repository.removeYear(year);
    switch (result.outcome) {
      case 'not_found':
        throw new ReductionFactorNotFoundError(year);
      case 'in_use':
        throw new ReductionFactorInUseError(year, result.vessels);
      case 'gap':
        throw new ReductionFactorTableGapError(
          year,
          result.firstYear,
          result.lastYear,
        );
      case 'removed':
        break;
    }
    await this.audit.record(
      {
        action: 'reduction_factor.delete',
        targetType: 'reduction_factor',
        targetId: String(year),
        meta: { year },
      },
      principal,
      request,
    );
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
