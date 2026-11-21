import type { LocalizedText } from '@darmawanweb/ais-its-contracts/domain';
import {
  METHOD_DOMAINS,
  METHOD_STATUSES,
  type MethodConstant,
  type MethodDomain,
  type MethodStatus,
  type MethodVariable,
  type Reference,
} from '@darmawanweb/ais-its-contracts/references';
import { ApiProperty } from '@nestjs/swagger';

import { DdVectorDto } from '../../common/dto.js';
import { ReductionFactorDto } from '../cii/dto/reduction-factor.dto.js';
import type {
  EmissionMethodology,
  ImplementedMethod,
  MethodologyDescription,
  VesselTypeSource,
} from './methodology.service.js';

/** A text in every supported locale. */
export class LocalizedTextDto {
  @ApiProperty({ description: 'Bahasa Indonesia' })
  readonly id: string;

  @ApiProperty({ description: 'English' })
  readonly en: string;

  constructor(text: LocalizedText) {
    this.id = text.id;
    this.en = text.en;
  }
}

/** A source of a method. */
export class MethodReferenceDto {
  @ApiProperty({ example: 'imo-mepc-352-78' })
  readonly id: string;

  @ApiProperty()
  readonly title: string;

  @ApiProperty({ type: String, nullable: true, format: 'uri' })
  readonly url: string | null;

  constructor(reference: Reference) {
    this.id = reference.id;
    this.title = reference.title;
    this.url = reference.url;
  }
}

/** A variable of a method. */
export class MethodVariableDto {
  @ApiProperty({ example: 'V_{kn}' })
  readonly symbol: string;

  @ApiProperty({ type: LocalizedTextDto })
  readonly name: LocalizedTextDto;

  @ApiProperty({ type: String, nullable: true, example: 'kn' })
  readonly unit: string | null;

  constructor(variable: MethodVariable) {
    this.symbol = variable.symbol;
    this.name = new LocalizedTextDto(variable.name);
    this.unit = variable.unit ?? null;
  }
}

/** A constant, coefficient or threshold of a method. */
export class MethodConstantDto {
  @ApiProperty({ example: 'q_{min}' })
  readonly symbol: string;

  @ApiProperty({ type: LocalizedTextDto })
  readonly name: LocalizedTextDto;

  @ApiProperty({ oneOf: [{ type: 'number' }, { type: 'string' }], example: 0.5 })
  readonly value: number | string;

  @ApiProperty({ type: String, nullable: true })
  readonly unit: string | null;

  @ApiProperty({ type: [String] })
  readonly referenceIds: string[];

  @ApiProperty()
  readonly needsCitation: boolean;

  constructor(constant: MethodConstant) {
    this.symbol = constant.symbol;
    this.name = new LocalizedTextDto(constant.name);
    this.value = constant.value;
    this.unit = constant.unit ?? null;
    this.referenceIds = [...constant.referenceIds];
    this.needsCitation = constant.needsCitation;
  }
}

/** A method implemented by the service, resolved against the catalog. */
export class MethodSummaryDto {
  @ApiProperty({ example: 'cii.attained' })
  readonly id: string;

  @ApiProperty({
    description:
      'Whether the catalog shipped with @darmawanweb/ais-its-contracts describes the method',
  })
  readonly catalogued: boolean;

  @ApiProperty({ enum: METHOD_DOMAINS, nullable: true })
  readonly domain: MethodDomain | null;

  @ApiProperty({ type: LocalizedTextDto, nullable: true })
  readonly name: LocalizedTextDto | null;

  @ApiProperty({ enum: METHOD_STATUSES, nullable: true })
  readonly status: MethodStatus | null;

  @ApiProperty({
    description:
      'Values come from the thesis without a verified external source',
  })
  readonly needsCitation: boolean;

  @ApiProperty({ type: [MethodReferenceDto] })
  readonly references: MethodReferenceDto[];

  @ApiProperty({ type: LocalizedTextDto, nullable: true })
  readonly summary: LocalizedTextDto | null;

  @ApiProperty({ type: String, nullable: true, description: 'Equation in LaTeX (KaTeX)' })
  readonly formulaLatex: string | null;

