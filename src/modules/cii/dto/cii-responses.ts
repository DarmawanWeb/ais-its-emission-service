import { CII_GRADES, type CiiGrade } from '@darmawanweb/ais-its-contracts/domain';
import { CursorPageInfoDto } from '@darmawanweb/ais-its-nest/http';
import { ApiProperty } from '@nestjs/swagger';

import { DdVectorDto, isoOrNull } from '../../../common/dto.js';
import type { SegmentWeather } from '../../../db/schema.js';
import type { MethodCounts } from '../../methodology/method-ids.js';
import type { SegmentRow } from '../../segments/segments.repository.js';
import type { CiiProjection, CiiSummary, DailyCiiPoint, FleetSummary } from '../cii.service.js';
import type { YearFigures } from '../cii-figures.js';

const METHOD_IDS_PROPERTY = {
  type: [String],
  example: ['fuel.first_formula', 'cii.attained_accumulation', 'cii.required', 'cii.rating_grade'],
  description: 'Methodology catalog ids behind the figure (GET /api/v2/emission/methodology)',
} as const;

/** Segments per fuel estimation method. */
export class MethodCountsDto {
  @ApiProperty() readonly telemetry: number;
  @ApiProperty() readonly firstFormula: number;
  @ApiProperty() readonly holtrop: number;

  constructor(counts: MethodCounts) {
    this.telemetry = counts.telemetry;
    this.firstFormula = counts.firstFormula;
    this.holtrop = counts.holtrop;
  }
}

/** Linear year-end projection. */
export class CiiProjectionDto {
  @ApiProperty({ description: 'Elapsed fraction of the calendar year at asOf', example: 0.45 })
  readonly yearFraction: number;
  @ApiProperty({ description: 'Projected distance, nm' }) readonly distanceNm: number;
  @ApiProperty({ description: 'Projected main engine fuel, t' }) readonly fuelMeTon: number;
  @ApiProperty({ description: 'Projected auxiliary engine fuel, t' }) readonly fuelAeTon: number;
  @ApiProperty({ description: 'Projected CO2, t' }) readonly co2Ton: number;
  @ApiProperty({ description: 'Year-end attained CII from the linear trend of the daily cumulative values' })
  readonly attained: number;
  @ApiProperty() readonly rating: number;
  @ApiProperty({ enum: CII_GRADES }) readonly grade: CiiGrade;

  constructor(projection: CiiProjection) {
    this.yearFraction = projection.yearFraction;
    this.distanceNm = projection.distanceNm;
    this.fuelMeTon = projection.fuelMeTon;
    this.fuelAeTon = projection.fuelAeTon;
    this.co2Ton = projection.co2Ton;
    this.attained = projection.attained;
    this.rating = projection.rating;
    this.grade = projection.grade;
  }
}

/** CII of a vessel-year (segments or manual record). */
export class CiiYearDto {
  @ApiProperty({ example: 2026 }) readonly year: number;
  @ApiProperty({ enum: ['segments', 'manual'], description: 'manual = cii_annual_manual fallback for a year without segments' })
  readonly source: 'segments' | 'manual';
  @ApiProperty({ description: 'Distance, nm' }) readonly distanceNm: number;
  @ApiProperty({ description: 'Main engine fuel, t' }) readonly fuelMeTon: number;
  @ApiProperty({ description: 'Auxiliary engine fuel, t' }) readonly fuelAeTon: number;
  @ApiProperty({ type: Number, nullable: true, description: 'CO2, t' }) readonly co2Ton: number | null;
  @ApiProperty({ type: Number, nullable: true, description: 'Counted segments (null for manual records)' })
  readonly segments: number | null;
  @ApiProperty({ type: MethodCountsDto, nullable: true }) readonly methods: MethodCountsDto | null;
  @ApiProperty({ type: String, format: 'date-time', nullable: true, description: 'End of the last segment included' })
  readonly asOf: string | null;
  @ApiProperty({ type: Number, nullable: true, description: 'Reduction factor Z of the year, %' })
  readonly zPercent: number | null;
  @ApiProperty({ description: 'Attained CII, g CO2 / (capacity · nm)' }) readonly attained: number;
  @ApiProperty({ type: Number, nullable: true, description: 'Required CII, g CO2 / (capacity · nm)' })
  readonly required: number | null;
  @ApiProperty({ type: Number, nullable: true, description: 'attained / required' }) readonly rating: number | null;
  @ApiProperty({ enum: CII_GRADES, nullable: true }) readonly grade: CiiGrade | null;
  @ApiProperty({ type: DdVectorDto, nullable: true, description: 'Absolute grade boundaries d_i × required (legacy ddVector)' })
  readonly ddVector: DdVectorDto | null;
  @ApiProperty(METHOD_IDS_PROPERTY) readonly methodIds: string[];

