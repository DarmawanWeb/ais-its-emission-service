import { describe, expect, it } from 'vitest';

import {
  compileFormula,
  FormulaSyntaxError,
  formulaSyntaxError,
  MAX_FORMULA_LENGTH,
} from './evaluator.js';

const evaluate = (source: string, speedKnot: number): number =>
  compileFormula(source).evaluate({ speedKnot });

describe('safe formula evaluator (spec §13.5 grammar)', () => {
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
    ['pow(2)', 'Wrong number of arguments for pow'],
    ['(1 + 2', 'Expected ")"'],
    ['1 + 2)', 'Unexpected token'],
    ['speedKnot; 1', 'Unexpected character ";"'],
    ['`${1}`', 'Unexpected character "`"'],
    ['speedKnot = 1', 'Unexpected character "="'],
    ['', 'Unexpected end of formula'],
  ])('refuses %j', (source, message) => {
    expect(() => compileFormula(source)).toThrow(FormulaSyntaxError);
    expect(formulaSyntaxError(source)?.message).toContain(message);
  });

  it('limits the length and the nesting depth', () => {
    expect(
      formulaSyntaxError('1'.repeat(MAX_FORMULA_LENGTH + 1))?.message,
    ).toContain('longer than');
    expect(
      formulaSyntaxError(`${'('.repeat(100)}1${')'.repeat(100)}`)?.message,
    ).toContain('nested too deeply');
    expect(formulaSyntaxError(`${'-'.repeat(100)}1`)?.message).toContain(
      'nested too deeply',
    );
  });

  it('reports the position of the problem', () => {
    expect(formulaSyntaxError('1 + foo')?.position).toBe(4);
  });
});
