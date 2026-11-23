import {
  CII_GRADES,
  type CiiGrade,
} from '@darmawanweb/ais-its-contracts/domain';
import {
  IsOptionalNotNull,
  PageMetaDto,
  PageQueryDto,
} from '@darmawanweb/ais-its-nest/http';
import {
  ApiProperty,
  ApiPropertyOptional,
  type ApiPropertyOptions,
  OmitType,
} from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  ArrayUnique,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Length,
  Matches,
  Max,
  Min,
} from 'class-validator';

import { VesselIdentityDto } from '../../../common/dto.js';
import {
  booleanQuery,
  signedSortKeys,
  trimString,
} from '../../../common/query.js';
import {
  isRecommended,
  type MeasureEvaluation,
  toLegacyRecommendation,
} from '../../../domain/seemp/recommendations.js';
import type { StoredSeempMeasure } from '../seemp-measures.repository.js';
import {
  SCENARIO_SORT_KEYS,
  type ScenarioSort,
  type SeempScenario,
} from '../seemp-scenarios.repository.js';
import type {
  SeempRecommendations,
  SeempSimulation,
} from '../seemp.service.js';

const METHOD_IDS_PROPERTY: ApiPropertyOptions = {
  type: [String],
  description: 'Methodology catalog ids behind the figure',
};

/** Optional years of a SEEMP evaluation. */
export class SeempYearsQuery {
  @ApiPropertyOptional({
    minimum: 2000,
    maximum: 2200,
    description:
      'Baseline year (default: previous year, else the latest year with data)',
  })
  // Never null: also a body (simulate), where null would mean no year.
  @IsOptionalNotNull()
  @Type(() => Number)
  @IsInt()
  @Min(2000)
  @Max(2200)
  readonly year?: number;

  @ApiPropertyOptional({
    minimum: 2000,
    maximum: 2200,
    description: 'Year the measures are rated in (default: current year)',
  })
  // Never null: also a body (simulate), where null would mean no year.
  @IsOptionalNotNull()
  @Type(() => Number)
  @IsInt()
  @Min(2000)
  @Max(2200)
  readonly targetYear?: number;
}

/** `GET /seemp/vessels/:mmsi/recommendations?year&targetYear&includeAll`. */
export class SeempRecommendationsQuery extends SeempYearsQuery {
  @ApiPropertyOptional({
    type: Boolean,
    default: false,
    description:
      'Also list the measures whose grade after is D or E (not enough on their own); `recommended` tells them apart. Default: only grades A–C (legacy filter)',
  })
  @IsOptional()
  @Transform(booleanQuery)
  @IsBoolean()
  readonly includeAll?: boolean;
}

/** `POST /seemp/vessels/:mmsi/simulate` body. */
export class SimulateDto extends SeempYearsQuery {
  @ApiProperty({
    type: [String],
    example: ['hull_coating', 'solar'],
    minItems: 1,
    maxItems: 12,
  })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(12)
  @ArrayUnique()
  @IsString({ each: true })
  @Matches(/^[a-z][a-z0-9_]*$/, { each: true })
  readonly measureCodes!: string[];
}

/** `POST /seemp/scenarios` body. */
export class CreateScenarioDto extends SimulateDto {
  @ApiProperty({ example: 525005223 })
  @IsInt()
  @Min(100_000_000)
  @Max(999_999_999)
  readonly mmsi!: number;

  @ApiProperty({
    minLength: 1,
    maxLength: 120,
    example: 'Hull coating + solar 2026',
  })
  @IsString()
  @Length(1, 120)
  readonly name!: string;
}

const SCENARIO_SORTS = signedSortKeys(SCENARIO_SORT_KEYS);

