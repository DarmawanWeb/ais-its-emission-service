import {
  evaluateFuelFormula,
  FUEL_FORMULA_LIMITS,
  FuelFormulaSyntaxError,
  parseFuelFormula,
  validateFuelFormula,
} from '@darmawanweb/ais-its-contracts/domain';
import { describe, expect, it } from 'vitest';

/**
 * Regression tests of the first fuel formula grammar this service evaluates
 * (contracts `parseFuelFormula` / `evaluateFuelFormula`, which replaced the
 * service's own evaluator in 0.2.0 with bit-identical values).
 */
const evaluate = (source: string, speedKnot: number): number =>
  evaluateFuelFormula(parseFuelFormula(source), { speedKnot });

/** The message of a refused formula, `<reason> at position <n>`. */
const messageOf = (source: string): string | undefined => {
  const result = validateFuelFormula(source);
  return result.valid ? undefined : result.errors[0].message;
};

describe('first fuel formula grammar (contracts, spec §13.5)', () => {
  const speeds = [0, 0.5, 7.25, 12.979254311241013, 30];

  /** Valid JavaScript formulas and the same expression written in TypeScript: results must be bit-identical. */
  const formulas: readonly [string, (v: number) => number][] = [
    [
      '-0.0382 * speedKnot ** 2 + 0.8658 * speedKnot - 0.0197',
      (v) => -0.0382 * v ** 2 + 0.8658 * v - 0.0197,
    ],
    [
      '1.5103 * Math.exp(-0.064 * speedKnot)',
      (v) => 1.5103 * Math.exp(-0.064 * v),
    ],
    [
      '0.012 * Math.pow(speedKnot, 3) + Math.sqrt(speedKnot) / 4 + 2',
      (v) => 0.012 * Math.pow(v, 3) + Math.sqrt(v) / 4 + 2,
    ],
    [
      'Math.max(0.8, 1.2 - 0.01 * speedKnot)',
      (v) => Math.max(0.8, 1.2 - 0.01 * v),
    ],
    [
      'Math.log(speedKnot + 1) * 3 + Math.abs(-2) + Math.min(speedKnot, 10) / 10',
      (v) => Math.log(v + 1) * 3 + Math.abs(-2) + Math.min(v, 10) / 10,
    ],
    ['(1 + 2) * (0.25 + speedKnot / 100)', (v) => (1 + 2) * (0.25 + v / 100)],
    ['2 ** 3 ** 0.5 - speedKnot / 2 / 3', (v) => 2 ** (3 ** 0.5) - v / 2 / 3],
    ['1e-3 * speedKnot ** -1.5 + .5 + 4.', (v) => 1e-3 * v ** -1.5 + 0.5 + 4],
    ['- -speedKnot + +1', (v) => v + 1],
    [
      'Math.min(speedKnot, 3, 1 + speedKnot / 10) * Math.max(1, speedKnot)',
      (v) => Math.min(v, 3, 1 + v / 10) * Math.max(1, v),
    ],
  ];

  it.each(formulas)(
    'evaluates %s exactly like JavaScript',
    (source, reference) => {
      for (const v of speeds)
        expect(
          Object.is(evaluate(source, v), reference(v)),
          `${source} at ${v} kn`,
        ).toBe(true);
    },
  );

  it('accepts the functions without the Math. prefix, ln as the natural logarithm and ^ as power (spec §15.4)', () => {
    expect(evaluate('exp(1) + ln(speedKnot) + log(speedKnot)', 2)).toBe(
      Math.exp(1) + Math.log(2) + Math.log(2),
    );
    expect(evaluate('speedKnot ^ 2', 3)).toBe(9);
    expect(evaluate('2 ^ 3 ^ 2', 0)).toBe(512);
    expect(evaluate('-speedKnot ^ 2', 3)).toBe(-9);
  });

  it.each([
    ['0.5 * speedKnot +', 'Unexpected end of formula'],
    ['speed * 2', 'Unknown identifier "speed"'],
    ['process.exit(1)', 'Unknown identifier "process.exit"'],
    ['Math.PI * speedKnot', 'Unknown identifier "Math.PI"'],
    ['constructor', 'Unknown identifier "constructor"'],
    ['toString(1)', 'Unknown identifier "toString"'],
    ['pow(2)', 'pow() takes 2 arguments, got 1 at position 0'],
    ['(1 + 2', 'Expected ")" at position 6'],
    ['1 + 2)', 'Unexpected ")" at position 5'],
    ['speedKnot; 1', 'Unexpected character ";" at position 9'],
    ['`${1}`', 'Unexpected character "`" at position 0'],
    ['speedKnot = 1', 'Unexpected character "=" at position 10'],
    ['', 'Empty formula at position 0'],
    ['   ', 'Empty formula at position 0'],
    ['1e999 * speedKnot', 'Number 1e999 is out of range at position 0'],
  ])('refuses %j', (source, message) => {
    expect(() => parseFuelFormula(source)).toThrow(FuelFormulaSyntaxError);
    expect(messageOf(source)).toContain(message);
  });

  it('limits the length to 500 characters and the nesting depth to 32', () => {
    expect(FUEL_FORMULA_LIMITS).toMatchObject({ maxLength: 500, maxDepth: 32 });
    expect(messageOf('1'.repeat(FUEL_FORMULA_LIMITS.maxLength + 1))).toBe(
      'Longer than 500 characters at position 500',
    );
    expect(messageOf(`${'('.repeat(100)}1${')'.repeat(100)}`)).toBe(
      'Nested deeper than 32 levels at position 33',
    );
    expect(messageOf(`${'-'.repeat(100)}1`)).toBe(
      'Nested deeper than 32 levels at position 33',
    );
  });

  it('reports the position of the problem', () => {
    const result = validateFuelFormula('1 + foo');
    expect(result.valid ? undefined : result.errors[0].position).toBe(4);
  });
});
