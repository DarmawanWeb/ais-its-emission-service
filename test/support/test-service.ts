import type {
  EventPayload,
  EventType,
} from '@darmawanweb/ais-its-contracts/events';
import { ACCESS_TOKEN_KEY_RESOLVER } from '@darmawanweb/ais-its-nest/auth';
import { type Pool, PG_POOL } from '@darmawanweb/ais-its-nest/db';
import { EventPublisher } from '@darmawanweb/ais-its-nest/nats';
import {
  buildTestApp,
  createTestConfig,
  createTestJwtIssuer,
  type TestJwtIssuer,
  type TestTokenClaims,
  uniqueName,
} from '@darmawanweb/ais-its-nest/testing';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { inject } from 'vitest';

import { AppModule } from '../../src/app.module.js';
import { type Config, configSchema } from '../../src/config.js';
import { OPENAPI } from '../../src/openapi.options.js';
import { SERVICE } from '../../src/service.js';
import { FakeOpenMeteo } from './fake-open-meteo.js';

/** A request through `app.inject()` with an optional signed access token. */
export interface TestRequest {
  readonly method?: 'GET' | 'POST' | 'PUT' | 'DELETE';
  readonly url: string;
  /** Claims of the access token; `null` sends no token. */
  readonly as?: TestTokenClaims | null;
  readonly body?: unknown;
  readonly headers?: Readonly<Record<string, string>>;
}

/** The response of {@link TestService.request}. */
export interface TestResponse {
  readonly statusCode: number;
  readonly headers: Readonly<
    Record<string, string | string[] | number | undefined>
  >;
  readonly body: string;
  /** The JSON body as the caller expects it (like light-my-request's `json<T>()`, unchecked). */
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters -- typed view of a test response, as in light-my-request
  json<T = unknown>(): T;
}

/** The real application on the shared containers, with a test token issuer and a fake Open-Meteo. */
export interface TestService {
  readonly app: NestFastifyApplication;
  readonly config: Config;
  readonly jwt: TestJwtIssuer;
  readonly pool: Pool;
  readonly weather: FakeOpenMeteo;
  /** Publishes an event as its producer would (validated against the contracts schema). */
  publish<Type extends EventType>(
    type: Type,
    data: EventPayload<Type>,
  ): Promise<void>;
  request(request: TestRequest): Promise<TestResponse>;
  close(): Promise<void>;
}

/**
 * Builds and initializes the AppModule as `bootstrapService()` does (hooks
 * run: migrations apply, streams and consumers start) without listening;
 * durable consumers get a unique prefix per call so test files never share
 * them. Close it with {@link TestService.close}.
 */
export async function startTestService(
  env: Readonly<Record<string, string>> = {},
): Promise<TestService> {
  const infra = inject('infra');
  const weather = new FakeOpenMeteo();
  const weatherUrl = await weather.start();
  const jwt = await createTestJwtIssuer();
  const config = createTestConfig(configSchema, {
    SERVICE_NAME: SERVICE.name,
    DATABASE_URL: infra.databaseUrl,
    DATABASE_SCHEMA: SERVICE.schema,
    DB_MIGRATE_ON_BOOT: 'true',
    NATS_URL: infra.natsUrl,
    NATS_DURABLE_PREFIX: uniqueName('emission'),
    REDIS_URL: infra.redisUrl,
    WEATHER_API_URL: weatherUrl,
    WEATHER_TIMEOUT_MS: '1000',
    CII_PUBLISH_POLL_MS: '100',
    CII_AGGREGATE_REFRESH_MS: '200',
    ...env,
  });
  const app = await buildTestApp(AppModule, {
    config,
    openapi: OPENAPI,
    overrides: [
      { provide: ACCESS_TOKEN_KEY_RESOLVER, useValue: jwt.keyResolver },
    ],
  });
  const publisher = app.get(EventPublisher);
  return {
    app,
    config,
    jwt,
    pool: app.get<unknown, Pool>(PG_POOL),
    weather,
    publish: async (type, data) => {
      await publisher.publishEvent(type, data);
    },
    request: async ({
      method = 'GET',
      url,
      as = { roles: ['viewer'] },
      body,
      headers = {},
    }) => {
      const authorization =
        as === null ? {} : { authorization: `Bearer ${await jwt.sign(as)}` };
      const response = await app.inject({
        method,
        url,
        headers: { ...authorization, ...headers },
        ...(body === undefined
          ? {}
          : {
              payload: JSON.stringify(body),
              headers: {
                ...authorization,
                ...headers,
                'content-type': 'application/json',
              },
            }),
      });
      return {
        statusCode: response.statusCode,
        headers: response.headers,
        body: response.body,
        // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters -- see TestResponse.json
        json: <T>() => response.json<T>(),
      };
    },
    close: async () => {
      await app.close();
      await weather.stop();
    },
  };
}