  @ApiProperty({ type: [MethodVariableDto] })
  readonly variables: MethodVariableDto[];

  @ApiProperty({ type: [MethodConstantDto] })
  readonly constants: MethodConstantDto[];

  @ApiProperty({ type: [String], example: ['imo-mepc-352-78'] })
  readonly referenceIds: string[];

  constructor({ id, method, references }: ImplementedMethod) {
    this.id = id;
    this.catalogued = method !== undefined;
    this.domain = method?.domain ?? null;
    this.name = method === undefined ? null : new LocalizedTextDto(method.name);
    this.status = method?.status ?? null;
    this.needsCitation = method?.needsCitation ?? false;
    this.references = references.map(
      (reference) => new MethodReferenceDto(reference),
    );
    this.summary = method === undefined ? null : new LocalizedTextDto(method.summary);
    this.formulaLatex = method?.formulaLatex ?? null;
    this.variables = (method?.variables ?? []).map((variable) => new MethodVariableDto(variable));
    this.constants = (method?.constants ?? []).map((constant) => new MethodConstantDto(constant));
    this.referenceIds = [...(method?.referenceIds ?? [])];
  }
}

/** `GET /emission/methodology`. */
export class MethodologyDto {
  @ApiProperty({ example: 'emission' })
  readonly service: string;

  @ApiProperty({ type: [MethodSummaryDto] })
  readonly methods: MethodSummaryDto[];

  constructor(description: MethodologyDescription) {
    this.service = description.service;
    this.methods = description.methods.map(
      (method) => new MethodSummaryDto(method),
    );
  }
}

/** A vessel type of the FLEET projection with its CII parameters and their sources. */
export class VesselTypeParametersDto {
  @ApiProperty({ format: 'uuid' })
  readonly id: string;

  @ApiProperty({ example: 'ropax' })
  readonly code: string;

  @ApiProperty({ example: 'Ro-ro Passenger Ship' })
  readonly name: string;

  @ApiProperty({ enum: ['DWT', 'GT'] })
  readonly capacityUnit: string;

  @ApiProperty({ description: 'Reference line parameter a (MEPC.353(78))', example: 7540 })
  readonly a: number;

  @ApiProperty({ description: 'Reference line parameter c (MEPC.353(78))', example: 0.587 })
  readonly c: number;

  @ApiProperty({ type: Number, nullable: true, description: 'Regulation-fixed capacity of the size band' })
  readonly capacityFixed: number | null;

  @ApiProperty({ type: DdVectorDto, description: 'Rating vector (MEPC.354(78))' })
  readonly d: DdVectorDto;

  @ApiProperty({ type: [MethodReferenceDto], description: 'Sources of the reference lines and rating vectors' })
  readonly references: MethodReferenceDto[];

  constructor({ type, references }: VesselTypeSource) {
    this.id = type.id;
    this.code = type.code;
    this.name = type.name;
    this.capacityUnit = type.capacityUnit;
    this.a = type.a;
    this.c = type.c;
    this.capacityFixed = type.capacityFixed ?? null;
    this.d = new DdVectorDto(type.d);
    this.references = references.map((reference) => new MethodReferenceDto(reference));
  }
}

/** `GET /emission/methodology` (spec §17). */
export class EmissionMethodologyDto extends MethodologyDto {
  @ApiProperty({ type: [ReductionFactorDto], description: 'Active reduction factors Z with their sources' })
  readonly reductionFactors: ReductionFactorDto[];

  @ApiProperty({ type: [VesselTypeParametersDto] })
  readonly vesselTypes: VesselTypeParametersDto[];

  @ApiProperty({ example: 'Weather data by Open-Meteo.com (CC BY 4.0)' })
  readonly attribution: string;

  constructor(description: EmissionMethodology) {
    super(description);
    this.reductionFactors = description.reductionFactors.map((factor) => new ReductionFactorDto(factor));
    this.vesselTypes = description.vesselTypes.map((type) => new VesselTypeParametersDto(type));
    this.attribution = 'Weather data by Open-Meteo.com (CC BY 4.0)';
  }
}
