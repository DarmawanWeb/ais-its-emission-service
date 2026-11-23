import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { csvDocument } from '../src/common/csv.js';
import { DCS_CSV_COLUMNS } from '../src/domain/dcs.js';
import { LEGACY_SEEMP_MEASURES } from '../src/domain/seemp/measures.js';
import { SEGMENT_CSV_COLUMNS } from '../src/modules/cii/segment-csv.js';
import { IMPLEMENTED_METHOD_IDS } from '../src/modules/methodology/implemented-methods.js';
import { SERVICE } from '../src/service.js';
import { startTestService, type TestService } from './support/test-service.js';

const METHODOLOGY_URL = `/api/v2/${SERVICE.name}/methodology`;

describe(`${SERVICE.packageName} platform behaviour`, () => {
  let service: TestService;

  beforeAll(async () => {
    service = await startTestService();
  });

  afterAll(async () => {
    await service.close();
  });

  it('is live and ready with the database, NATS and Valkey up', async () => {
    expect(
      (await service.request({ url: '/health/live', as: null })).statusCode,
    ).toBe(200);
    const ready = await service.request({ url: '/health/ready', as: null });
    expect(ready.statusCode).toBe(200);
    expect(ready.json()).toMatchObject({
      status: 'ok',
      details: {
        database: { status: 'up' },
        nats: { status: 'up' },
        redis: { status: 'up' },
      },
    });
  });

  it('applied the migrations to its own schema, with the reference seeds', async () => {
    const { rows } = await service.pool.query<{ name: string }>(
      'SELECT name FROM schema_migrations ORDER BY version',
    );
    expect(rows.map((row) => row.name)).toEqual([
      'init',
      'seed',
      'cii_aggregates',
      'vessel_scoped_history',
      'cii_aggregates_per_vessel',
    ]);
    const hypertables = await service.pool.query<{ name: string }>(
      `SELECT hypertable_name AS name FROM timescaledb_information.hypertables WHERE hypertable_schema = 'emission' ORDER BY 1`,
    );
    expect(hypertables.rows.map((row) => row.name)).toEqual([
      'fuel_readings',
      'segments',
    ]);
    const aggregates = await service.pool.query<{
      name: string;
      realtime: boolean;
    }>(
      `SELECT view_name AS name, NOT materialized_only AS realtime FROM timescaledb_information.continuous_aggregates
        WHERE view_schema = 'emission' ORDER BY 1`,
    );
    expect(aggregates.rows).toEqual([
      { name: 'cii_annual', realtime: true },
      { name: 'cii_daily', realtime: true },
    ]);
    // the aggregates are per vessel, not per MMSI (0005)
    const keys = await service.pool.query<{ view: string; column: string }>(
      `SELECT table_name AS view, column_name AS column FROM information_schema.columns
        WHERE table_schema = 'emission' AND table_name IN ('cii_daily', 'cii_annual')
          AND column_name IN ('vessel_id', 'mmsi') ORDER BY 1, 2`,
    );
    expect(keys.rows).toEqual([
      { view: 'cii_annual', column: 'vessel_id' },
      { view: 'cii_daily', column: 'vessel_id' },
    ]);
  });

  it('seeds the reduction factors of MEPC.338(76) and MEPC.400(83)', async () => {
    const response = await service.request({
      url: '/api/v2/reduction-factors',
    });
    expect(response.statusCode).toBe(200);
    const { data } = response.json<{
      data: { year: number; zPercent: number; source: string }[];
    }>();
    expect(
      data
        .filter((row) => row.year >= 2023 && row.year <= 2030)
        .map((row) => [row.year, row.zPercent]),
    ).toEqual([
      [2023, 5],
      [2024, 7],
      [2025, 9],
      [2026, 11],
      [2027, 13.625],
      [2028, 16.25],
      [2029, 18.875],
      [2030, 21.5],
    ]);
    expect(data.find((row) => row.year === 2026)?.source).toContain(
      'MEPC.338(76)',
    );
    expect(data.find((row) => row.year === 2030)?.source).toContain(
      'MEPC.400(83)',
    );
  });

  it('seeds the 12 legacy SEEMP measures exactly as the domain catalog', async () => {
    const response = await service.request({ url: '/api/v2/seemp/measures' });
    expect(response.statusCode).toBe(200);
    const { data } = response.json<{
      data: {
        code: string;
        name: string;
        legacyOrder: number;
        methodId: string;
        reduction: unknown;
        cost: unknown;
      }[];
    }>();
    expect(
      data.map(({ code, name, legacyOrder, methodId, reduction, cost }) => ({
        code,
        name,
        legacyOrder,
        methodId,
        reduction,
        cost,
      })),
    ).toEqual(
      LEGACY_SEEMP_MEASURES.map(
        ({ code, name, legacyOrder, methodId, reduction, cost }) => ({
          code,
          name,
          legacyOrder,
          methodId,
          reduction,
          cost,
        }),
      ),
    );
  });

  it('denies anonymous requests with 401 problem details', async () => {
    const response = await service.request({ url: METHODOLOGY_URL, as: null });
    expect(response.statusCode).toBe(401);
    expect(response.headers['content-type']).toContain(
      'application/problem+json',
    );
  });

  it('serves the methodology to any signed-in user (spec §17)', async () => {
    const response = await service.request({
      url: METHODOLOGY_URL,
      as: { roles: ['authority'] },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json<{
      service: string;
      methods: {
        id: string;
        catalogued: boolean;
        formulaLatex: string | null;
        references: unknown[];
      }[];
      reductionFactors: { year: number; source: string }[];
      vesselTypes: unknown[];
      attribution: string;
    }>();
    expect(body.service).toBe(SERVICE.name);
    expect(body.methods.map((method) => method.id)).toEqual([
      ...new Set(IMPLEMENTED_METHOD_IDS),
    ]);
    const attained = body.methods.find(
      (method) => method.id === 'cii.attained_accumulation',
    );
    expect(attained).toMatchObject({ catalogued: true });
    expect(attained?.references.length).toBeGreaterThan(0);
    // Contracts 0.4.0 catalogues the four ids proposed by 0.1 (CTR-8): every
    // method of the service now has its catalog details.
    expect(
      body.methods
        .filter((method) => !method.catalogued)
        .map((method) => method.id),
    ).toEqual([]);
    for (const id of [
      'cii.year_end_projection',
      'emission.dcs_summary',
      'emission.segment_window',
      'seemp.simulation_combination',
    ])
      expect(
        body.methods.find((method) => method.id === id),
        id,
      ).toMatchObject({ catalogued: true });
    expect(
      body.reductionFactors.find((factor) => factor.year === 2026)?.source,
    ).toContain('MEPC.338(76)');
    expect(body.attribution).toBe('Weather data by Open-Meteo.com (CC BY 4.0)');
  });

  it('documents its routes in /openapi.json', async () => {
    const response = await service.request({ url: '/openapi.json', as: null });
    expect(response.statusCode).toBe(200);
    expect(
      Object.keys(response.json<{ paths: Record<string, unknown> }>().paths),
    ).toEqual(
      expect.arrayContaining([
        METHODOLOGY_URL,
        '/api/v2/cii/vessels/{mmsi}/current',
        '/api/v2/cii/vessels/{mmsi}/daily',
        '/api/v2/cii/vessels/{mmsi}/annual',
        '/api/v2/cii/vessels/{mmsi}/segments',
        '/api/v2/cii/fleet/summary',
        '/api/v2/cii/vessels/{mmsi}/annual-manual/{year}',
        '/api/v2/cii/vessels/{mmsi}/recompute',
        '/api/v2/cii/fleet/fuel',
        '/api/v2/cii/recompute-jobs',
        '/api/v2/cii/recompute-jobs/{id}',
        '/api/v2/reduction-factors',
        '/api/v2/reduction-factors/{year}',
        '/api/v2/seemp/measures',
        '/api/v2/seemp/vessels/{mmsi}/recommendations',
        '/api/v2/seemp/vessels/{mmsi}/simulate',
        '/api/v2/seemp/scenarios',
        '/api/v2/seemp/scenarios/{id}',
        '/api/v2/emission/vessels/{mmsi}/dcs',
        '/api/v2/emission/fleet/dcs',
      ]),
    );
  });

  // `@ApiProduces('application/json', 'text/csv')` with a typed response put
  // the JSON schema under text/csv too: generated clients typed the CSV
  // download as the JSON object, and its headers were not documented.
  it('documents the CSV representations as text with their headers', async () => {
    interface OkResponse {
      content: Record<string, { schema: unknown; example?: unknown }>;
      headers?: Record<string, unknown>;
    }
    const { paths } = (
      await service.request({ url: '/openapi.json', as: null })
    ).json<{
      paths: Record<string, { get: { responses: Record<string, OkResponse> } }>;
    }>();
    const routes = [
      {
        path: '/api/v2/cii/vessels/{mmsi}/segments',
        json: {
          type: 'object',
          required: ['data', 'page'],
          properties: {
            data: {
              type: 'array',
              items: { $ref: '#/components/schemas/SegmentDto' },
            },
            page: { $ref: '#/components/schemas/CursorPageInfoDto' },
          },
        },
        header: csvDocument(SEGMENT_CSV_COLUMNS, []),
        headers: ['Content-Disposition', 'X-Truncated'],
      },
      {
        path: '/api/v2/emission/vessels/{mmsi}/dcs',
        json: { $ref: '#/components/schemas/DcsSummaryDto' },
        header: csvDocument(DCS_CSV_COLUMNS, []),
        headers: ['Content-Disposition'],
      },
      {
        path: '/api/v2/emission/fleet/dcs',
        json: { $ref: '#/components/schemas/FleetDcsDto' },
        header: csvDocument(DCS_CSV_COLUMNS, []),
        headers: ['Content-Disposition'],
      },
    ];
    for (const route of routes) {
      const ok = paths[route.path]?.get.responses['200'];
      expect(Object.keys(ok?.content ?? {}), route.path).toEqual([
        'application/json',
        'text/csv',
      ]);
      expect(ok?.content['application/json']?.schema, route.path).toEqual(
        route.json,
      );
      expect(ok?.content['text/csv'], route.path).toEqual({
        schema: { type: 'string' },
        example: route.header,
      });
      expect(Object.keys(ok?.headers ?? {}), route.path).toEqual(route.headers);
    }
  });

  it('exposes Prometheus metrics, including the domain metrics', async () => {
    const response = await service.request({ url: '/metrics', as: null });
    expect(response.statusCode).toBe(200);
    expect(response.body).toContain('aisits_http_requests_total');
    expect(response.body).toContain('aisits_emission_segments_total');
    expect(response.body).toContain('aisits_weather_cache_hits_total');
  });
});
