import { MODEL_HOST_PROTOCOL, ModelHostHelloSchema, type ModelHostHello } from '@bike4mind/common/modelHub';
import type { ModelHostProbe, RuntimeHealth } from '@bike4mind/local-models';
import { cached } from './cached';
import { HostEvents } from './events';
import type { HostMode } from './paths';
import { createRouter, type Route } from './router';
import { HttpError, sendJson, type RequestHandler } from './server';

export const HOST_FEATURES = ['host', 'settings', 'events'] as const;

export interface HostAppOptions {
  mode: HostMode;
  serverId: string;
  version: string;
  ollamaUrl: string;
  probe: () => Promise<ModelHostProbe>;
  health: () => Promise<RuntimeHealth>;
  /** Host facts are re-read at most this often, however many clients ask (ms). */
  factsMaxAgeMs?: number;
  /** A facts read still running after this long answers 503, so a hung statfs cannot wedge the routes (ms). */
  factsTimeoutMs?: number;
  eventsIntervalMs?: number;
  /** Per socket. */
  maxEventStreams?: number;
}

export interface HostApp {
  routes: readonly Route[];
  handler: RequestHandler;
  close(): void;
}

export function createHostApp(options: HostAppOptions): HostApp {
  const probe = cached(options.probe, options.factsMaxAgeMs ?? 5_000, {
    timeoutMs: options.factsTimeoutMs ?? 15_000,
    timeoutError: () =>
      new HttpError(503, 'facts-timeout', 'Reading host facts is taking too long; try again shortly.', {
        'retry-after': '5',
      }),
  });
  const health = cached(options.health, 2_000);
  const events = new HostEvents({
    facts: async () => (await probe()).host,
    intervalMs: options.eventsIntervalMs ?? 10_000,
    maxStreams: options.maxEventStreams ?? 32,
    maxBufferedBytes: 1024 * 1024,
  });

  const routes: Route[] = [
    {
      method: 'GET',
      path: '/v1/hello',
      role: 'chat',
      handle: async ({ res, conn }) => {
        const ollama = await health();
        const hello: ModelHostHello = ModelHostHelloSchema.parse({
          protocol: MODEL_HOST_PROTOCOL,
          minClientProtocol: 1,
          version: options.version,
          serverId: options.serverId,
          mode: options.mode,
          role: conn.role,
          ollama: { url: options.ollamaUrl, reachable: ollama.ok, version: ollama.version },
          features: [...HOST_FEATURES],
        });
        sendJson(res, 200, hello);
      },
    },
    {
      method: 'GET',
      path: '/v1/host',
      role: 'chat',
      handle: async ({ res }) => sendJson(res, 200, (await probe()).host),
    },
    {
      method: 'GET',
      path: '/v1/settings',
      role: 'chat',
      handle: async ({ res }) => sendJson(res, 200, (await probe()).settings),
    },
    {
      method: 'GET',
      path: '/v1/events',
      role: 'chat',
      handle: ({ res, conn }) => events.subscribe(res, conn.role),
    },
  ];

  return { routes, handler: createRouter(routes), close: () => events.close() };
}
