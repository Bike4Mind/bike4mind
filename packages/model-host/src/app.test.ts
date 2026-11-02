import { request, type IncomingMessage } from 'node:http';
import { join } from 'node:path';
import {
  HostFactsSchema,
  ModelHostErrorSchema,
  ModelHostHelloSchema,
  OllamaSettingsSchema,
  type HostFacts,
} from '@bike4mind/common/modelHub';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { facts, get, probe, settings, tempDir } from './__test__/helpers';
import { createHostApp, type HostAppOptions } from './app';
import { HostServer } from './server';

let cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const cleanup of cleanups.reverse()) await cleanup();
  cleanups = [];
});

async function start(overrides: Partial<HostAppOptions> = {}) {
  const app = createHostApp({
    mode: 'system',
    serverId: 'server-1234',
    version: '0.1.0',
    ollamaUrl: 'http://127.0.0.1:11434',
    probe,
    health: async () => ({ ok: true, version: '0.40.11', error: null }),
    ...overrides,
  });
  const { dir, cleanup } = await tempDir();
  const server = new HostServer(app.handler);
  cleanups.push(
    cleanup,
    () => server.close(),
    () => app.close()
  );
  const manage = join(dir, 'manage.sock');
  const admin = join(dir, 'admin.sock');
  await server.listen({ role: 'manage', path: manage, mode: 0o600, gid: null });
  await server.listen({ role: 'admin', path: admin, mode: 0o600, gid: null });
  return { manage, admin };
}

/** Reads an event stream until `count` events or keepalives arrived. */
function readEvents(socketPath: string, count: number): Promise<{ status: number; type: string; frames: string[] }> {
  return new Promise((resolve, reject) => {
    const req = request({ socketPath, path: '/v1/events', agent: false }, res => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', chunk => {
        text += chunk;
        const frames = text.split('\n\n').filter(frame => frame && !frame.startsWith('retry:'));
        if (frames.length >= count) {
          req.destroy();
          resolve({
            status: res.statusCode ?? 0,
            type: String(res.headers['content-type']),
            frames: frames.slice(0, count),
          });
        }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

describe('model host routes', () => {
  it('says hello with the role of the socket asked', async () => {
    const { manage, admin } = await start();
    const viaManage = ModelHostHelloSchema.parse(JSON.parse((await get(manage, '/v1/hello')).body));
    const viaAdmin = ModelHostHelloSchema.parse(JSON.parse((await get(admin, '/v1/hello')).body));
    expect(viaManage).toEqual({
      protocol: 1,
      minClientProtocol: 1,
      version: '0.1.0',
      serverId: 'server-1234',
      mode: 'system',
      role: 'manage',
      ollama: { url: 'http://127.0.0.1:11434', reachable: true, version: '0.40.11' },
      features: ['host', 'settings', 'events'],
    });
    expect(viaAdmin.role).toBe('admin');
  });

  it('reports an Ollama it cannot reach', async () => {
    const { admin } = await start({ health: async () => ({ ok: false, version: null, error: 'refused' }) });
    const hello = ModelHostHelloSchema.parse(JSON.parse((await get(admin, '/v1/hello')).body));
    expect(hello.ollama).toMatchObject({ reachable: false, version: null });
  });

  it('serves host facts and settings from one probe while it is fresh', async () => {
    const spy = vi.fn(probe);
    const { manage } = await start({ probe: spy });
    const host = await get(manage, '/v1/host');
    expect(host.headers['content-type']).toBe('application/json');
    expect(HostFactsSchema.parse(JSON.parse(host.body))).toEqual(facts);
    expect(OllamaSettingsSchema.parse(JSON.parse((await get(manage, '/v1/settings')).body))).toEqual(settings);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('answers unknown routes and methods with the error shape', async () => {
    const { manage } = await start();
    const missing = await get(manage, '/v1/jobs');
    expect(missing.status).toBe(404);
    expect(ModelHostErrorSchema.parse(JSON.parse(missing.body)).code).toBe('not-found');
  });

  it('streams host events: the facts first, again when they change, and keepalives in between', async () => {
    let current: HostFacts = facts;
    const { manage } = await start({
      probe: async () => ({ host: current, settings }),
      factsMaxAgeMs: 0,
      eventsIntervalMs: 30,
    });
    const reading = readEvents(manage, 3);
    await new Promise(resolve => setTimeout(resolve, 45));
    current = { ...facts, memory: { ...facts.memory, availableBytes: 1 } };
    const { status, type, frames } = await reading;
    expect(status).toBe(200);
    expect(type).toBe('text/event-stream');
    const events = frames.filter(frame => frame.startsWith('event: host'));
    expect(
      events.map(frame => HostFactsSchema.parse(JSON.parse(frame.split('data: ')[1])).memory.availableBytes)
    ).toEqual(expect.arrayContaining([facts.memory.availableBytes, 1]));
    expect(frames.some(frame => frame === ': keepalive')).toBe(true);
  });

  it('refuses event streams past the cap on one socket without locking out another', async () => {
    const { manage, admin } = await start({ maxEventStreams: 1, eventsIntervalMs: 60_000 });
    const openStream = async (socketPath: string) => {
      const req = request({ socketPath, path: '/v1/events', agent: false });
      req.on('error', () => {});
      req.end();
      const res = await new Promise<IncomingMessage>(resolve => req.on('response', resolve));
      cleanups.push(() => void req.destroy());
      return res.statusCode;
    };
    expect(await openStream(manage)).toBe(200);
    const refused = await get(manage, '/v1/events');
    expect(refused.status).toBe(503);
    expect(JSON.parse(refused.body)).toMatchObject({ code: 'too-many-streams' });
    expect(await openStream(admin)).toBe(200);
  });

  it('answers 503 when reading facts hangs, and reads afresh on the next request', async () => {
    let calls = 0;
    const { manage } = await start({
      probe: () => (++calls === 1 ? new Promise(() => {}) : probe()),
      factsTimeoutMs: 50,
    });
    const hung = await get(manage, '/v1/host');
    expect(hung.status).toBe(503);
    expect(ModelHostErrorSchema.parse(JSON.parse(hung.body)).code).toBe('facts-timeout');
    expect((await get(manage, '/v1/settings')).status).toBe(200);
  });
});
