import type { CiiGrade } from '@darmawanweb/ais-its-contracts/domain';
import { newId } from '@darmawanweb/ais-its-contracts/domain';
import { AuditService } from '@darmawanweb/ais-its-nest/audit';
import type { Principal } from '@darmawanweb/ais-its-nest/auth';
import { Injectable } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';

import {
  CiiNotAvailableError,
  IncompatibleSeempMeasuresError,
  ReductionFactorMissingError,
  SeempScenarioNotFoundError,
  UnknownSeempMeasureError,
} from '../../common/errors.js';
import { orgScopeOf } from '../../common/tenancy.js';
import {
  highestReductionFactorYear,
  type ReductionFactor,
  reductionFactorOf,
  referenceCii,
  requiredCii,
} from '../../domain/cii.js';
import {
  baselineCo2Ton,
  co2AvoidedTon,
  costPerTonneUsd,
} from '../../domain/seemp/co2.js';
import { MissingReductionFactorError } from '../../domain/seemp/cost.js';
import {
  type MeasureEvaluation,
  recommendMeasures,
} from '../../domain/seemp/recommendations.js';
import {
  IncompatibleMeasuresError,
  type SimulationResult,
  simulateMeasures,
} from '../../domain/seemp/simulation.js';
import type { SeempContext } from '../../domain/seemp/types.js';
import { CiiService, currentYear } from '../cii/cii.service.js';
import type { YearFigures } from '../cii/cii-figures.js';
import { ReductionFactorsService } from '../cii/reduction-factors.service.js';
import { VesselAccessService } from '../profiles/vessel-access.service.js';
import {
  seempVesselOf,
  type VesselProfile,
} from '../profiles/vessel-profile.js';
import {
  type StoredSeempMeasure,
  SeempMeasuresRepository,
} from './seemp-measures.repository.js';
import {
  type ScenarioListFilter,
  type SeempScenario,
  SeempScenariosRepository,
} from './seemp-scenarios.repository.js';

/** Inputs shared by the recommendations and the simulation of a vessel. */
export interface SeempSetting {
  readonly profile: VesselProfile;
  readonly context: SeempContext;
  readonly baseline: YearFigures;
  /** Rating and grade of the year before the target year (legacy `ciiRatingBefore`). */
  readonly before: { readonly rating: number; readonly grade: CiiGrade } | null;
  /** CO2 of the baseline year, t ({@link baselineCo2Ton}). */
  readonly baselineCo2Ton: number;
}

/** Recommendations of a vessel. */
export interface SeempRecommendations extends SeempSetting {
  readonly recommendations: MeasureEvaluation[];
  /** Whether measures that do not reach grade C on their own are listed. */
  readonly includeAll: boolean;
}

/** CO2 effect of a simulated combination at the baseline activity. */
export interface SimulationCo2 {
  /** CO2 avoided per year, t (negative when the attained CII rises). */
  readonly avoidedTon: number;
  /** Yearly cost per tonne avoided, USD/t; `null` when nothing is avoided. */
  readonly costPerTonneUsd: number | null;
}

/** A simulation of a vessel. */
export interface SeempSimulation extends SeempSetting {
  readonly result: SimulationResult;
  readonly co2: SimulationCo2;
}

/** Years of a SEEMP evaluation. */
export interface SeempYears {
  /** Year whose CII figures are the baseline (default: previous year, else the latest with data). */
  readonly year?: number | undefined;
  /** Year the measures are rated in (default: the current year). */
  readonly targetYear?: number | undefined;
}

/**
 * SEEMP use cases (spec §13.5) with the legacy recommender and the what-if
 * combination model; tenant-private like the CII.
 */
@Injectable()
export class SeempService {
  constructor(
    private readonly access: VesselAccessService,
    private readonly cii: CiiService,
    private readonly reductionFactors: ReductionFactorsService,
    private readonly measures: SeempMeasuresRepository,
    private readonly scenarios: SeempScenariosRepository,
    private readonly audit: AuditService,
  ) {}

  /** The measure catalog. */
  catalog(): Promise<StoredSeempMeasure[]> {
    return this.measures.list();
  }

