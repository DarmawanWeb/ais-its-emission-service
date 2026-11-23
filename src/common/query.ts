import type { TransformFnParams } from 'class-transformer';

/** Trims a string query value (other values pass through to the validators). */
export function trimString({ value }: TransformFnParams): unknown {
  return typeof value === 'string' ? value.trim() : value;
}

/**
 * A comma-separated list (`grade=D,E`), also accepting repeated keys
 * (`grade=D&grade=E`): trimmed, empty entries dropped. Other values pass
 * through so that the validators reject them.
 */
export function commaList({ value }: TransformFnParams): unknown {
  const parts =
    typeof value === 'string'
      ? [value]
      : Array.isArray(value) && value.every((part) => typeof part === 'string')
        ? value
        : undefined;
  if (parts === undefined) return value;
  return parts
    .flatMap((part) => part.split(','))
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

/** {@link commaList} in upper case (grades). */
export function upperCommaList(params: TransformFnParams): unknown {
  const list = commaList(params);
  return Array.isArray(list)
    ? list.map((part: unknown) =>
        typeof part === 'string' ? part.toUpperCase() : part,
      )
    : list;
}

/**
 * A strict boolean query value: `true` / `false` only (no `1`, `yes` or
 * empty string, which `@IsBoolean()` then rejects with 400).
 */
export function booleanQuery({ value }: TransformFnParams): unknown {
  if (value === 'true') return true;
  if (value === 'false') return false;
  return value;
}

/** A signed sort key: `name` ascending, `-name` descending. */
export interface SortOrder<Key extends string> {
  readonly key: Key;
  readonly descending: boolean;
}

/** Every signed form of the sort keys, for `@IsIn` and the OpenAPI enum. */
export function signedSortKeys<const Key extends string>(
  keys: readonly Key[],
): (Key | `-${Key}`)[] {
  return keys.flatMap((key) => [key, `-${key}` as const]);
}

/** Parses a signed sort key validated against {@link signedSortKeys}. */
export function sortOrderOf<Key extends string>(
  sort: Key | `-${Key}`,
): SortOrder<Key> {
  return sort.startsWith('-')
    ? { key: sort.slice(1) as Key, descending: true }
    : { key: sort as Key, descending: false };
}
