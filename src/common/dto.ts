import type { DdVector } from '@darmawanweb/ais-its-contracts/domain';
import type { VesselSnapshotV1 } from '@darmawanweb/ais-its-contracts/events';
import { ApiProperty } from '@nestjs/swagger';

/** Rating boundaries (relative d-vector or absolute `d_i × required`). */
export class DdVectorDto {
  @ApiProperty({ example: 0.72 })
  readonly d1: number;

  @ApiProperty({ example: 0.9 })
  readonly d2: number;

  @ApiProperty({ example: 1.12 })
  readonly d3: number;

  @ApiProperty({ example: 1.41 })
  readonly d4: number;

  constructor(vector: DdVector) {
    this.d1 = vector.d1;
    this.d2 = vector.d2;
    this.d3 = vector.d3;
    this.d4 = vector.d4;
  }
}

/** ISO-8601 of a date, `null` stays `null`. */
export function isoOrNull(date: Date | null | undefined): string | null {
  return date === null || date === undefined ? null : date.toISOString();
}

/** The snapshot fields of a vessel's identity. */
export interface VesselIdentitySource {
  readonly vesselId: string;
  readonly mmsi: number;
  readonly snapshot: Pick<VesselSnapshotV1, 'imo' | 'name' | 'flag' | 'type'>;
}

/**
 * Identity of a vessel from the FLEET projection (shared data, spec §8.5),
 * embedded so that pages need no extra `GET /vessels` for their header.
 */
export class VesselIdentityDto {
  @ApiProperty({ format: 'uuid' }) readonly vesselId: string;
  @ApiProperty({ example: 525005223 }) readonly mmsi: number;
  @ApiProperty({ type: String, nullable: true, example: '9234567' })
  readonly imo: string | null;
  @ApiProperty({ example: 'KM Nusantara Jaya' }) readonly name: string;
  @ApiProperty({
    type: String,
    nullable: true,
    example: 'ID',
    description: 'Flag state as registered in fleet',
  })
  readonly flag: string | null;
  @ApiProperty({ example: 'bulk_carrier', description: 'Ship type code' })
  readonly typeCode: string;
  @ApiProperty({ example: 'Bulk carrier' }) readonly typeName: string;

  constructor(vessel: VesselIdentitySource) {
    this.vesselId = vessel.vesselId;
    this.mmsi = vessel.mmsi;
    this.imo = vessel.snapshot.imo;
    this.name = vessel.snapshot.name;
    this.flag = vessel.snapshot.flag;
    this.typeCode = vessel.snapshot.type.code;
    this.typeName = vessel.snapshot.type.name;
  }
}