  /**
   * `GET /seemp/vessels/:mmsi/recommendations` (legacy
   * `calculateSEEMPbyMMSI`); `includeAll` keeps the measures whose grade
   * after is D or E too.
   */
  async recommendations(
    mmsi: number,
    years: SeempYears & { readonly includeAll?: boolean | undefined },
    principal: Principal,
  ): Promise<SeempRecommendations> {
    const profile = await this.access.accessible(mmsi, principal);
    const setting = await this.setting(profile, years);
    const catalog = await this.measures.list();
    const includeAll = years.includeAll === true;
    return {
      ...setting,
      includeAll,
      recommendations: translate(() =>
        recommendMeasures(catalog, setting.context, { includeAll }),
      ),
    };
  }

  /** `POST /seemp/vessels/:mmsi/simulate`. */
  async simulate(
    mmsi: number,
    codes: readonly string[],
    years: SeempYears,
    principal: Principal,
  ): Promise<SeempSimulation> {
    const profile = await this.access.accessible(mmsi, principal);
    return this.simulateFor(profile, codes, years);
  }

  /** Saves a simulation as a scenario of the vessel's organization. */
  async createScenario(
    input: {
      readonly mmsi: number;
      readonly name: string;
      readonly measureCodes: readonly string[];
    } & SeempYears,
    principal: Principal,
    toResult: (simulation: SeempSimulation) => Record<string, unknown>,
    request?: FastifyRequest,
  ): Promise<SeempScenario> {
    const profile = await this.access.accessible(input.mmsi, principal);
    const simulation = await this.simulateFor(
      profile,
      input.measureCodes,
      input,
    );
    const scenario = await this.scenarios.insert(
      {
        id: newId(),
        orgId: profile.orgId,
        mmsi: profile.mmsi,
        vesselId: profile.vesselId,
        name: input.name,
        measureCodes: simulation.result.measures.map((measure) => measure.code),
        baselineYear: simulation.baseline.year,
        targetYear: simulation.context.currentYear,
        result: toResult(simulation),
        createdBy: principal.id,
      },
      profile.snapshot.name,
    );
    await this.audit.record(
      {
        action: 'seemp_scenario.create',
        targetType: 'seemp_scenario',
        targetId: scenario.id,
        orgId: scenario.orgId,
        meta: { mmsi: scenario.mmsi },
      },
      principal,
      request,
    );
    return scenario;
  }

  async listScenarios(
    filter: ScenarioListFilter,
    page: { readonly offset: number; readonly limit: number },
    principal: Principal,
  ): Promise<{ rows: SeempScenario[]; total: number }> {
    return this.scenarios.list(orgScopeOf(principal), filter, page);
  }

  /** `PATCH /seemp/scenarios/:id` — renames a scenario of the principal's scope (audited). */
  async renameScenario(
    id: string,
    name: string,
    principal: Principal,
    request?: FastifyRequest,
  ): Promise<SeempScenario> {
    const scenario = await this.scenarios.rename(
      id,
      name,
      orgScopeOf(principal),
    );
    if (scenario === undefined) throw new SeempScenarioNotFoundError(id);
    await this.audit.record(
      {
        action: 'seemp_scenario.update',
        targetType: 'seemp_scenario',
        targetId: id,
        orgId: scenario.orgId,
        meta: { mmsi: scenario.mmsi, name },
      },
      principal,
      request,
    );
    return scenario;
  }

  async getScenario(id: string, principal: Principal): Promise<SeempScenario> {
    const scenario = await this.scenarios.find(id, orgScopeOf(principal));
    if (scenario === undefined) throw new SeempScenarioNotFoundError(id);
    return scenario;
  }

  async deleteScenario(
    id: string,
    principal: Principal,
    request?: FastifyRequest,
  ): Promise<void> {
    const scenario = await this.scenarios.delete(id, orgScopeOf(principal));
    if (scenario === undefined) throw new SeempScenarioNotFoundError(id);
    await this.audit.record(
      {
        action: 'seemp_scenario.delete',
        targetType: 'seemp_scenario',
        targetId: id,
        orgId: scenario.orgId,
        meta: { mmsi: scenario.mmsi },
      },
      principal,
      request,
    );
  }

