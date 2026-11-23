import { describe, expect, it } from 'vitest';

import { wantsCsv } from '../common/csv.js';
import { dcsSummaryOf } from '../modules/dcs/dcs.service.js';
import { dcsCsv, type DcsSummary, fleetDcsCsv } from './dcs.js';

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

describe('fleetDcsCsv', () => {
  it('writes one header and the rows of every vessel in the per-vessel layout', () => {
    const other: DcsSummary = {
      ...summary,
      mmsi: 525100001,
      imo: null,
      vesselName: 'KM Kedua',
      source: 'manual',
      hoursUnderWay: null,
    };
    const lines = fleetDcsCsv([summary, other]).split('\r\n');
    const single = dcsCsv(summary).split('\r\n');
    expect(lines[0]).toBe(single[0]);
    expect(lines.slice(1, single.length - 1)).toEqual(single.slice(1, -1));
    expect(
      lines.filter((line) => line.startsWith('2026,525100001,')),
    ).toHaveLength(summary.fuel.length);
    expect(lines.at(-1)).toBe('');
    expect(fleetDcsCsv([])).toBe(`${single[0] ?? ''}\r\n`);
  });
});

describe('dcsSummaryOf', () => {
  const vessel = {
    mmsi: 525005223,
    imo: '9037941',
    name: 'Dharma Ferry VIII',
    fuel: { code: 'mgo', name: 'Diesel/Gas Oil', conversionFactor: 3.206 },
  };
  const record = {
    vesselId: '0190d5c0-0000-7000-8000-000000000001',
    mmsi: 525005223,
    year: 2024,
    attained: 10,
    required: null,
    rating: null,
    grade: null,
    distanceNm: 1000,
    fuelMeTon: 100,
    fuelAeTon: 20,
    co2Ton: null,
    note: null,
    updatedBy: null,
    updatedAt: new Date(0),
  };

  it('sums the segments per fuel, else falls back to the manual record, else nothing', () => {
    const fromSegments = dcsSummaryOf(
      vessel,
      2026,
      [
        {
          fuelCode: 'mgo',
          conversionFactor: 3.206,
          fuelMeTon: 1.5,
          fuelAeTon: 0.25,
          co2Ton: 5.6105,
          distanceNm: 40,
          hours: 5,
          hoursUnderWay: 4,
          segments: 10,
        },
      ],
      record,
    );
    expect(fromSegments).toMatchObject({
      source: 'segments',
      distanceNm: 40,
      hoursUnderWay: 4,
      fuel: [{ fuelName: 'Diesel/Gas Oil', totalTon: 1.75 }],
    });
    const fromManual = dcsSummaryOf(vessel, 2024, [], record);
    expect(fromManual).toMatchObject({
      source: 'manual',
      hoursUnderWay: null,
      distanceNm: 1000,
      fuel: [{ fuelCode: 'mgo', totalTon: 120 }],
    });
    expect(fromManual?.co2Ton).toBeCloseTo(120 * 3.206, 10);
    expect(dcsSummaryOf(vessel, 2023, [], undefined)).toBeUndefined();
  });
});
