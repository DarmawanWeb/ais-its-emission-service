import type { DdVector } from '@darmawanweb/ais-its-contracts/domain';
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
