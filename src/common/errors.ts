import {
  BadRequestError,
  ConflictError,
  DomainError,
  NotFoundError,
} from '@darmawanweb/ais-its-nest';

/** `404 VESSEL_NOT_FOUND`: the MMSI is not in the FLEET projection. */
export class VesselNotFoundError extends NotFoundError {
  constructor(mmsi: number) {
    super(`No vessel with MMSI ${mmsi}`, {
      code: 'VESSEL_NOT_FOUND',
      extra: { mmsi },
    });
  }
}

/** `404 CII_NOT_AVAILABLE`: no segments and no manual record (spec §15.2: no default CII). */
export class CiiNotAvailableError extends NotFoundError {
  constructor(mmsi: number, year?: number) {
    super(
      year === undefined
        ? `No CII data for vessel ${mmsi}`
        : `No CII data for vessel ${mmsi} in ${year}`,
      {
        code: 'CII_NOT_AVAILABLE',
        extra: { mmsi, ...(year === undefined ? {} : { year }) },
      },
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
    super(`No SEEMP scenario with id ${id}`, {
      code: 'SEEMP_SCENARIO_NOT_FOUND',
      extra: { id },
    });
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
    super(`No recomputation job with id ${id}`, {
      code: 'RECOMPUTE_JOB_NOT_FOUND',
      extra: { id },
    });
  }
}

/** `404 REDUCTION_FACTOR_NOT_FOUND`. */
export class ReductionFactorNotFoundError extends NotFoundError {
  constructor(year: number) {
    super(`No reduction factor (Z) is defined for ${year}`, {
      code: 'REDUCTION_FACTOR_NOT_FOUND',
      extra: { year },
    });
  }
}

/**
 * `409 REDUCTION_FACTOR_IN_USE`: CII data (segments or a manual record of
 * any vessel) exists for the year, whose figures would become unavailable
 * (`REDUCTION_FACTOR_MISSING`); correct the value with PUT instead.
 */
export class ReductionFactorInUseError extends ConflictError {
  constructor(year: number, vessels: number) {
    super(
      `${vessels} vessel(s) have CII data for ${year}; correct the value with PUT /reduction-factors instead of removing it`,
      { code: 'REDUCTION_FACTOR_IN_USE', extra: { year, vessels } },
    );
  }
}

/**
 * `409 REDUCTION_FACTOR_TABLE_GAP`: only the first or the last year of the
 * table can be removed; another year would leave a year without Z inside the
 * table, which the SEEMP cost model needs for every year up to the last one.
 */
export class ReductionFactorTableGapError extends ConflictError {
  constructor(year: number, firstYear: number, lastYear: number) {
    super(
      `Only the first (${firstYear}) or the last (${lastYear}) year can be removed; removing ${year} would leave a gap in the reduction factor table`,
      {
        code: 'REDUCTION_FACTOR_TABLE_GAP',
        extra: { year, firstYear, lastYear },
      },
    );
  }
}
