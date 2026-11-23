import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { describe, expect, it } from 'vitest';

import {
  ListScenariosQuery,
  RenameScenarioDto,
  SeempRecommendationsQuery,
  SimulateDto,
} from './seemp.dto.js';

/** Validates like the kit's ValidationPipe (whitelist, forbidNonWhitelisted). */
async function errorsOf(
  type: new () => object,
  input: Record<string, unknown>,
): Promise<Record<string, string[]>> {
  const errors = await validate(plainToInstance(type, input), {
    whitelist: true,
    forbidNonWhitelisted: true,
  });
  return Object.fromEntries(
    errors.map((error) => [
      error.property,
      Object.keys(error.constraints ?? {}).sort(),
    ]),
  );
}

describe('SEEMP DTOs', () => {
  it('parses includeAll strictly', async () => {
    expect(
      plainToInstance(SeempRecommendationsQuery, { includeAll: 'true' })
        .includeAll,
    ).toBe(true);
    expect(
      await errorsOf(SeempRecommendationsQuery, { includeAll: 'false' }),
    ).toEqual({});
    expect(
      await errorsOf(SeempRecommendationsQuery, { includeAll: 'yes' }),
    ).toEqual({
      includeAll: ['isBoolean'],
    });
  });

  it('rejects null years in a simulation body instead of ignoring them', async () => {
    expect(
      await errorsOf(SimulateDto, {
        measureCodes: ['solar'],
        year: null,
        targetYear: null,
      }),
    ).toEqual({
      year: ['isInt', 'max', 'min'],
      targetYear: ['isInt', 'max', 'min'],
    });
    expect(await errorsOf(SimulateDto, { measureCodes: ['solar'] })).toEqual(
      {},
    );
  });

  it('validates the scenario list and the rename', async () => {
    const query = plainToInstance(ListScenariosQuery, { search: ' hull ' });
    expect(query.sort).toBe('-createdAt');
    expect(query.search).toBe('hull');
    expect(await errorsOf(ListScenariosQuery, { sort: 'vesselName' })).toEqual(
      {},
    );
    expect(await errorsOf(ListScenariosQuery, { sort: 'cost' })).toEqual({
      sort: ['isIn'],
    });
    expect(await errorsOf(RenameScenarioDto, { name: '' })).toEqual({
      name: ['isLength'],
    });
    expect(await errorsOf(RenameScenarioDto, {})).toEqual({
      name: ['isLength', 'isString'],
    });
  });
});
