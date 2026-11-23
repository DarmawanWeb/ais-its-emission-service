import { readdirSync, readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

const read = (path: string): string =>
  readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const README = read('README.md');
const CHANGELOG = read('CHANGELOG.md');

/** The text after the line `heading`, up to the next heading of its level or a higher one. */
function section(text: string, heading: string): string {
  const start = text.indexOf(`\n${heading}\n`);
  expect(start, heading).toBeGreaterThanOrEqual(0);
  const level = heading.indexOf(' ');
  const rest = text.slice(start + heading.length + 2);
  const end = rest.search(new RegExp(`\\n#{1,${level}} `));
  return end === -1 ? rest : rest.slice(0, end);
}

/**
 * The Markdown list items of `text` that start at `indent`, each with its
 * continuation lines (indented further), as Markdown renders them.
 */
function listItems(text: string, indent = ''): string[] {
  const items: string[][] = [];
  let open = false;
  for (const line of text.split('\n')) {
    if (line.startsWith(`${indent}- `)) {
      items.push([line]);
      open = true;
    } else if (open && (line === '' || line.startsWith(`${indent}  `))) {
      items.at(-1)?.push(line);
    } else {
      open = false;
    }
  }
  return items.map((lines) => lines.join('\n'));
}

/** The one item that starts with `start` (after its indentation). */
function item(items: readonly string[], start: string): string {
  const matches = items.filter((candidate) =>
    candidate.trimStart().startsWith(start),
  );
  expect(matches, start).toHaveLength(1);
  return matches[0] ?? '';
}

/** `text` on one line: wrapping and indentation do not change the prose. */
const flat = (text: string): string => text.replace(/\s+/g, ' ').trim();

/** The CHANGELOG entry of 0.2.0, and its introduction (before the first `###`). */
const release = (): string => section(CHANGELOG, '## [0.2.0] - 2026-11-23');
const intro = (): string => {
  const entry = release();
  return flat(entry.slice(0, entry.indexOf('\n### ')));
};

describe('rolling update to 0.2.0', () => {
  const rolling = (): string =>
    item(
      listItems(section(README, '## Operations')),
      '- **Rolling update to 0.2.0**',
    );
  /** The sub-item of the rolling update that starts with `start`, on one line. */
  const upgrade = (start: string): string =>
    flat(item(listItems(rolling(), '  '), start));
  const fromMain = (): string => upgrade('- From a build');
  const fromRelease = (): string => upgrade('- From the **0.1.0 release**');

  // "No migration" only holds against a build that applied the newest
  // migration: the 0.1.0 release has 0001–0003, 0.2.0 brings 0004 and 0005.
  it('names the newest migration as the one an older build must have applied', () => {
    const migrations = readdirSync(new URL('../migrations', import.meta.url))
      .filter((name) => name.endsWith('.sql'))
      .sort();
    expect(migrations.at(-1)).toBe('0005_cii_aggregates_per_vessel.sql');
    expect(fromMain()).toContain(
      'already applied `0005_cii_aggregates_per_vessel`',
    );
    expect(fromMain()).toContain('holds version 5): no migration');
  });

  it('README: what an older replica answers to the new API, and the web app order', () => {
    // As a 0.1.0 replica answered the review's mixed-version run (one
    // database, one NATS): the ValidationPipe forbids unknown properties.
    for (const fact of [
      '`grade`, `search` and `sort` of the fleet summary',
      '`search` and `sort` of the scenario list',
      '`method` and `flag` of the segments',
      '`includeAll`) with `400 VALIDATION_FAILED`',
      '`GET /cii/fleet/fuel`',
      '`GET /emission/fleet/dcs`',
      '`GET /cii/recompute-jobs`',
      '`DELETE /cii/vessels/:mmsi/annual-manual/:year`',
      '`DELETE /reduction-factors/:year`',
      '`PATCH /seemp/scenarios/:id`) with `404 NOT_FOUND`',
      '`Accept: text/csv` on the segments with the JSON page',
      'a rollback is safe',
      'Finish the emission rollout before deploying a web app that uses the new parameters and routes',
      'map both `403 SUPER_ADMIN_REQUIRED` (older replicas) and `403 PLATFORM_ADMIN_REQUIRED` (0.2.0)',
    ]) {
      expect(fromMain()).toContain(fact);
    }
  });

  it('README: replicas of the 0.1.0 release are stopped before 0.2.0 migrates', () => {
    for (const fact of [
      'applies `0004` and `0005` at boot',
      'from then on 0.1.0 replicas fail',
      '`column "mmsi" does not exist`',
      'Stop every 0.1.0 replica before the first 0.2.0 replica starts',
      'going back to 0.1.0 needs the database backup taken before the upgrade',
    ]) {
      expect(fromRelease()).toContain(fact);
    }
    expect(fromRelease()).not.toContain('rollback is safe');
  });

  it('CHANGELOG 0.2.0: the introduction carries both cases', () => {
    for (const fact of [
      'From the 0.1.0 release (migrations 0001–0003) replicas of both versions cannot run side by side',
      'stop them first',
      'From a `main` build that already applied `0005`',
      '0.2.0 adds no migration',
      'a rollback is safe',
      '`400 VALIDATION_FAILED`',
      '`404 NOT_FOUND`',
      'Finish the emission rollout before deploying a web app that uses the new parameters and routes',
      'map both `403 SUPER_ADMIN_REQUIRED` and `403 PLATFORM_ADMIN_REQUIRED`',
    ]) {
      expect(intro()).toContain(fact);
    }
  });
});

describe('scenarios saved before 0.2.0', () => {
  const fields =
    '`vessel`, `baselineCo2Ton`, `co2AvoidedTon` and `costPerTonneUsd`';

  it('README and CHANGELOG say their result lacks the 0.2.0 fields', () => {
    expect(flat(README)).toContain(
      `scenarios saved before 0.2.0 lack ${fields} (optional there, not backfilled)`,
    );
    expect(flat(release())).toContain(
      `scenarios saved before 0.2.0 (or by a 0.1.x replica during the rollout) lack ${fields}`,
    );
  });
});

describe('DELETE /reduction-factors/:year', () => {
  const lock = 'LOCK TABLE reduction_factors IN EXCLUSIVE MODE';

  // The check and the delete lock the factor table only; the README must not
  // present the removal as safe against writes of the same year.
  it('README Known limitations: the lock does not block writes of the year', () => {
    expect(read('src/modules/cii/reduction-factors.repository.ts')).toContain(
      `'${lock}'`,
    );
    const limitation = flat(
      item(
        listItems(section(README, '## Known limitations')),
        '- `DELETE /reduction-factors/:year`',
      ),
    );
    for (const fact of [
      `under \`${lock}\`, which does not block segment or manual record writes`,
      'the next calendar year at New Year',
      '`422 REDUCTION_FACTOR_MISSING`',
      'until the year is added again with `PUT`',
    ]) {
      expect(limitation).toContain(fact);
    }
  });

  it('the API notes and the CHANGELOG point at the limitation', () => {
    const notes = flat(
      item(listItems(section(README, '## API')), '- **Reduction factors**'),
    );
    expect(notes).toContain(
      'Nothing is republished (no figure used the year when it was checked)',
    );
    expect(notes).toContain(
      'a segment or manual record of that year written at the same moment is not blocked',
    );
    expect(flat(release())).toContain(
      'a segment or manual record of the year written at the same moment, or later for a year about to receive data (the next calendar year at New Year), leaves its CII at `422 REDUCTION_FACTOR_MISSING`',
    );
  });
});
