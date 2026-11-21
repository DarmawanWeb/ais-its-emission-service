import { ApiProperty } from '@nestjs/swagger';

import { isoOrNull } from '../../../common/dto.js';
import type { RecomputeJob } from '../recompute-jobs.repository.js';

/** A recomputation job (`POST /cii/vessels/:mmsi/recompute`). */
export class RecomputeJobDto {
  @ApiProperty({ format: 'uuid' }) readonly id: string;
  @ApiProperty() readonly mmsi: number;
  @ApiProperty({ format: 'date-time' }) readonly from: string;
  @ApiProperty({ format: 'date-time' }) readonly to: string;
  @ApiProperty({ enum: ['running', 'succeeded', 'failed'] }) readonly status: 'running' | 'succeeded' | 'failed';
  @ApiProperty({ description: 'Position events replayed in the range' }) readonly replayed: number;
  @ApiProperty({ description: 'Segments written' }) readonly segments: number;
  @ApiProperty({ description: 'Segments removed before the rebuild' }) readonly deleted: number;
  @ApiProperty({ type: String, nullable: true }) readonly error: string | null;
  @ApiProperty({ format: 'date-time' }) readonly createdAt: string;
  @ApiProperty({ type: String, format: 'date-time', nullable: true }) readonly finishedAt: string | null;

  constructor(job: RecomputeJob) {
    this.id = job.id;
    this.mmsi = job.mmsi;
    this.from = job.fromTime.toISOString();
    this.to = job.toTime.toISOString();
    this.status = job.status;
    this.replayed = job.replayed;
    this.segments = job.segments;
    this.deleted = job.deleted;
    this.error = job.error;
    this.createdAt = job.createdAt.toISOString();
    this.finishedAt = isoOrNull(job.finishedAt);
  }
}
