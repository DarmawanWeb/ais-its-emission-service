import { ValidationFailedError } from '@darmawanweb/ais-its-nest';
import { Injectable, type PipeTransform } from '@nestjs/common';

/** Parses an integer path parameter in `[min, max]`; `400 VALIDATION_FAILED` otherwise. */
abstract class IntegerParamPipe implements PipeTransform<string, number> {
  protected abstract readonly field: string;
  protected abstract readonly min: number;
  protected abstract readonly max: number;
  protected abstract readonly description: string;

  transform(value: string): number {
    const parsed = /^\d+$/.test(value) ? Number(value) : Number.NaN;
    if (
      !Number.isSafeInteger(parsed) ||
      parsed < this.min ||
      parsed > this.max
    ) {
      throw new ValidationFailedError([
        {
          field: this.field,
          message: `${this.field} must be ${this.description}`,
          code: 'isInt',
        },
      ]);
    }
    return parsed;
  }
}

/** `:mmsi` — a 9-digit MMSI. */
@Injectable()
export class ParseMmsiPipe extends IntegerParamPipe {
  protected readonly field = 'mmsi';
  protected readonly min = 100_000_000;
  protected readonly max = 999_999_999;
  protected readonly description = 'a 9-digit MMSI';
}

/** `:year` — a calendar year 2000–2200. */
@Injectable()
export class ParseYearPipe extends IntegerParamPipe {
  protected readonly field = 'year';
  protected readonly min = 2000;
  protected readonly max = 2200;
  protected readonly description = 'a year between 2000 and 2200';
}