  constructor(figures: YearFigures) {
    this.year = figures.year;
    this.source = figures.source;
    this.distanceNm = figures.distanceNm;
    this.fuelMeTon = figures.fuelMeTon;
    this.fuelAeTon = figures.fuelAeTon;
    this.co2Ton = figures.co2Ton;
    this.segments = figures.segments;
    this.methods = figures.methods === null ? null : new MethodCountsDto(figures.methods);
    this.asOf = isoOrNull(figures.asOf);
    this.zPercent = figures.zPercent;
    this.attained = figures.attained;
    this.required = figures.required;
    this.rating = figures.rating;
    this.grade = figures.grade;
    this.ddVector = figures.boundaries === null ? null : new DdVectorDto(figures.boundaries);
    this.methodIds = figures.methodIds;
  }
}

/** `GET /cii/vessels/:mmsi/current` — year-to-date CII. */
export class CiiSummaryDto extends CiiYearDto {
  @ApiProperty({ example: 525005223 }) readonly mmsi: number;
  @ApiProperty({ format: 'uuid' }) readonly vesselId: string;
  @ApiProperty({ description: 'CII capacity (type.capacityFixed ?? dimensions.capacity)' }) readonly capacity: number;
  @ApiProperty({ enum: ['telemetry', 'first_formula', 'holtrop'], nullable: true, description: 'Fuel method of the most recent segment' })
  readonly lastMethod: 'telemetry' | 'first_formula' | 'holtrop' | null;
  @ApiProperty({ type: CiiProjectionDto, nullable: true, description: 'Linear year-end projection (current year only)' })
  readonly projection: CiiProjectionDto | null;

  constructor(summary: CiiSummary) {
    super(summary.figures);
    this.mmsi = summary.profile.mmsi;
    this.vesselId = summary.profile.vesselId;
    this.capacity = summary.capacity;
    this.lastMethod = summary.lastMethod;
    this.projection = summary.projection === null ? null : new CiiProjectionDto(summary.projection);
    this.methodIds = summary.methodIds;
  }
}

/** A daily point with the cumulative (year-to-date) CII. */
export class DailyCiiPointDto {
  @ApiProperty({ format: 'date', example: '2026-03-10' }) readonly day: string;
  @ApiProperty({ description: 'nm' }) readonly distanceNm: number;
  @ApiProperty({ description: 't' }) readonly fuelMeTon: number;
  @ApiProperty({ description: 't' }) readonly fuelAeTon: number;
  @ApiProperty({ description: 't' }) readonly co2Ton: number;
  @ApiProperty() readonly segments: number;
  @ApiProperty({ type: MethodCountsDto }) readonly methods: MethodCountsDto;
  @ApiProperty({ type: Number, nullable: true, description: 'Attained CII of the day' }) readonly attained: number | null;
  @ApiProperty({ type: Number, nullable: true, description: 'Year-to-date attained CII at the end of the day' })
  readonly cumulativeAttained: number | null;
  @ApiProperty({ type: Number, nullable: true, description: 'Required CII of the year' }) readonly required: number | null;
  @ApiProperty({ type: Number, nullable: true }) readonly cumulativeRating: number | null;
  @ApiProperty({ enum: CII_GRADES, nullable: true }) readonly cumulativeGrade: CiiGrade | null;

