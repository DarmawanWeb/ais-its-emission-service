import { describe, expect, it } from 'vitest';

import { baselineCo2Ton, co2AvoidedTon, costPerTonneUsd } from './co2.js';

describe('SEEMP CO2 figures', () => {
  it('uses the stored baseline CO2, else fuel × C_F of the current fuel', () => {
    expect(
      baselineCo2Ton({ co2Ton: 812.5, fuelMeTon: 200, fuelAeTon: 50 }, 3.206),
    ).toBe(812.5);
    expect(
      baselineCo2Ton({ co2Ton: null, fuelMeTon: 200, fuelAeTon: 50 }, 3.206),
    ).toBeCloseTo(801.5, 10);
  });

  it('scales the baseline CO2 like the attained CII (reduction percentage)', () => {
    // 20 % lower attained CII at the same distance and capacity.
    expect(co2AvoidedTon(1000, 5, 4)).toBeCloseTo(200, 10);
    // A measure that raises the attained CII avoids negative CO2.
    expect(co2AvoidedTon(1000, 5, 5.5)).toBeCloseTo(-100, 10);
    // No attained CII: nothing to scale.
    expect(co2AvoidedTon(1000, 0, 0)).toBe(0);
  });

  it('gives the cost per tonne avoided only when CO2 is avoided', () => {
    expect(costPerTonneUsd(30_540, 200)).toBeCloseTo(152.7, 10);
    expect(costPerTonneUsd(30_540, 0)).toBeNull();
    expect(costPerTonneUsd(30_540, -5)).toBeNull();
  });
});