/** `GET /seemp/scenarios?mmsi&search&sort&page&pageSize`. */
export class ListScenariosQuery extends PageQueryDto {
  @ApiPropertyOptional({ example: 525005223 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(100_000_000)
  @Max(999_999_999)
  readonly mmsi?: number;

  @ApiPropertyOptional({
    maxLength: 120,
    description:
      'Scenario or vessel name (case-insensitive substring), or MMSI (prefix of digits)',
  })
  @IsOptional()
  @Transform(trimString)
  @IsString()
  @Length(1, 120)
  readonly search?: string;

  @ApiPropertyOptional({
    enum: SCENARIO_SORTS,
    default: '-createdAt',
    description:
      'Order; a leading `-` sorts descending (default newest first); ties newest first. Scenarios of vessels no longer known come last by vesselName',
  })
  @IsOptional()
  @IsIn(SCENARIO_SORTS)
  readonly sort: ScenarioSort = '-createdAt';
}

/** `PATCH /seemp/scenarios/:id` body. */
export class RenameScenarioDto {
  @ApiProperty({
    minLength: 1,
    maxLength: 120,
    example: 'Hull coating + solar 2026 (revised)',
  })
  @IsString()
  @Length(1, 120)
  readonly name!: string;
}

/** A measure of the catalog. */
export class SeempMeasureDto {
  @ApiProperty({ example: 'hull_coating' }) readonly code: string;
  @ApiProperty({
    example: 'Hull coating maintenance on the hull surface',
    description: 'Exactly the legacy recommendation text',
  })
  readonly name: string;
  @ApiProperty({ enum: ['technical', 'operational', 'fuel', 'energy'] })
  readonly category: string;
  @ApiProperty() readonly legacyOrder: number;
  @ApiProperty({ example: 'seemp.measure.hull_coating' })
  readonly methodId: string;
  @ApiProperty({
    type: 'object',
    additionalProperties: true,
    description: 'Reduction model (type operational | fuel_switch | auxiliary)',
  })
  readonly reduction: Record<string, unknown>;
  @ApiProperty({
    type: 'object',
    additionalProperties: true,
    description:
      'Cost model (type loa_bands | range | wetted_surface | installed_power)',
  })
  readonly cost: Record<string, unknown>;
  @ApiProperty() readonly source: string;

  constructor(measure: StoredSeempMeasure) {
    this.code = measure.code;
    this.name = measure.name;
    this.category = measure.category;
    this.legacyOrder = measure.legacyOrder;
    this.methodId = measure.methodId;
    this.reduction = { ...measure.reduction };
    this.cost = { ...measure.cost };
    this.source = measure.source;
  }
}

/** `GET /seemp/measures`. */
export class SeempMeasureListDto {
  @ApiProperty({ type: [SeempMeasureDto] }) readonly data: SeempMeasureDto[];

  constructor(measures: readonly StoredSeempMeasure[]) {
    this.data = measures.map((measure) => new SeempMeasureDto(measure));
  }
}

/** Low and high cost per year, USD. */
export class CostRangeDto {
  @ApiProperty() readonly low: number;
  @ApiProperty() readonly high: number;

  constructor(range: { readonly low: number; readonly high: number }) {
    this.low = range.low;
    this.high = range.high;
  }
}

/** A recommendation: the legacy item (`calculateSEEMPbyMMSI`) plus v2 members. */
export class SeempRecommendationDto {
  @ApiProperty({ example: 'Hull coating maintenance on the hull surface' })
  readonly recommendation: string;
  @ApiProperty({
    example: '$30,540',
    description: 'Cost per year (legacy text; "$low - $high" for ranges)',
  })
  readonly cost: string;
  @ApiProperty({
    example: 0.92524288,
    description: 'Rating after the measure, 8 decimals',
  })
  readonly ciiRatingAfter: number;
  @ApiProperty({ enum: CII_GRADES }) readonly ciiGradeAfter: CiiGrade;
  @ApiProperty({
    type: Number,
    nullable: true,
    description: 'Rating of the year before the target year',
  })
  readonly ciiRatingBefore: number | null;
  @ApiProperty({ enum: CII_GRADES, nullable: true })
  readonly ciiGradeBefore: CiiGrade | null;
  @ApiProperty({ example: 'hull_coating' }) readonly code: string;
  @ApiProperty({ description: 'Cost per year, USD (sort key)' })
  readonly costUsdPerYear: number;
  @ApiProperty({ type: CostRangeDto })
  readonly costRangeUsdPerYear: CostRangeDto;
  @ApiProperty({ description: 'Attained CII after the measure' })
  readonly ciiAttainedAfter: number;
  @ApiProperty({
    description: 'Years until grade D/E used to spread the investment',
  })
  readonly yearsUntilInferior: number;
  @ApiProperty({
    description:
      'Grade after is A–C (the legacy recommendation); false only with includeAll=true',
  })
  readonly recommended: boolean;
  @ApiProperty(METHOD_IDS_PROPERTY) readonly methodIds: string[];

  constructor(
    evaluation: MeasureEvaluation,
    before: SeempRecommendations['before'],
  ) {
    const legacy = toLegacyRecommendation(evaluation, before);
    this.recommendation = legacy.recommendation;
    this.cost = legacy.cost;
    this.ciiRatingAfter = legacy.ciiRatingAfter;
    this.ciiGradeAfter = legacy.ciiGradeAfter;
    this.ciiRatingBefore = legacy.ciiRatingBefore;
    this.ciiGradeBefore = legacy.ciiGradeBefore;
    this.code = evaluation.measure.code;
    this.costUsdPerYear = evaluation.cost;
    this.costRangeUsdPerYear = new CostRangeDto(evaluation.costRange);
    this.ciiAttainedAfter = evaluation.ciiAttainedAfter;
    this.yearsUntilInferior = evaluation.yearsUntilInferior;
    this.recommended = isRecommended(evaluation);
    this.methodIds = [...evaluation.methodIds];
  }
}

/** Baseline of a SEEMP evaluation. */
abstract class SeempSettingDto {
  @ApiProperty() readonly mmsi: number;
  @ApiProperty({ format: 'uuid' }) readonly vesselId: string;
  @ApiProperty({
    type: VesselIdentityDto,
    description: 'Identity of the vessel (FLEET projection)',
  })
  readonly vessel: VesselIdentityDto;
  @ApiProperty({ description: 'Year of the baseline CII figures' })
  readonly baselineYear: number;
  @ApiProperty({ enum: ['segments', 'manual'] }) readonly baselineSource:
    'segments' | 'manual';
  @ApiProperty({ description: 'Year the measures are rated in' })
  readonly targetYear: number;
  @ApiProperty({ description: 'Required CII of the target year' })
  readonly ciiRequired: number;
  @ApiProperty({ description: 'Baseline attained CII' })
  readonly ciiAttained: number;
  @ApiProperty({ type: Number, nullable: true }) readonly ciiRatingBefore:
    number | null;
  @ApiProperty({ enum: CII_GRADES, nullable: true })
  readonly ciiGradeBefore: CiiGrade | null;
  @ApiProperty({
    description:
      'CO2 of the baseline year, t (a manual record without CO2: its fuel × C_F of the current fuel)',
  })
  readonly baselineCo2Ton: number;

  protected constructor(setting: SeempRecommendations | SeempSimulation) {
    this.mmsi = setting.profile.mmsi;
    this.vesselId = setting.profile.vesselId;
    this.vessel = new VesselIdentityDto(setting.profile);
    this.baselineCo2Ton = setting.baselineCo2Ton;
    this.baselineYear = setting.baseline.year;
    this.baselineSource = setting.baseline.source;
    this.targetYear = setting.context.currentYear;
    this.ciiRequired = setting.context.ciiRequired;
    this.ciiAttained = setting.context.ciiAttained;
    this.ciiRatingBefore = setting.before?.rating ?? null;
    this.ciiGradeBefore = setting.before?.grade ?? null;
  }
}

/** `GET /seemp/vessels/:mmsi/recommendations`. */
export class SeempRecommendationsDto extends SeempSettingDto {
  @ApiProperty({
    type: [SeempRecommendationDto],
    description:
      'Measures with grade A–C after (with includeAll: every measure), cheapest first',
  })
  readonly recommendations: SeempRecommendationDto[];
  @ApiProperty({ description: 'Whether includeAll was requested' })
  readonly includeAll: boolean;
  @ApiProperty(METHOD_IDS_PROPERTY) readonly methodIds: string[];

  constructor(result: SeempRecommendations) {
    super(result);
    this.includeAll = result.includeAll;
    this.recommendations = result.recommendations.map(
      (evaluation) => new SeempRecommendationDto(evaluation, result.before),
    );
    this.methodIds = [
      ...new Set([
        ...result.baseline.methodIds,
        'seemp.filter_sort_output',
        ...this.recommendations.flatMap((item) => item.methodIds),
      ]),
    ];
  }
}

/** Attained CII, rating and grade. */
export class RatedCiiDto {
  @ApiProperty() readonly attained: number;
  @ApiProperty() readonly rating: number;
  @ApiProperty({ enum: CII_GRADES }) readonly grade: CiiGrade;

  constructor(value: {
    readonly attained: number;
    readonly rating: number;
    readonly grade: CiiGrade;
  }) {
    this.attained = value.attained;
    this.rating = value.rating;
    this.grade = value.grade;
  }
}

/** Annual fuel after the fuel-side measures. */
export class FuelAfterDto {
  @ApiProperty({ description: 't' }) readonly meTon: number;
  @ApiProperty({ description: 't' }) readonly aeTon: number;
  @ApiProperty({ description: 'C_F after a fuel switch, t CO2 / t fuel' })
  readonly conversionFactor: number;

  constructor(value: SeempSimulation['result']['fuelAfter']) {
    this.meTon = value.meTon;
    this.aeTon = value.aeTon;
    this.conversionFactor = value.conversionFactor;
  }
}

/** `POST /seemp/vessels/:mmsi/simulate`. */
export class SeempSimulationDto extends SeempSettingDto {
  @ApiProperty({
    type: [String],
    description: 'Measures applied, in legacy order',
  })
  readonly measureCodes: string[];
  @ApiProperty({ type: RatedCiiDto }) readonly before: RatedCiiDto;
  @ApiProperty({ type: RatedCiiDto }) readonly after: RatedCiiDto;
  @ApiProperty({ description: '1 − after / before, percent' })
  readonly reductionPercent: number;
  @ApiProperty({ type: FuelAfterDto }) readonly fuelAfter: FuelAfterDto;
  @ApiProperty() readonly yearsUntilInferior: number;
  @ApiProperty({ description: 'Total cost per year of the measures, USD' })
  readonly costUsdPerYear: number;
  @ApiProperty({ type: CostRangeDto })
  readonly costRangeUsdPerYear: CostRangeDto;
  @ApiProperty({ example: '$154,040' }) readonly cost: string;
  @ApiProperty({
    description:
      'CO2 avoided per year at the baseline distance, t: baselineCo2Ton × reductionPercent / 100 (negative when the attained CII rises)',
  })
  readonly co2AvoidedTon: number;
  @ApiProperty({
    type: Number,
    nullable: true,
    description:
      'costUsdPerYear / co2AvoidedTon, USD per tonne of CO2 avoided; null when nothing is avoided',
  })
  readonly costPerTonneUsd: number | null;
  @ApiProperty(METHOD_IDS_PROPERTY) readonly methodIds: string[];

  constructor(simulation: SeempSimulation) {
    super(simulation);
    const { result } = simulation;
    this.measureCodes = result.measures.map((measure) => measure.code);
    this.before = new RatedCiiDto(result.before);
    this.after = new RatedCiiDto(result.after);
    this.reductionPercent = result.reductionPercent;
    this.fuelAfter = new FuelAfterDto(result.fuelAfter);
    this.yearsUntilInferior = result.yearsUntilInferior;
    this.costUsdPerYear = result.costUsdPerYear;
    this.costRangeUsdPerYear = new CostRangeDto(result.costRange);
    this.cost = result.costDisplay;
    this.co2AvoidedTon = simulation.co2.avoidedTon;
    this.costPerTonneUsd = simulation.co2.costPerTonneUsd;
    this.methodIds = [
      ...new Set([...simulation.baseline.methodIds, ...result.methodIds]),
    ];
  }
}

/** Fields of {@link SeempSimulationDto} added in 0.2.0. */
const SIMULATION_FIELDS_SINCE_0_2 = [
  'vessel',
  'baselineCo2Ton',
  'co2AvoidedTon',
  'costPerTonneUsd',
] as const;
/** Note of the fields a scenario saved before 0.2.0 does not have. */
const ABSENT_BEFORE_0_2 = 'absent in scenarios saved before 0.2.0';

/**
 * `result` of a saved scenario: the simulation response at creation time,
 * stored as it was and never recomputed. Scenarios saved by 0.1.x lack the
 * fields added in 0.2.0, so these are optional here (they are present in
 * every scenario saved since).
 */
export class SeempScenarioResultDto extends OmitType(
  SeempSimulationDto,
  SIMULATION_FIELDS_SINCE_0_2,
) {
  @ApiPropertyOptional({
    type: VesselIdentityDto,
    description: `Identity of the vessel at creation time (FLEET projection); ${ABSENT_BEFORE_0_2}`,
  })
  readonly vessel?: VesselIdentityDto;
  @ApiPropertyOptional({
    description: `CO2 of the baseline year, t; ${ABSENT_BEFORE_0_2}`,
  })
  readonly baselineCo2Ton?: number;
  @ApiPropertyOptional({
    description: `CO2 avoided per year at the baseline distance, t; ${ABSENT_BEFORE_0_2}`,
  })
  readonly co2AvoidedTon?: number;
  @ApiPropertyOptional({
    type: Number,
    nullable: true,
    description: `USD per tonne of CO2 avoided (null when nothing is avoided); ${ABSENT_BEFORE_0_2}`,
  })
  readonly costPerTonneUsd?: number | null;
}

/** A saved simulation. */
export class SeempScenarioDto {
  @ApiProperty({ format: 'uuid' }) readonly id: string;
  @ApiProperty() readonly mmsi: number;
  @ApiProperty({ format: 'uuid' }) readonly vesselId: string;
  @ApiProperty({
    type: String,
    nullable: true,
    description:
      'Current name of the vessel (FLEET projection); null once the vessel is no longer known',
  })
  readonly vesselName: string | null;
  @ApiProperty() readonly name: string;
  @ApiProperty({ type: [String] }) readonly measureCodes: string[];
  @ApiProperty() readonly baselineYear: number;
  @ApiProperty() readonly targetYear: number;
  @ApiProperty({
    type: SeempScenarioResultDto,
    description:
      'The simulation response at creation time, stored as it was (not recomputed): scenarios saved before 0.2.0 lack vessel, baselineCo2Ton, co2AvoidedTon and costPerTonneUsd',
  })
  readonly result: Record<string, unknown>;
  @ApiProperty({ format: 'uuid' }) readonly createdBy: string;
  @ApiProperty({ format: 'date-time' }) readonly createdAt: string;
  @ApiProperty({
    format: 'date-time',
    description: 'Last change (creation or rename)',
  })
  readonly updatedAt: string;

  constructor(scenario: SeempScenario) {
    this.id = scenario.id;
    this.mmsi = scenario.mmsi;
    this.vesselId = scenario.vesselId;
    this.vesselName = scenario.vesselName;
    this.name = scenario.name;
    this.measureCodes = scenario.measureCodes;
    this.baselineYear = scenario.baselineYear;
    this.targetYear = scenario.targetYear;
    this.result = scenario.result;
    this.createdBy = scenario.createdBy;
    this.createdAt = scenario.createdAt.toISOString();
    this.updatedAt = scenario.updatedAt.toISOString();
  }
}

/** `GET /seemp/scenarios` page. */
export class SeempScenarioPageDto {
  @ApiProperty({ type: [SeempScenarioDto] }) readonly data: SeempScenarioDto[];
  @ApiProperty({ type: PageMetaDto }) readonly meta: PageMetaDto;

  constructor(data: SeempScenarioDto[], meta: PageMetaDto) {
    this.data = data;
    this.meta = meta;
  }
}
