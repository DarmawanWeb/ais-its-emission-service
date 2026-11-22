/** SQLSTATE of a unique constraint violation. */
export const PG_UNIQUE_VIOLATION = '23505';

/**
 * SQLSTATE `lock_not_available`. TimescaleDB raises it when a refresh of a
 * continuous aggregate overlaps a refresh in progress ("could not refresh
 * continuous aggregate … due to a concurrent refresh"), e.g. a policy job.
 */
export const PG_LOCK_NOT_AVAILABLE = '55P03';

/**
 * The PostgreSQL error with `code` in `error` or one of its causes (drizzle
 * wraps driver errors in `DrizzleQueryError`), if any.
 */
function findPgError(
  error: unknown,
  code: string,
): (Error & { readonly constraint?: unknown }) | undefined {
  let current: unknown = error;
  for (let depth = 0; current instanceof Error && depth < 8; depth += 1) {
    if ('code' in current && current.code === code) return current;
    current = current.cause;
  }
  return undefined;
}

/**
 * `true` when `error` (or one of its causes) is a PostgreSQL unique
 * violation, optionally of the named constraint.
 *
 * @example
 * catch (error) {
 *   if (isUniqueViolation(error, 'notes_org_mmsi_title_key')) throw new ConflictError(…);
 *   throw error;
 * }
 */
export function isUniqueViolation(
  error: unknown,
  constraint?: string,
): boolean {
  const found = findPgError(error, PG_UNIQUE_VIOLATION);
  return (
    found !== undefined &&
    (constraint === undefined || found.constraint === constraint)
  );
}

/** `true` when `error` (or one of its causes) is `lock_not_available` (55P03). */
export function isLockNotAvailable(error: unknown): boolean {
  return findPgError(error, PG_LOCK_NOT_AVAILABLE) !== undefined;
}
