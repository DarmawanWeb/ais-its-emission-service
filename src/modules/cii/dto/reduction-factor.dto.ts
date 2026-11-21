import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsInt,
  IsNumber,
  IsString,
  Length,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';

import type { ReductionFactor } from '../../../domain/cii.js';

/** A reduction factor Z of a year. */
export class ReductionFactorDto {
  @ApiProperty({ example: 2026 }) readonly year: number;
  @ApiProperty({ example: 11, description: 'Z, percent' })
  readonly zPercent: number;
  @ApiProperty({
    example: 'IMO Resolution MEPC.338(76) (2021), G3 reduction factors',
  })
  readonly source: string;

  constructor(factor: ReductionFactor) {
    this.year = factor.year;
    this.zPercent = factor.zPercent;
    this.source = factor.source;
  }
}

/** `GET/PUT /reduction-factors`. */
export class ReductionFactorListDto {
  @ApiProperty({ type: [ReductionFactorDto] })
  readonly data: ReductionFactorDto[];

  constructor(factors: readonly ReductionFactor[]) {
    this.data = factors.map((factor) => new ReductionFactorDto(factor));
  }
}

/** A reduction factor to set. */
export class ReductionFactorInputDto {
  @ApiProperty({ minimum: 2019, maximum: 2100, example: 2031 })
  @IsInt()
  @Min(2019)
  @Max(2100)
  readonly year!: number;

  @ApiProperty({
    minimum: 0,
    maximum: 99.999,
    example: 24.125,
    description: 'Z, percent',
  })
  @IsNumber({ allowNaN: false, allowInfinity: false })
  @Min(0)
  @Max(99.999)
  readonly zPercent!: number;

  @ApiProperty({
    minLength: 1,
    maxLength: 500,
    example: 'IMO Resolution MEPC.400(83)',
  })
  @IsString()
  @Length(1, 500)
  readonly source!: string;
}

/** `PUT /reduction-factors` body: years to insert or replace (other years are kept). */
export class PutReductionFactorsDto {
  @ApiProperty({ type: [ReductionFactorInputDto] })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(100)
  @ValidateNested({ each: true })
  @Type(() => ReductionFactorInputDto)
  readonly items!: ReductionFactorInputDto[];
}
