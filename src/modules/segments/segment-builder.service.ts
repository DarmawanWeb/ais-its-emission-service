import type { AisPositionRecordedV1 } from '@darmawanweb/ais-its-contracts/events';
import { InjectConfig } from '@darmawanweb/ais-its-nest';
import { MetricsService } from '@darmawanweb/ais-its-nest/metrics';
import { Injectable } from '@nestjs/common';
import type { Counter } from 'prom-client';

import type { Config } from '../../config.js';
import type { SegmentWeather } from '../../db/schema.js';
import { calculateSpeed, classifySegmentWindow } from '../../domain/segment.js';
import {
  chooseFuelMethod,
  computeSegmentFuel,
  excludedSegment,
  type SegmentFuelInput,
  type SegmentFuelResult,
} from '../../domain/segment-fuel.js';
import type { Wind } from '../../domain/weather/types.js';
import {
  type DirectoryEntry,
  ProfileDirectory,
} from '../profiles/profile-directory.js';
import {
  WeatherService,
  type WindObservation,
} from '../weather/weather.service.js';
import { AggregateRefresher } from './aggregate-refresher.service.js';
import { CiiPublicationRepository } from './cii-publication.repository.js';
import { FuelReadingsRepository } from './fuel-readings.repository.js';
import { type NewSegment, SegmentsRepository } from './segments.repository.js';

/** What happened to a position event. */
export type PositionOutcome =
  | 'stored'
  | 'duplicate'
  | 'unknown_vessel'
  | 'no_previous'
  | 'not_after_previous';

/** `live`: idempotent insert (consumer); `replace`: overwrite (recomputation). */
export type BuildMode = 'live' | 'replace';

/**
 * Builds the segment `previous → current` of an `ais.position.recorded.v1`
 * event (spec §13.5): kinematics, fuel method by priority, fuel and CO2,
 * weather and flags; stores it idempotently by `(mmsi, time_start)` and marks
 * the vessel's CII for publication. Metric `aisits_emission_segments_total{method}`.
 */
@Injectable()
export class SegmentBuilderService {
  private readonly segmentsTotal: Counter<'method'>;

  constructor(
    @InjectConfig() private readonly config: Config,
    private readonly directory: ProfileDirectory,
    private readonly readings: FuelReadingsRepository,
    private readonly segments: SegmentsRepository,
    private readonly publication: CiiPublicationRepository,
    private readonly refresher: AggregateRefresher,
    private readonly weather: WeatherService,
    metrics: MetricsService,
  ) {
    this.segmentsTotal = metrics.counter({
      name: 'emission_segments_total',
      help: 'Voyage segments stored, by fuel method (none = not counted)',
      labelNames: ['method'],
    });
  }

  /** Builds and stores the segment of a position event. */
  async handlePosition(
    position: AisPositionRecordedV1,
    mode: BuildMode = 'live',
  ): Promise<PositionOutcome> {
    await this.directory.whenLoaded();
    const entry = this.directory.get(position.mmsi);
    if (entry === undefined) return 'unknown_vessel';
    const previous = position.previous;
    if (previous === null) return 'no_previous';
    const current = {
      lat: position.lat,
      lon: position.lon,
      time: new Date(position.time),
    };
    const previousFix = {
      lat: previous.lat,
      lon: previous.lon,
      time: new Date(previous.time),
    };
    const verdict = classifySegmentWindow(
      current,
      previousFix,
      this.config.SEGMENT_MAX_GAP_MIN,
    );
    if (verdict.kind === 'no_previous') return 'no_previous';
    if (verdict.kind === 'not_after_previous') return 'not_after_previous';

    const kinematics = calculateSpeed(current, previousFix);
    let result: SegmentFuelResult;
    let observation: WindObservation | undefined;
    if (verdict.kind === 'gap') {
      result = excludedSegment('gap');
    } else {
      const input: SegmentFuelInput = {
        kinematics,
        window: { start: previousFix.time, end: current.time },
        navstatus: previous.navstatus,
        profile: entry.fuel,
        readings: await this.readings.findAround(
          position.mmsi,
          previousFix.time,
          current.time,
          this.config.TELEMETRY_ACTIVE_WINDOW_MIN * 60_000,
        ),
        telemetryActiveWindowMinutes: this.config.TELEMETRY_ACTIVE_WINDOW_MIN,
      };
      const method = chooseFuelMethod(input);
      let wind: Wind | null = null;
      if (method === 'holtrop' && entry.fuel.mainEngineSfoc !== null) {
        observation = await this.weather.windAt(
          previous.lat,
          previous.lon,
          previousFix.time,
        );
        wind = observation.wind;
      }
      result = computeSegmentFuel(
        input,
        method,
        wind,
        observation?.source === 'calm_fallback',
      );
    }

    const segment = toSegment(
      position.mmsi,
      entry,
      previousFix.time,
      current.time,
      previous.navstatus,
      kinematics,
      result,
      observation,
    );
    if (mode === 'replace') {
      await this.segments.upsert(segment);
    } else if (!(await this.segments.insert(segment))) {
      return 'duplicate';
    }
    this.segmentsTotal.inc({ method: result.method });
    this.refresher.markChanged(segment.timeStart);
    if (result.method !== 'none')
      await this.publication.markDirty(position.mmsi);
    return 'stored';
  }
}

function toSegment(
  mmsi: number,
  entry: DirectoryEntry,
  timeStart: Date,
  timeEnd: Date,
  navstatus: number,
  kinematics: { readonly distanceNm: number; readonly speedKn: number },
  result: SegmentFuelResult,
  observation: WindObservation | undefined,
): NewSegment {
  return {
    timeStart,
    timeEnd,
    mmsi,
    vesselId: entry.profile.vesselId,
    distanceNm: kinematics.distanceNm,
    speedKn: kinematics.speedKn,
    fuelMeTon: result.fuelMeTon,
    fuelAeTon: result.fuelAeTon,
    co2Ton: result.co2Ton,
    method: result.method,
    navstatus,
    fuelCode: entry.fuel.fuelCode,
    conversionFactor: entry.fuel.conversionFactor,
    weather: weatherOf(result, observation),
    flags: [...result.flags],
  };
}

function weatherOf(
  result: SegmentFuelResult,
  observation: WindObservation | undefined,
): SegmentWeather | null {
  if (observation === undefined || result.holtrop === undefined) return null;
  return {
    windSpeedKn: observation.wind.speedKn,
    windDirectionDeg: observation.wind.directionDeg,
    beaufortNumber: result.holtrop.windCourse.beaufortNumber,
    encounterAngleDeg: result.holtrop.windCourse.encounterAngleDeg,
    source: observation.source,
    cell: { lat: observation.cell.lat, lon: observation.cell.lon },
    hour: observation.cell.hour,
  };
}
