/** Leading characters that make spreadsheet applications evaluate a cell as a formula. */
const FORMULA_PREFIX = /^[=+\-@\t\r]/;

/** A CSV cell value; `null` is an empty cell. */
export type CsvValue = string | number | boolean | null;

/**
 * RFC 4180 field: quoted when it contains a comma, quote or line break. Text
 * (never numbers) starting like a spreadsheet formula gets a leading `'`
 * (CSV injection, OWASP).
 */
export function csvField(value: CsvValue): string {
  if (value === null) return '';
  const text =
    typeof value === 'number' || typeof value === 'boolean'
      ? String(value)
      : FORMULA_PREFIX.test(value)
        ? `'${value}`
        : value;
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

/** A CSV document (RFC 4180, CRLF line ends) with a header row. */
export function csvDocument(
  columns: readonly string[],
  rows: readonly (readonly CsvValue[])[],
): string {
  const lines = [
    columns.join(','),
    ...rows.map((row) => row.map(csvField).join(',')),
  ];
  return `${lines.join('\r\n')}\r\n`;
}

/** `true` when the client prefers CSV (`Accept: text/csv`) over JSON. */
export function wantsCsv(accept: string | undefined): boolean {
  if (accept === undefined) return false;
  const types = accept
    .split(',')
    .map((part) => part.split(';')[0]?.trim().toLowerCase());
  const csv = types.indexOf('text/csv');
  const json = types.findIndex(
    (type) => type === 'application/json' || type === 'application/*',
  );
  return csv !== -1 && (json === -1 || csv < json);
}

/** Response header telling that a CSV export was cut at its row limit. */
export const TRUNCATED_HEADER = 'X-Truncated';

/** A response whose headers can be read and set (Fastify's `FastifyReply`). */
export interface HeaderReply {
  getHeader(name: string): string | number | string[] | undefined;
  header(name: string, value: string): unknown;
}

/**
 * Adds `field` to the `Vary` header of `reply`, keeping the fields already
 * listed (RFC 9110 §12.5.5). The CORS hook sets `Vary: Origin` on every
 * response, since the allowed origins are a list; a route negotiated with
 * {@link wantsCsv} must vary on both, which Nest's `@Header('vary', …)`
 * cannot do (it replaces the header). `*` stays `*`.
 */
export function addVary(reply: HeaderReply, field: string): void {
  const current = reply.getHeader('vary');
  const listed = (
    Array.isArray(current)
      ? current
      : current === undefined
        ? []
        : [String(current)]
  )
    .flatMap((value) => value.split(','))
    .map((value) => value.trim())
    .filter((value) => value !== '');
  const names = listed.map((value) => value.toLowerCase());
  if (names.includes('*') || names.includes(field.toLowerCase())) return;
  reply.header('vary', [...listed, field].join(', '));
}
