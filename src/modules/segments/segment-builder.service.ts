import type { AisPositionRecordedV1 } from '@darmawanweb/ais-its-contracts/events';
import { InjectConfig } from '@darmawanweb/ais-its-nest';
import { type Database, InjectDb } from '@darmawanweb/ais-its-nest/db';
import { MetricsService } from '@darmawanweb/ais-its-nest/metrics';
import { Injectable } from '@nestjs/common';
import type { Counter } from 'prom-client';

import type { Config } from '../../config.js';
import { type Executor, lockVesselSegments } from '../../db/executor.js';
import type * as schema from '../../db/schema.js';
import type { SegmentWeather } from '../../db/schema.js';
import type { FuelReading, TimeWindow } from '../../domain/fuel/telemetry.js';
import {
  calculateSpeed,
  classifySegmentWindow,
  type SegmentKinematics,
} from '../../domain/segment.js';
import {
  chooseFuelMethod,
  computeSegmentFuel,
  excludedSegment,
  type SegmentFuelInput,
  type SegmentFuelResult,
} from '../../domain/segment-fuel.js';
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
import {
  FuelReadingsRepository,
  type ReadingSearch,
} from './fuel-readings.repository.js';
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

/** A segment `previous → current` before its fuel is known. */
interface SegmentDraft {
  readonly mmsi: number;
  readonly entry: DirectoryEntry;
  readonly window: TimeWindow;
  readonly kinematics: SegmentKinematics;
  /** Reported navstatus of the previous fix (fuel multipliers). */
  readonly navstatus: number;
  /** Where the wind is looked up (the previous fix). */
  readonly origin: { readonly lat: number; readonly lon: number };
  /** Time between the fixes above SEGMENT_MAX_GAP_MIN (not counted). */
  readonly gap: boolean;
}

/**
 * Builds the segment `previous → current` of an `ais.position.recorded.v1`
 * event (spec §13.5): kinematics, fuel method by priority, fuel and CO2,
 * weather and flags; stores it idempotently by `(mmsi, time_start)` and marks
 * the vessel's CII for publication. Metric `aisits_emission_segments_total{method}`.
 *
 * The telemetry readings are read and the segment is written in one
 * transaction under the vessel's advisory lock ({@link lockVesselSegments}),
 * which the telemetry attribution also takes: a reading stored while a
 * segment of the same window is being built is either seen here or
 * re-attributed there, never lost. The weather (up to WEATHER_TIMEOUT_MS) is
 * fetched before the lock, when the readings known at that time leave
 * Holtrop as the method; readings only accumulate, so the method chosen
 * under the lock can only move from Holtrop to telemetry.
 */
@Injectable()
export class SegmentBuilderService {
  private readonly segmentsTotal: Counter<'method'>;