  constructor(point: DailyCiiPoint) {
    this.day = point.totals.day.toISOString().slice(0, 10);
    this.distanceNm = point.totals.distanceNm;
    this.fuelMeTon = point.totals.fuelMeTon;
    this.fuelAeTon = point.totals.fuelAeTon;
    this.co2Ton = point.totals.co2Ton;
    this.segments = point.totals.segments;
    this.methods = new MethodCountsDto({
      telemetry: point.totals.telemetrySegments,
      firstFormula: point.totals.firstFormulaSegments,
      holtrop: point.totals.holtropSegments,
    });
    this.attained = point.attained;
    this.cumulativeAttained = point.cumulativeAttained;
    this.required = point.required;
    this.cumulativeRating = point.cumulativeRating;
    this.cumulativeGrade = point.cumulativeGrade;
  }
}

/** `GET /cii/vessels/:mmsi/daily`. */
export class DailyCiiDto {
  @ApiProperty() readonly mmsi: number;
  @ApiProperty({ format: 'date-time' }) readonly from: string;
  @ApiProperty({ format: 'date-time' }) readonly to: string;
  @ApiProperty({ type: [DailyCiiPointDto] }) readonly points: DailyCiiPointDto[];
  @ApiProperty(METHOD_IDS_PROPERTY) readonly methodIds: string[];

  constructor(mmsi: number, from: Date, to: Date, points: DailyCiiPointDto[], methodIds: string[]) {
    this.mmsi = mmsi;
    this.from = from.toISOString();
    this.to = to.toISOString();
    this.points = points;
    this.methodIds = methodIds;
  }
}

/** `GET /cii/vessels/:mmsi/annual`. */
export class AnnualCiiDto {
  @ApiProperty() readonly mmsi: number;
  @ApiProperty({ format: 'uuid' }) readonly vesselId: string;
  @ApiProperty({ type: DdVectorDto, description: 'd-vector of the ship type (relative)' }) readonly dVector: DdVectorDto;
  @ApiProperty({ type: [CiiYearDto] }) readonly years: CiiYearDto[];

  constructor(mmsi: number, vesselId: string, dVector: DdVectorDto, years: CiiYearDto[]) {
    this.mmsi = mmsi;
    this.vesselId = vesselId;
    this.dVector = dVector;
    this.years = years;
  }
}

/** Weather of a Holtrop segment. */
export class SegmentWeatherDto {
  @ApiProperty({ description: 'kn' }) readonly windSpeedKn: number;
  @ApiProperty({ description: 'degrees' }) readonly windDirectionDeg: number;
  @ApiProperty() readonly beaufortNumber: number;
  @ApiProperty({ description: 'degrees' }) readonly encounterAngleDeg: number;
  @ApiProperty({ enum: ['open-meteo', 'calm_fallback'] }) readonly source: 'open-meteo' | 'calm_fallback';
  @ApiProperty({ example: '2026-03-10T08:00' }) readonly hour: string;
  @ApiProperty({ example: 1.25 }) readonly cellLat: number;
  @ApiProperty({ example: 104 }) readonly cellLon: number;

  constructor(weather: SegmentWeather) {
    this.windSpeedKn = weather.windSpeedKn;
    this.windDirectionDeg = weather.windDirectionDeg;
    this.beaufortNumber = weather.beaufortNumber;
    this.encounterAngleDeg = weather.encounterAngleDeg;
    this.source = weather.source;
    this.hour = weather.hour;
    this.cellLat = weather.cell.lat;
    this.cellLon = weather.cell.lon;
  }
}

/** A stored voyage segment. */
export class SegmentDto {
  @ApiProperty({ format: 'date-time' }) readonly timeStart: string;
  @ApiProperty({ format: 'date-time' }) readonly timeEnd: string;
  @ApiProperty() readonly mmsi: number;
  @ApiProperty({ format: 'uuid' }) readonly vesselId: string;
  @ApiProperty({ description: 'nm' }) readonly distanceNm: number;
  @ApiProperty({ description: 'kn (capped at 30)' }) readonly speedKn: number;
  @ApiProperty({ description: 't' }) readonly fuelMeTon: number;
  @ApiProperty({ description: 't' }) readonly fuelAeTon: number;
  @ApiProperty({ description: 't' }) readonly co2Ton: number;
  @ApiProperty({ enum: ['telemetry', 'first_formula', 'holtrop', 'none'], description: 'none = not counted (see flags)' })
  readonly method: 'telemetry' | 'first_formula' | 'holtrop' | 'none';
  @ApiProperty({ description: 'AIS navstatus of the previous fix' }) readonly navstatus: number;
  @ApiProperty({ example: 'MDO' }) readonly fuelCode: string;
  @ApiProperty({ description: 'C_F used, t CO2 / t fuel' }) readonly conversionFactor: number;
  @ApiProperty({ type: SegmentWeatherDto, nullable: true }) readonly weather: SegmentWeatherDto | null;
  @ApiProperty({ type: [String], example: ['weather_unavailable'] }) readonly flags: string[];

