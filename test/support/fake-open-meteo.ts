import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import type { AddressInfo } from 'node:net';

/** How the fake answers a request. */
export type FakeWeatherAnswer =
  | {
      readonly kind: 'wind';
      readonly speedKn: number;
      readonly directionDeg: number;
    }
  | { readonly kind: 'error'; readonly status: number }
  | { readonly kind: 'garbage' }
  | { readonly kind: 'hang' };

/** The query of a forecast request. */
export interface FakeWeatherRequest {
  readonly path: string;
  readonly latitude: string | null;
  readonly longitude: string | null;
  readonly startHour: string | null;
  readonly query: Readonly<Record<string, string>>;
}

/**
 * A local stand-in for the Open-Meteo forecast API (`GET /v1/forecast`,
 * hourly 10 m wind): tests point `WEATHER_API_URL` at it and never call the
 * internet. `answer` decides per request (default: 12 kn from 45°).
 */
export class FakeOpenMeteo {
  readonly requests: FakeWeatherRequest[] = [];
  answer: (request: FakeWeatherRequest) => FakeWeatherAnswer = () => ({
    kind: 'wind',
    speedKn: 12,
    directionDeg: 45,
  });
  private server: Server | undefined;

  /** Starts listening on a random local port; returns the base URL. */
  async start(): Promise<string> {
    const server = createServer(
      (request: IncomingMessage, response: ServerResponse) => {
        this.handle(request, response);
      },
    );
    this.server = server;
    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', resolve);
    });
    const { port } = server.address() as AddressInfo;
    return `http://127.0.0.1:${port}`;
  }

  async stop(): Promise<void> {
    const server = this.server;
    if (server === undefined) return;
    server.closeAllConnections();
    await new Promise<void>((resolve) => {
      server.close(() => {
        resolve();
      });
    });
  }

  private handle(request: IncomingMessage, response: ServerResponse): void {
    const url = new URL(request.url ?? '/', 'http://localhost');
    const parsed: FakeWeatherRequest = {
      path: url.pathname,
      latitude: url.searchParams.get('latitude'),
      longitude: url.searchParams.get('longitude'),
      startHour: url.searchParams.get('start_hour'),
      query: Object.fromEntries(url.searchParams),
    };
    this.requests.push(parsed);
    const answer = this.answer(parsed);
    switch (answer.kind) {
      case 'hang':
        return;
      case 'error':
        response.writeHead(answer.status).end();
        return;
      case 'garbage':
        response
          .writeHead(200, { 'content-type': 'application/json' })
          .end('{"error":true}');
        return;
      case 'wind':
        response.writeHead(200, { 'content-type': 'application/json' }).end(
          JSON.stringify({
            hourly: {
              time: [parsed.startHour],
              wind_speed_10m: [answer.speedKn],
              wind_direction_10m: [answer.directionDeg],
            },
          }),
        );
    }
  }
}
