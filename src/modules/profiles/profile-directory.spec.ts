import { describe, expect, it } from 'vitest';
import * as z from 'zod';

import { loadGolden } from '../../../test/support/golden.js';
import {
  LegacyShipSchema,
  snapshotOfLegacyShip,
  testUuid,
} from '../../../test/support/legacy-ship.js';
import { ProfileDirectory } from './profile-directory.js';
import { profileOfSnapshot, type VesselProfile } from './vessel-profile.js';
import type { VesselProfilesRepository } from './vessel-profiles.repository.js';

const ship = loadGolden(
  'holtrop.json',
  z.object({ ships: z.record(z.string(), LegacyShipSchema) }),
).ships.A;
const A = testUuid(8101);
const B = testUuid(8102);

function profile(
  vesselId: string,
  mmsi: number,
  updatedAt: string,
): VesselProfile {
  if (ship === undefined) throw new Error('no legacy ship A');
  return profileOfSnapshot(
    snapshotOfLegacyShip(ship, 81, {
      id: vesselId,
      mmsi,
      orgId: testUuid(8100),
      updatedAt,
    }),
  );
}

/** `apply` never reads the repository; the stub answers an empty projection. */
function directory(): ProfileDirectory {
  const repository: Pick<
    VesselProfilesRepository,
    'versions' | 'findByVesselIds'
  > = {
    versions: () => Promise.resolve([]),
    findByVesselIds: () => Promise.resolve([]),
  };
  return new ProfileDirectory(
    repository as unknown as VesselProfilesRepository,
  );
}

const holderOf = (dir: ProfileDirectory, mmsi: number) =>
  dir.get(mmsi)?.profile.vesselId;

describe('ProfileDirectory.apply (same rule as VesselProfilesRepository.upsert)', () => {
  it('moves a vessel to its new MMSI', () => {
    const dir = directory();
    dir.apply(profile(A, 525700011, '2026-02-01T00:00:00Z'));
    dir.apply(profile(A, 525700013, '2026-03-01T00:00:00Z'));
    expect(holderOf(dir, 525700011)).toBeUndefined();
    expect(holderOf(dir, 525700013)).toBe(A);
    expect(dir.size).toBe(1);
  });

  it('ignores an older snapshot of the same vessel', () => {
    const dir = directory();
    dir.apply(profile(A, 525700011, '2026-02-01T00:00:00Z'));
    dir.apply(profile(A, 525700013, '2026-01-01T00:00:00Z'));
    expect(holderOf(dir, 525700011)).toBe(A);
    expect(holderOf(dir, 525700013)).toBeUndefined();
  });

  it('never lets a stale snapshot take the MMSI of the vessel that holds it now', () => {
    const dir = directory();
    dir.apply(profile(A, 525700011, '2026-02-01T00:00:00Z'));
    dir.apply(profile(B, 525700012, '2026-03-01T00:00:00Z'));
    // a redelivered snapshot of A from when A held B's current MMSI
    dir.apply(profile(A, 525700012, '2026-01-01T00:00:00Z'));
    expect(holderOf(dir, 525700011)).toBe(A);
    expect(holderOf(dir, 525700012)).toBe(B);
    // also when only the MMSI holder is newer than the snapshot
    dir.apply(profile(A, 525700012, '2026-02-15T00:00:00Z'));
    expect(holderOf(dir, 525700012)).toBe(B);
    expect(holderOf(dir, 525700011)).toBe(A);
  });

  it('gives a re-assigned MMSI to the newer claim', () => {
    const dir = directory();
    dir.apply(profile(B, 525700012, '2026-03-01T00:00:00Z'));
    dir.apply(profile(A, 525700012, '2026-04-01T00:00:00Z'));
    expect(holderOf(dir, 525700012)).toBe(A);
    expect(dir.size).toBe(1);
  });
});