  constructor(row: SegmentRow) {
    this.timeStart = row.timeStart.toISOString();
    this.timeEnd = row.timeEnd.toISOString();
    this.mmsi = row.mmsi;
    this.vesselId = row.vesselId;
    this.distanceNm = row.distanceNm;
    this.speedKn = row.speedKn;
    this.fuelMeTon = row.fuelMeTon;
    this.fuelAeTon = row.fuelAeTon;
    this.co2Ton = row.co2Ton;
    this.method = row.method;
    this.navstatus = row.navstatus;
    this.fuelCode = row.fuelCode;
    this.conversionFactor = row.conversionFactor;
    this.weather = row.weather === null ? null : new SegmentWeatherDto(row.weather);
    this.flags = row.flags;
  }
}

/** `GET /cii/vessels/:mmsi/segments` — cursor page. */
export class SegmentPageDto {
  @ApiProperty({ type: [SegmentDto] }) readonly data: SegmentDto[];
  @ApiProperty({ type: CursorPageInfoDto }) readonly page: CursorPageInfoDto;

  constructor(data: SegmentDto[], page: CursorPageInfoDto) {
    this.data = data;
    this.page = page;
  }
}

/** Grade counts. */
export class GradeCountsDto {
  @ApiProperty() readonly A: number;
  @ApiProperty() readonly B: number;
  @ApiProperty() readonly C: number;
  @ApiProperty() readonly D: number;
  @ApiProperty() readonly E: number;

  constructor(counts: Record<CiiGrade, number>) {
    this.A = counts.A;
    this.B = counts.B;
    this.C = counts.C;
    this.D = counts.D;
    this.E = counts.E;
  }
}

/** A vessel of the fleet summary. */
export class FleetVesselCiiDto {
  @ApiProperty() readonly mmsi: number;
  @ApiProperty({ format: 'uuid' }) readonly vesselId: string;
  @ApiProperty() readonly name: string;
  @ApiProperty({ enum: CII_GRADES, nullable: true }) readonly grade: CiiGrade | null;
  @ApiProperty({ type: Number, nullable: true }) readonly rating: number | null;
  @ApiProperty({ type: Number, nullable: true }) readonly attained: number | null;
  @ApiProperty({ enum: ['segments', 'manual'], nullable: true }) readonly source: 'segments' | 'manual' | null;

  constructor(item: FleetSummary['items'][number]) {
    this.mmsi = item.profile.mmsi;
    this.vesselId = item.profile.vesselId;
    this.name = item.profile.snapshot.name;
    this.grade = item.figures?.grade ?? null;
    this.rating = item.figures?.rating ?? null;
    this.attained = item.figures?.attained ?? null;
    this.source = item.figures?.source ?? null;
  }
}

/** `GET /cii/fleet/summary`. */
export class FleetSummaryDto {
  @ApiProperty() readonly year: number;
  @ApiProperty({ type: String, format: 'uuid', nullable: true, description: 'null = every organization (super_admin)' })
  readonly orgId: string | null;
  @ApiProperty() readonly vessels: number;
  @ApiProperty({ type: GradeCountsDto }) readonly grades: GradeCountsDto;
  @ApiProperty({ description: 'Vessels without CII data for the year' }) readonly notAvailable: number;
  @ApiProperty({ type: [FleetVesselCiiDto] }) readonly items: FleetVesselCiiDto[];
  @ApiProperty(METHOD_IDS_PROPERTY) readonly methodIds: string[];

  constructor(summary: FleetSummary, methodIds: string[]) {
    this.year = summary.year;
    this.orgId = summary.orgId;
    this.vessels = summary.items.length;
    this.grades = new GradeCountsDto(summary.grades);
    this.notAvailable = summary.notAvailable;
    this.items = summary.items.map((item) => new FleetVesselCiiDto(item));
    this.methodIds = methodIds;
  }
}
