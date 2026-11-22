import {
  CII_GRADES,
  type CiiGrade,
} from '@darmawanweb/ais-its-contracts/domain';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsIn,
  IsNumber,
  IsOptional,
  IsString,
  MaxLength,
  Min,
} from 'class-validator';

import type { AnnualManualRecord } from '../annual-manual.repository.js';

const finite = { allowNaN: false, allowInfinity: false } as const;

/** `PUT /cii/vessels/:mmsi/annual-manual/:year` body (legacy AnnualCII record). */
export class PutAnnualManualDto {
  @ApiProperty({
    example: 60.40916223,
    description: 'Attained CII, g CO2 / (capacity · nm)',
  })
  @IsNumber(finite)
  @Min(0)
  readonly attained!: number;

  @ApiProperty({ example: 20300.58816, description: 'Distance, nm' })
  @IsNumber(finite)
  @Min(0)
  readonly distanceNm!: number;

  @ApiProperty({
    example: 366.831416415746,
    description: 'Main engine fuel, t',
  })
  @IsNumber(finite)
  @Min(0)
  readonly fuelMeTon!: number;

  @ApiProperty({
    example: 737.33114699565,
    description: 'Auxiliary engine fuel, t',
  })
  @IsNumber(finite)
  @Min(0)
  readonly fuelAeTon!: number;

  @ApiPropertyOptional({
    example: 65.3817582530913,
    description: 'Required CII as imported; computed from Z when omitted',
  })
  @IsOptional()
  @IsNumber(finite)
  @Min(0.000001)
  readonly required?: number;

  @ApiPropertyOptional({
    example: 0.923945208,
    description: 'Rating as imported; attained / required when omitted',
  })
  @IsOptional()
  @IsNumber(finite)
  @Min(0)
  readonly rating?: number;

  @ApiPropertyOptional({
    enum: CII_GRADES,
    description: 'Grade as imported; from the d-vector when omitted',
  })
  @IsOptional()
  @IsIn(CII_GRADES)
  readonly grade?: CiiGrade;

  @ApiPropertyOptional({ description: 'CO2, t' })
  @IsOptional()
  @IsNumber(finite)
  @Min(0)
  readonly co2Ton?: number;

  @ApiPropertyOptional({ maxLength: 2000 })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  readonly note?: string;
}

/** A manual / imported annual CII record. */
export class AnnualManualDto {
  @ApiProperty({ format: 'uuid' }) readonly vesselId: string;
  @ApiProperty({
    description: 'MMSI of the vessel when the record was written',
  })
  readonly mmsi: number;
  @ApiProperty() readonly year: number;
  @ApiProperty() readonly attained: number;
  @ApiProperty({ type: Number, nullable: true }) readonly required:
    number | null;
  @ApiProperty({ type: Number, nullable: true }) readonly rating: number | null;
  @ApiProperty({ enum: CII_GRADES, nullable: true })
  readonly grade: CiiGrade | null;
  @ApiProperty() readonly distanceNm: number;
  @ApiProperty() readonly fuelMeTon: number;
  @ApiProperty() readonly fuelAeTon: number;
  @ApiProperty({ type: Number, nullable: true }) readonly co2Ton: number | null;
  @ApiProperty({ type: String, nullable: true }) readonly note: string | null;
  @ApiProperty({ type: String, format: 'uuid', nullable: true })
  readonly updatedBy: string | null;
  @ApiProperty({ format: 'date-time' }) readonly updatedAt: string;

  constructor(record: AnnualManualRecord) {
    this.vesselId = record.vesselId;
    this.mmsi = record.mmsi;
    this.year = record.year;
    this.attained = record.attained;
    this.required = record.required;
    this.rating = record.rating;
    this.grade = record.grade;
    this.distanceNm = record.distanceNm;
    this.fuelMeTon = record.fuelMeTon;
    this.fuelAeTon = record.fuelAeTon;
    this.co2Ton = record.co2Ton;
    this.note = record.note;
    this.updatedBy = record.updatedBy;
    this.updatedAt = record.updatedAt.toISOString();
  }
}
