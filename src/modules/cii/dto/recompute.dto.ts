import { ApiProperty } from '@nestjs/swagger';

import { isoOrNull } from '../../../common/dto.js';
import type { RecomputeJob } from '../recompute-jobs.repository.js';

/** A recomputation job (`POST /cii/vessels/:mmsi/recompute`). */
export class RecomputeJobDto {
  @ApiProperty({ format: 'uuid' }) readonly id: string;
  @ApiProperty() readonly mmsi: number;
  @ApiProperty({
    type: String,
    format: 'uuid',
    nullable: true,
    description: 'The vessel whose segments are rebuilt',
  })
  readonly vesselId: string | null;
  @ApiProperty({ format: 'date-time' }) readonly from: string;
  @ApiProperty({ format: 'date-time' }) readonly to: string;
  @ApiProperty({ enum: ['running', 'succeeded', 'failed'] }) readonly status:
    'running' | 'succeeded' | 'failed';
  @ApiProperty({ description: 'Position events replayed in the range' })
  readonly replayed: number;
  @ApiProperty({ description: 'Segments written' }) readonly segments: number;
  @ApiProperty({
    description:
      'Segments of the range computed before the job that the replay did not produce again (deleted after a complete replay only)',
  })
  readonly deleted: number;
  @ApiProperty({
    type: String,
    nullable: true,
    description:
      'Why the job failed, `CODE: message` (INTERRUPTED, REPLAY_INCOMPLETE, NO_POSITIONS, VESSEL_CHANGED, or an unexpected error)',
  })
  readonly error: string | null;
  @ApiProperty({ format: 'date-time' }) readonly createdAt: string;
  @ApiProperty({
    format: 'date-time',
    description: 'Last sign of life of a running job (every 10 s)',
  })
  readonly heartbeatAt: string;
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  readonly finishedAt: string | null;

  constructor(job: RecomputeJob) {
    this.id = job.id;
    this.mmsi = job.mmsi;
    this.vesselId = job.vesselId;
    this.from = job.fromTime.toISOString();
    this.to = job.toTime.toISOString();
    this.status = job.status;
    this.replayed = job.replayed;
    this.segments = job.segments;
    this.deleted = job.deleted;
    this.error = job.error;
    this.createdAt = job.createdAt.toISOString();
    this.heartbeatAt = job.heartbeatAt.toISOString();
    this.finishedAt = isoOrNull(job.finishedAt);
  }
}
