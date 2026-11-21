import { describe, expect, it } from 'vitest';

import { wantsCsv } from '../modules/dcs/dcs.controller.js';
import { dcsCsv, type DcsSummary } from './dcs.js';

const mgo = {
  fuelCode: 'mgo',
  fuelName: 'Diesel/Gas Oil',
  conversionFactor: 3.206,
  fuelMeTon: 1.5,
  fuelAeTon: 0.25,
  totalTon: 1.75,
  co2Ton: 5.6105,
};

const summary: DcsSummary = {
  year: 2026,
  mmsi: 525005223,
  imo: '9037941',
  vesselName: 'Dharma Ferry VIII, "the ferry"',
  source: 'segments',
  fuel: [
    mgo,
    {
      fuelCode: 'hfo',
      fuelName: '=HYPERLINK("x")',
      conversionFactor: 3.114,
      fuelMeTon: 2,
      fuelAeTon: 0,
      totalTon: 2,
      co2Ton: 6.228,
    },
  ],
  distanceNm: 120.5,
  hoursUnderWay: 10.25,
  co2Ton: 11.8385,
};

describe('dcsCsv', () => {
  it('writes one RFC 4180 row per fuel type with the vessel totals', () => {
    const lines = dcsCsv(summary).split('\r\n');
    expect(lines[0]).toBe(
      'year,mmsi,imo,vessel_name,source,fuel_code,fuel_name,conversion_factor,fuel_me_t,fuel_ae_t,fuel_total_t,co2_t,distance_nm,hours_under_way,total_co2_t',
    );
    expect(lines[1]).toBe(
      '2026,525005223,9037941,"Dharma Ferry VIII, ""the ferry""",segments,mgo,Diesel/Gas Oil,3.206,1.5,0.25,1.75,5.6105,120.5,10.25,11.8385',
    );
    expect(lines).toHaveLength(4);
    expect(lines[3]).toBe('');
  });

  it('neutralizes text that a spreadsheet would run as a formula, never numbers', () => {
    const row = dcsCsv(summary).split('\r\n')[2] ?? '';
    expect(row).toContain(`"'=HYPERLINK(""x"")"`);
    expect(
      dcsCsv({
        ...summary,
        hoursUnderWay: null,
        fuel: [{ ...mgo, fuelMeTon: -0 }],
      }),
    ).toContain(',0,0.25,');
  });
});

describe('wantsCsv (content negotiation of GET …/dcs)', () => {
  it.each([
    [undefined, false],
    ['application/json', false],
    ['text/csv', true],
    ['text/csv;q=0.9, application/json', true],
    ['application/json, text/csv', false],
    ['*/*', false],
  ] as const)('%s → %s', (accept, csv) => {
    expect(wantsCsv(accept)).toBe(csv);
  });
});
