import {
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';

import { VesselProfilesRepository } from './vessel-profiles.repository.js';
import type { SegmentFuelProfile } from '../../domain/segment-fuel.js';
import { segmentFuelProfileOf, type VesselProfile } from './vessel-profile.js';

/** A cached profile with its prepared segment inputs. */
export interface DirectoryEntry {
  readonly profile: VesselProfile;
  readonly fuel: SegmentFuelProfile;
}

/** Interval of the background resynchronisation with `vessel_profiles`, ms. */
export const PROFILE_DIRECTORY_SYNC_MS = 30_000;

/**
 * In-memory directory MMSI → vessel profile for the position consumer, which
 * sees every AIS position of every vessel: positions of vessels outside the
 * fleet are skipped without a database round trip. The local FLEET consumer
 * updates it at once; every {@link PROFILE_DIRECTORY_SYNC_MS} it re-reads the
 * versions from the database (changes consumed by another replica), loading
 * only snapshots whose version changed. First fuel formulas are compiled once
 * per snapshot version.
 */
@Injectable()
export class ProfileDirectory
  implements OnApplicationBootstrap, OnApplicationShutdown
{
  private readonly logger = new Logger(ProfileDirectory.name);
  private readonly byMmsi = new Map<number, DirectoryEntry>();
  private timer: NodeJS.Timeout | undefined;
  private syncing: Promise<void> | undefined;
  private loaded: Promise<void> | undefined;

  constructor(private readonly repository: VesselProfilesRepository) {}

  async onApplicationBootstrap(): Promise<void> {
    await this.whenLoaded();
    this.timer = setInterval(() => {
      void this.sync().catch((error: unknown) => {
        this.logger.warn(
          { err: error },
          'vessel profile directory sync failed',
        );
      });
    }, PROFILE_DIRECTORY_SYNC_MS);
    this.timer.unref();
  }

  onApplicationShutdown(): void {
    if (this.timer !== undefined) clearInterval(this.timer);
  }

  /**
   * Resolves once the profiles were loaded from the database (the first
   * sync): consumers may start before this provider's bootstrap hook ran.
   */
  whenLoaded(): Promise<void> {
    this.loaded ??= this.sync().catch((error: unknown) => {
      this.loaded = undefined;
      throw error;
    });
    return this.loaded;
  }

  /** The profile of a fleet vessel, `undefined` for any other MMSI (call {@link whenLoaded} first). */
  get(mmsi: number): DirectoryEntry | undefined {
    return this.byMmsi.get(mmsi);
  }

  /** Number of vessels known. */
  get size(): number {
    return this.byMmsi.size;
  }

  /** Applies a profile stored by the local FLEET consumer. */
  apply(profile: VesselProfile): void {
    for (const [mmsi, entry] of this.byMmsi) {
      if (entry.profile.vesselId === profile.vesselId && mmsi !== profile.mmsi)
        this.byMmsi.delete(mmsi);
    }
    const current = this.byMmsi.get(profile.mmsi);
    if (
      current !== undefined &&
      current.profile.snapshotUpdatedAt > profile.snapshotUpdatedAt
    )
      return;
    this.byMmsi.set(profile.mmsi, {
      profile,
      fuel: segmentFuelProfileOf(profile.snapshot),
    });
  }

  /** Forgets a deleted vessel. */
  remove(vesselId: string): void {
    for (const [mmsi, entry] of this.byMmsi) {
      if (entry.profile.vesselId === vesselId) this.byMmsi.delete(mmsi);
    }
  }

  /** Re-reads the stored versions and loads changed snapshots (one sync at a time). */
  sync(): Promise<void> {
    this.syncing ??= this.load().finally(() => {
      this.syncing = undefined;
    });
    return this.syncing;
  }

  private async load(): Promise<void> {
    const versions = await this.repository.versions();
    const changed = versions.filter((version) => {
      const entry = this.byMmsi.get(version.mmsi);
      return (
        entry?.profile.vesselId !== version.vesselId ||
        entry.profile.snapshotUpdatedAt.getTime() !==
          version.snapshotUpdatedAt.getTime()
      );
    });
    const known = new Set(versions.map((version) => version.mmsi));
    for (const mmsi of this.byMmsi.keys()) {
      if (!known.has(mmsi)) this.byMmsi.delete(mmsi);
    }
    for (const profile of await this.repository.findByVesselIds(
      changed.map((version) => version.vesselId),
    )) {
      this.byMmsi.set(profile.mmsi, {
        profile,
        fuel: segmentFuelProfileOf(profile.snapshot),
      });
    }
  }
}
