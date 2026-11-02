import { statfs } from 'node:fs/promises';
import type { z } from 'zod';
import {
  MODEL_HOST_PROTOCOL,
  ModelHostHelloSchema,
  PullJobActionSchema,
  PullJobRequestSchema,
  type ModelHostHello,
  type PullJobActor,
} from '@bike4mind/common/modelHub';
import type { ModelHostProbe, RuntimeHealth } from '@bike4mind/local-models';
import { cached } from './cached';
import { HostEvents } from './events';
import type { JobManager, JobManagerOptions } from './jobs';
import { readOllamaKey } from './ollamaKey';
import type { HostMode } from './paths';
import { createRouter, type Route, type RouteContext } from './router';
import { HttpError, sendJson, type Connection, type RequestHandler } from './server';

export const HOST_FEATURES = ['host', 'settings', 'events'] as const;
export const JOB_FEATURES = ['jobs', 'models', 'ollama-key'] as const;

/** What the app hands the job manager it creates, so jobs reach the event stream and read the store's free space. */
export type JobHooks = Pick<JobManagerOptions, 'onJob' | 'onDismissed' | 'freeBytes'>;

export interface HostAppOptions {
  mode: HostMode;
  serverId: string;
  version: string;
  ollamaUrl: string;
  probe: () => Promise<ModelHostProbe>;
  health: () => Promise<RuntimeHealth>;
  /** Without it the host reports facts only. */
  jobs?: (hooks: JobHooks) => JobManager;
  /** Host facts are re-read at most this often, however many clients ask (ms). */
  factsMaxAgeMs?: number;
  /** A facts read still running after this long answers 503, so a hung statfs cannot wedge the routes (ms). */
  factsTimeoutMs?: number;
  eventsIntervalMs?: number;
  /** Per socket. */
  maxEventStreams?: number;
  log?: (line: string) => void;
}

export interface HostApp {
  routes: readonly Route[];
  handler: RequestHandler;
  jobs: JobManager | null;
  close(): void;
}

const MODEL_NAME = /^[A-Za-z0-9][\w.:/-]{0,399}$/;

/** Unsent data past which an event stream is dropped; the job snapshot at the job caps must fit under it. */
export const EVENT_BUFFER_BYTES = 2 * 1024 * 1024;
const STATFS_TIMEOUT_MS = 5_000;

/** Free bytes on the model store right now; null when the path or the filesystem cannot say in time. */
async function freshFreeBytes(path: string | null): Promise<number | null> {
  if (!path) return null;
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<null>(resolve => (timer = setTimeout(() => resolve(null), STATFS_TIMEOUT_MS)));
  try {
    const info = await Promise.race([statfs(path), late]);
    return info ? info.bavail * info.bsize : null;
  } finally {
    clearTimeout(timer);
  }
}

function parseBody<S extends z.ZodType>(body: Buffer, schema: S, allowEmpty = false): z.infer<S> {
  let value: unknown = {};
  if (body.length || !allowEmpty) {
    try {
      value = JSON.parse(body.toString('utf8'));
    } catch {
      throw new HttpError(400, 'invalid-json', 'The request body is not JSON.');
    }
  }
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const where = issue?.path.length ? `${issue.path.join('.').slice(0, 100)}: ` : '';
    throw new HttpError(400, 'invalid-request', `${where}${(issue?.message ?? 'invalid').slice(0, 200)}`);
  }
  return parsed.data;
}

function actor(conn: Connection, device: { name: string } | undefined): PullJobActor {
  return { device: device?.name ?? 'unknown device', user: conn.login, via: conn.login ? 'ssh' : 'local' };
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
  let jobs: JobManager | null = null;
  const events = new HostEvents({
    facts: async () => (await probe()).host,
    snapshot: () => (jobs?.list() ?? []).map(job => ({ event: 'job', data: job, role: 'manage' as const })),
    intervalMs: options.eventsIntervalMs ?? 10_000,
    maxStreams: options.maxEventStreams ?? 32,
    maxBufferedBytes: EVENT_BUFFER_BYTES,
    log: options.log,
  });
  jobs =
    options.jobs?.({
      onJob: job => events.publish({ event: 'job', data: job, role: 'manage' }),
      onDismissed: id => events.publish({ event: 'job-dismissed', data: { id }, role: 'manage' }),
      // The path comes from the cached facts; the free space is read fresh, since admission decides on it.
      freeBytes: async () => freshFreeBytes((await probe()).host.ollama.store.path),
    }) ?? null;

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
          features: [...HOST_FEATURES, ...(jobs ? JOB_FEATURES : [])],
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
      handle: ({ res, conn }) => events.subscribe(res, conn.role, conn.role),
    },
  ];

  if (jobs) {
    const manager = jobs;
    const action =
      (run: (id: string, who: PullJobActor) => Promise<unknown>) =>
      async ({ res, conn, body, params }: RouteContext) => {
        const { device } = parseBody(body, PullJobActionSchema, true);
        await run(params.id, actor(conn, device));
        sendJson(res, 200, manager.get(params.id));
      };
    routes.push(
      {
        method: 'GET',
        path: '/v1/jobs',
        role: 'manage',
        handle: ({ res }) => sendJson(res, 200, { jobs: manager.list() }),
      },
      {
        method: 'POST',
        path: '/v1/jobs',
        role: 'manage',
        handle: async ({ res, conn, body }) => {
          const request = parseBody(body, PullJobRequestSchema);
          sendJson(res, 202, await manager.create(request, actor(conn, request.device)));
        },
      },
      {
        method: 'GET',
        path: '/v1/jobs/:id',
        role: 'manage',
        handle: ({ res, params }) => sendJson(res, 200, manager.get(params.id)),
      },
      {
        method: 'DELETE',
        path: '/v1/jobs/:id',
        role: 'manage',
        handle: async ({ res, conn, body, params }) => {
          const { device } = parseBody(body, PullJobActionSchema, true);
          await manager.dismiss(params.id, actor(conn, device));
          sendJson(res, 200, { dismissed: params.id });
        },
      },
      {
        method: 'POST',
        path: '/v1/jobs/:id/cancel',
        role: 'manage',
        handle: action((id, who) => manager.cancel(id, who)),
      },
      {
        method: 'POST',
        path: '/v1/jobs/:id/pause',
        role: 'manage',
        handle: action((id, who) => manager.pause(id, who)),
      },
      {
        method: 'POST',
        path: '/v1/jobs/:id/resume',
        role: 'manage',
        handle: action((id, who) => manager.resume(id, who)),
      },
      {
        method: 'DELETE',
        path: '/v1/models/:name',
        role: 'manage',
        handle: async ({ res, conn, body, params }) => {
          if (!MODEL_NAME.test(params.name) || params.name.includes('..')) {
            throw new HttpError(400, 'invalid-model-name', 'Not an Ollama model name.');
          }
          const { device } = parseBody(body, PullJobActionSchema, true);
          await manager.removeModel(params.name, actor(conn, device));
          sendJson(res, 200, { removed: params.name });
        },
      },
      {
        method: 'GET',
        path: '/v1/ollama/key',
        role: 'manage',
        handle: async ({ res }) => sendJson(res, 200, await readOllamaKey((await probe()).ollamaHome)),
      }
    );
  }

  return { routes, handler: createRouter(routes), jobs, close: () => events.close() };
}
