import {
  BadRequestError,
  ConflictError,
  DomainError,
  ForbiddenError,
  NotFoundError,
} from '@darmawanweb/ais-its-nest';

/** `404 VESSEL_NOT_FOUND`: the MMSI is not in the FLEET projection. */
export class VesselNotFoundError extends NotFoundError {
  constructor(mmsi: number) {
    super(`No vessel with MMSI ${mmsi}`, { code: 'VESSEL_NOT_FOUND', extra: { mmsi } });
  }
}

/** `404 CII_NOT_AVAILABLE`: no segments and no manual record (spec §15.2: no default CII). */
export class CiiNotAvailableError extends NotFoundError {
  constructor(mmsi: number, year?: number) {
    super(
      year === undefined ? `No CII data for vessel ${mmsi}` : `No CII data for vessel ${mmsi} in ${year}`,
      { code: 'CII_NOT_AVAILABLE', extra: { mmsi, ...(year === undefined ? {} : { year }) } },
    );
  }
}

/** `422 REDUCTION_FACTOR_MISSING`: a year without a reduction factor Z was needed. */
export class ReductionFactorMissingError extends DomainError {
  constructor(year: number, cause?: unknown) {
    super('REDUCTION_FACTOR_MISSING', {
      status: 422,
      title: 'Reduction factor missing',
      detail: `No reduction factor (Z) is defined for ${year}; add it with PUT /reduction-factors`,
      extra: { year },
      cause,
    });
  }
}

/** `404 CII_ANNUAL_MANUAL_NOT_FOUND`. */
export class AnnualManualNotFoundError extends NotFoundError {
  constructor(mmsi: number, year: number) {
    super(`No manual annual CII of vessel ${mmsi} for ${year}`, {
      code: 'CII_ANNUAL_MANUAL_NOT_FOUND',
      extra: { mmsi, year },
    });
  }
}

/** `422 SEEMP_MEASURE_UNKNOWN`: a measure code that is not in the catalog. */
export class UnknownSeempMeasureError extends DomainError {
  constructor(codes: readonly string[]) {
    super('SEEMP_MEASURE_UNKNOWN', {
      status: 422,
      title: 'Unknown SEEMP measure',
      detail: `Unknown SEEMP measure code(s): ${codes.join(', ')}`,
      extra: { codes },
    });
  }
}

/** `422 SEEMP_MEASURES_INCOMPATIBLE`: e.g. two fuel switches in one simulation. */
export class IncompatibleSeempMeasuresError extends DomainError {
  constructor(codes: readonly string[], cause?: unknown) {
    super('SEEMP_MEASURES_INCOMPATIBLE', {
      status: 422,
      title: 'Incompatible SEEMP measures',
      detail: `Measures ${codes.join(', ')} cannot be combined (at most one fuel switch)`,
      extra: { codes },
      cause,
    });
  }
}

/** `404 SEEMP_SCENARIO_NOT_FOUND`. */
export class SeempScenarioNotFoundError extends NotFoundError {
  constructor(id: string) {
    super(`No SEEMP scenario with id ${id}`, { code: 'SEEMP_SCENARIO_NOT_FOUND', extra: { id } });
  }
}

/** `400 RECOMPUTE_RANGE_INVALID`. */
export class RecomputeRangeError extends BadRequestError {
  constructor(detail: string) {
    super(detail, { code: 'RECOMPUTE_RANGE_INVALID' });
  }
}

/** `409 RECOMPUTE_IN_PROGRESS`: one recomputation per vessel at a time. */
export class RecomputeInProgressError extends ConflictError {
  constructor(mmsi: number) {
    super(`A recomputation of vessel ${mmsi} is already running`, {
      code: 'RECOMPUTE_IN_PROGRESS',
      extra: { mmsi },
    });
  }
}

/** `404 RECOMPUTE_JOB_NOT_FOUND`. */
export class RecomputeJobNotFoundError extends NotFoundError {
  constructor(id: string) {
    super(`No recomputation job with id ${id}`, { code: 'RECOMPUTE_JOB_NOT_FOUND', extra: { id } });
  }
}

/** `403 SUPER_ADMIN_REQUIRED`. */
export class SuperAdminRequiredError extends ForbiddenError {
  constructor() {
    super('Only platform administrators may do this', { code: 'SUPER_ADMIN_REQUIRED' });
  }
}
