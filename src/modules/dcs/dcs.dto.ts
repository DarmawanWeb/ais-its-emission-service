import { ApiProperty } from '@nestjs/swagger';

import type { DcsFuelLine, DcsSummary } from '../../domain/dcs.js';

/** Fuel per fuel type. */
export class DcsFuelLineDto {
  @ApiProperty({ example: 'MDO' }) readonly fuelCode: string;
  @ApiProperty({ example: 'Diesel/Gas Oil' }) readonly fuelName: string;
  @ApiProperty({ description: 'C_F, t CO2 / t fuel' })
  readonly conversionFactor: number;
  @ApiProperty({ description: 't' }) readonly fuelMeTon: number;
  @ApiProperty({ description: 't' }) readonly fuelAeTon: number;
  @ApiProperty({ description: 't' }) readonly totalTon: number;
  @ApiProperty({ description: 't' }) readonly co2Ton: number;

  constructor(line: DcsFuelLine) {
    this.fuelCode = line.fuelCode;
    this.fuelName = line.fuelName;
    this.conversionFactor = line.conversionFactor;
    this.fuelMeTon = line.fuelMeTon;
    this.fuelAeTon = line.fuelAeTon;
    this.totalTon = line.totalTon;
    this.co2Ton = line.co2Ton;
  }
}

/** `GET /emission/vessels/:mmsi/dcs` (JSON; `Accept: text/csv` for CSV). */
export class DcsSummaryDto {
  @ApiProperty() readonly year: number;
  @ApiProperty() readonly mmsi: number;
  @ApiProperty({ format: 'uuid' }) readonly vesselId: string;
  @ApiProperty({ type: String, nullable: true }) readonly imo: string | null;
  @ApiProperty() readonly vesselName: string;
  @ApiProperty({ enum: ['segments', 'manual'] }) readonly source:
    'segments' | 'manual';
  @ApiProperty({ type: [DcsFuelLineDto] }) readonly fuel: DcsFuelLineDto[];
  @ApiProperty({ description: 'nm' }) readonly distanceNm: number;
  @ApiProperty({
    type: Number,
    nullable: true,
    description: 'Hours of segments at ≥ 1 kn (null for manual records)',
  })
  readonly hoursUnderWay: number | null;
  @ApiProperty({ description: 't' }) readonly co2Ton: number;
  @ApiProperty({ type: [String] }) readonly methodIds: string[];

  constructor(vesselId: string, summary: DcsSummary, methodIds: string[]) {
    this.year = summary.year;
    this.mmsi = summary.mmsi;
    this.vesselId = vesselId;
    this.imo = summary.imo;
    this.vesselName = summary.vesselName;
    this.source = summary.source;
    this.fuel = summary.fuel.map((line) => new DcsFuelLineDto(line));
    this.distanceNm = summary.distanceNm;
    this.hoursUnderWay = summary.hoursUnderWay;
    this.co2Ton = summary.co2Ton;
    this.methodIds = methodIds;
  }
}