  private async simulateFor(
    profile: VesselProfile,
    codes: readonly string[],
    years: SeempYears,
  ): Promise<SeempSimulation> {
    const catalog = await this.measures.list();
    const byCode = new Map(catalog.map((measure) => [measure.code, measure]));
    const unknown = codes.filter((code) => !byCode.has(code));
    if (unknown.length > 0) throw new UnknownSeempMeasureError(unknown);
    const selected = codes.flatMap((code) => {
      const measure = byCode.get(code);
      return measure === undefined ? [] : [measure];
    });
    const setting = await this.setting(profile, years);
    const result = translate(() => simulateMeasures(selected, setting.context));
    const avoidedTon = co2AvoidedTon(
      setting.baselineCo2Ton,
      result.before.attained,
      result.after.attained,
    );
    return {
      ...setting,
      result,
      co2: {
        avoidedTon,
        costPerTonneUsd: costPerTonneUsd(result.costUsdPerYear, avoidedTon),
      },
    };
  }

  /**
   * The SEEMP context of a vessel: required CII of the target year, baseline
   * attained CII, fuel and distance of the baseline year, the Z table.
   */
  private async setting(
    profile: VesselProfile,
    years: SeempYears,
    now = new Date(),
  ): Promise<SeempSetting> {
    const factors = await this.reductionFactors.list();
    const targetYear = years.targetYear ?? currentYear(now);
    const z = reductionFactorOf(factors, targetYear);
    if (z === undefined) throw new ReductionFactorMissingError(targetYear);
    const baseline = await this.baseline(
      profile,
      years.year,
      targetYear,
      factors,
    );
    const vessel = seempVesselOf(profile.snapshot);
    const previous = await this.cii.yearFigures(
      profile,
      targetYear - 1,
      factors,
    );
    return {
      profile,
      baseline,
      baselineCo2Ton: baselineCo2Ton(
        baseline,
        profile.snapshot.fuel.conversionFactor,
      ),
      before:
        previous === undefined ||
        previous.rating === null ||
        previous.grade === null
          ? null
          : { rating: previous.rating, grade: previous.grade },
      context: {
        vessel,
        ciiRequired: requiredCii(
          z,
          referenceCii(vessel.referenceLine, vessel.capacity),
        ),
        ciiAttained: baseline.attained,
        annual: {
          fuelMeTon: baseline.fuelMeTon,
          fuelAeTon: baseline.fuelAeTon,
          distanceNm: baseline.distanceNm,
        },
        currentYear: targetYear,
        highestYear: highestReductionFactorYear(factors),
        zOf: (year) => reductionFactorOf(factors, year),
      },
    };
  }

  /** The baseline year figures: the requested year, else the previous year, else the latest year with data. */
  private async baseline(
    profile: VesselProfile,
    requested: number | undefined,
    targetYear: number,
    factors: readonly ReductionFactor[],
  ): Promise<YearFigures> {
    if (requested !== undefined) {
      const figures = await this.cii.yearFigures(profile, requested, factors);
      if (figures === undefined)
        throw new CiiNotAvailableError(profile.mmsi, requested);
      return figures;
    }
    const previous = await this.cii.yearFigures(
      profile,
      targetYear - 1,
      factors,
    );
    if (previous !== undefined) return previous;
    const years = (await this.cii.yearsWithData(profile)).filter(
      (year) => year <= targetYear,
    );
    const latest = years.at(-1);
    const figures =
      latest === undefined
        ? undefined
        : await this.cii.yearFigures(profile, latest, factors);
    if (figures === undefined) throw new CiiNotAvailableError(profile.mmsi);
    return figures;
  }
}

/** Maps the domain errors of the SEEMP models to problem details. */
function translate<T>(run: () => T): T {
  try {
    return run();
  } catch (error) {
    if (error instanceof MissingReductionFactorError)
      throw new ReductionFactorMissingError(error.year, error);
    if (error instanceof IncompatibleMeasuresError)
      throw new IncompatibleSeempMeasuresError(error.codes, error);
    throw error;
  }
}