  constructor(
    @InjectConfig() private readonly config: Config,
    @InjectDb() private readonly db: Database<typeof schema>,
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

  /**
   * Builds and stores the segment of a position event. In `replace` mode an
   * existing segment of the same vessel is overwritten; a segment of another
   * vessel at `(mmsi, time_start)` (the previous holder of a re-assigned MMSI)
   * is kept and the outcome is `duplicate`.
   *
   * @param vesselId when given, the MMSI must still belong to this vessel
   *   (a recomputation of one vessel); otherwise the outcome is `unknown_vessel`.
   */
  async handlePosition(
    position: AisPositionRecordedV1,
    mode: BuildMode = 'live',
    vesselId?: string,
  ): Promise<PositionOutcome> {
    await this.directory.whenLoaded();
    const entry = this.directory.get(position.mmsi);
    if (
      entry === undefined ||
      (vesselId !== undefined && entry.profile.vesselId !== vesselId)
    )
      return 'unknown_vessel';
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

    const draft: SegmentDraft = {
      mmsi: position.mmsi,
      entry,
      window: { start: previousFix.time, end: current.time },
      kinematics: calculateSpeed(current, previousFix),
      navstatus: previous.navstatus,
      origin: { lat: previous.lat, lon: previous.lon },
      gap: verdict.kind === 'gap',
    };
    let observation =
      !draft.gap &&
      this.needsWeather(draft, await this.readingsAround(draft, this.db))
        ? await this.windAt(draft)
        : undefined;

    const stored = await this.db.transaction(async (tx) => {
      await lockVesselSegments(tx, draft.mmsi);
      let result: SegmentFuelResult;
      if (draft.gap) {
        result = excludedSegment('gap');
      } else {
        const input = this.fuelInput(
          draft,
          await this.readingsAround(draft, tx),
        );
        const method = chooseFuelMethod(input);
        // Only if the method moved to Holtrop since the first read (it cannot
        // while readings only accumulate): fetch the wind under the lock.
        if (this.holtropApplies(draft, method)) {
          observation ??= await this.windAt(draft);
        }
        result = computeSegmentFuel(
          input,
          method,
          this.holtropApplies(draft, method) && observation !== undefined
            ? observation.wind
            : null,
          observation?.source === 'calm_fallback',
        );
      }
      const segment = toSegment(draft, result, observation);
      const written =
        mode === 'replace'
          ? await this.segments.upsert(segment, tx)
          : await this.segments.insert(segment, tx);
      return written ? { segment, result } : undefined;
    });
    if (stored === undefined) return 'duplicate';
    this.segmentsTotal.inc({ method: stored.result.method });
    this.refresher.markChanged(stored.segment.timeStart);
    if (stored.result.method !== 'none')
      await this.publication.markDirty(position.mmsi);
    return 'stored';
  }

  private readingSearch(): ReadingSearch {
    return {
      toleranceMs: this.config.TELEMETRY_ACTIVE_WINDOW_MIN * 60_000,
      maxPeriodMs: this.config.TELEMETRY_MAX_PERIOD_H * 3_600_000,
    };
  }

  private readingsAround(
    draft: SegmentDraft,
    executor: Executor,
  ): Promise<FuelReading[]> {
    return this.readings.findAround(
      draft.mmsi,
      draft.window.start,
      draft.window.end,
      this.readingSearch(),
      executor,
    );
  }

  private fuelInput(
    draft: SegmentDraft,
    readings: readonly FuelReading[],
  ): SegmentFuelInput {
    return {
      kinematics: draft.kinematics,
      window: draft.window,
      navstatus: draft.navstatus,
      profile: draft.entry.fuel,
      readings,
      telemetryActiveWindowMinutes: this.config.TELEMETRY_ACTIVE_WINDOW_MIN,
    };
  }

  private holtropApplies(
    draft: SegmentDraft,
    method: ReturnType<typeof chooseFuelMethod>,
  ): boolean {
    return method === 'holtrop' && draft.entry.fuel.mainEngineSfoc !== null;
  }

  private needsWeather(
    draft: SegmentDraft,
    readings: readonly FuelReading[],
  ): boolean {
    return this.holtropApplies(
      draft,
      chooseFuelMethod(this.fuelInput(draft, readings)),
    );
  }

  private windAt(draft: SegmentDraft): Promise<WindObservation> {
    return this.weather.windAt(
      draft.origin.lat,
      draft.origin.lon,
      draft.window.start,
    );
  }
}

function toSegment(
  draft: SegmentDraft,
  result: SegmentFuelResult,
  observation: WindObservation | undefined,
): NewSegment {
  return {
    timeStart: draft.window.start,
    timeEnd: draft.window.end,
    mmsi: draft.mmsi,
    vesselId: draft.entry.profile.vesselId,
    distanceNm: draft.kinematics.distanceNm,
    speedKn: draft.kinematics.speedKn,
    fuelMeTon: result.fuelMeTon,
    fuelAeTon: result.fuelAeTon,
    co2Ton: result.co2Ton,
    method: result.method,
    navstatus: draft.navstatus,
    fuelCode: draft.entry.fuel.fuelCode,
    conversionFactor: draft.entry.fuel.conversionFactor,
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
