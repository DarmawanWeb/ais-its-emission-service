/**
 * Minimum segment speed counted as "under way", knots: the Fourth IMO GHG
 * Study classifies AIS speeds below 1 kn as at berth / at anchor.
 *
 * @method emission.dcs_summary
 * @see https://www.imo.org/en/OurWork/Environment/Pages/Fourth-IMO-Greenhouse-Gas-Study-2020.aspx
 */
export const UNDER_WAY_MIN_SPEED_KN = 1;

/** Fuel consumed per fuel type in a DCS summary. */
export interface DcsFuelLine {
  readonly fuelCode: string;
  readonly fuelName: string;
  /** C_F of the fuel, t CO2 / t fuel. */
  readonly conversionFactor: number;
  readonly fuelMeTon: number;
  readonly fuelAeTon: number;
  readonly totalTon: number;
  readonly co2Ton: number;
}

/** IMO DCS-style annual summary of a vessel (not the statutory MEPC.385(81) report). */
export interface DcsSummary {
  readonly year: number;
  readonly mmsi: number;
  readonly imo: string | null;
  readonly vesselName: string;
  readonly source: 'segments' | 'manual';
  readonly fuel: readonly DcsFuelLine[];
  readonly distanceNm: number;
  /** Hours of counted segments at ≥ {@link UNDER_WAY_MIN_SPEED_KN}; `null` for manual records. */
  readonly hoursUnderWay: number | null;
  readonly co2Ton: number;
}

const CSV_COLUMNS = [
  'year',
  'mmsi',
  'imo',
  'vessel_name',
  'source',
  'fuel_code',
  'fuel_name',
  'conversion_factor',
  'fuel_me_t',
  'fuel_ae_t',
  'fuel_total_t',
  'co2_t',
  'distance_nm',
  'hours_under_way',
  'total_co2_t',
] as const;

/** Leading characters that make spreadsheet applications evaluate a cell as a formula. */
const FORMULA_PREFIX = /^[=+\-@\t\r]/;

/**
 * RFC 4180 field: quoted when it contains a comma, quote or line break. Text
 * (never numbers) starting like a spreadsheet formula gets a leading `'`
 * (CSV injection, OWASP).
 */
function csvField(value: string | number | null): string {
  if (value === null) return '';
  const text =
    typeof value === 'number'
      ? String(value)
      : FORMULA_PREFIX.test(value)
        ? `'${value}`
        : value;
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

/**
 * CSV of a DCS summary (RFC 4180, CRLF line ends): one row per fuel type,
 * the vessel totals repeated on every row.
 *
 * @method emission.dcs_summary
 */
export function dcsCsv(summary: DcsSummary): string {
  const rows = summary.fuel.map((line) =>
    [
      summary.year,
      summary.mmsi,
      summary.imo,
      summary.vesselName,
      summary.source,
      line.fuelCode,
      line.fuelName,
      line.conversionFactor,
      line.fuelMeTon,
      line.fuelAeTon,
      line.totalTon,
      line.co2Ton,
      summary.distanceNm,
      summary.hoursUnderWay,
      summary.co2Ton,
    ]
      .map(csvField)
      .join(','),
  );
  return `${[CSV_COLUMNS.join(','), ...rows].join('\r\n')}\r\n`;
}
