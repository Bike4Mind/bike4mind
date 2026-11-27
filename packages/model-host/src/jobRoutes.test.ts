import { mkdir, writeFile } from 'node:fs/promises';
import { request } from 'node:http';
import { join } from 'node:path';
import {
  ModelHostErrorSchema,
  ModelHostHelloSchema,
  OllamaKeySchema,
  PullJobListSchema,
  PullJobSchema,
} from '@bike4mind/common/modelHub';
import { afterEach, describe, expect, it } from 'vitest';
import { facts, get, send, settings, tempDir } from './__test__/helpers';
import { createJobs, jobId, pullRequest, storedJob, until } from './__test__/jobFixtures';
import { createHostApp, EVENT_BUFFER_BYTES } from './app';
import { DEFAULT_MAX_JOBS, DEFAULT_MAX_KEPT } from './jobs';
import type { StoredJob } from './jobStore';
import { HostServer } from './server';

let cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const cleanup of cleanups.reverse()) await cleanup();
  cleanups = [];
});

async function start(ollamaHome: string | null = null, initial: StoredJob[] = []) {
  let made: ReturnType<typeof createJobs> | null = null;
  const app = createHostApp({
    mode: 'system',
    serverId: 'server-1234',
    version: '0.1.0',
    ollamaUrl: 'http://127.0.0.1:11434',
    probe: async () => ({ host: facts, settings, ollamaHome }),
    health: async () => ({ ok: true, version: '0.40.11', error: null }),
    eventsIntervalMs: 60_000,
    jobs: hooks => {
      made = createJobs(hooks, initial);
      return made.jobs;
    },
  });
  await app.jobs?.load();
  const { dir, cleanup } = await tempDir();
  const server = new HostServer(app.handler);
  cleanups.push(
    cleanup,
    () => server.close(),
    () => app.close(),
    () => app.jobs?.close()
  );
  const sockets = { chat: join(dir, 'chat.sock'), manage: join(dir, 'manage.sock') };
  await server.listen({ role: 'chat', path: sockets.chat, mode: 0o600, gid: null });
  await server.listen({ role: 'manage', path: sockets.manage, mode: 0o600, gid: null });
  if (!made) throw new Error('no job manager');
  return { ...sockets, dir, jobs: made as ReturnType<typeof createJobs> };
}

/** Collects event frames from a stream until `done` returns true for them. */
function stream(socketPath: string) {
  const frames: string[] = [];
  const req = request({ socketPath, path: '/v1/events', agent: false }, res => {
    let text = '';
    res.setEncoding('utf8');
    res.on('data', chunk => {
      text += chunk;
      const parts = text.split('\n\n');
      text = parts.pop() ?? '';
      frames.push(...parts.filter(part => part.startsWith('event:')));
    });
  });
  req.on('error', () => {});
  req.end();
  cleanups.push(() => void req.destroy());
  const events = (name: string) =>
    frames.filter(frame => frame.startsWith(`event: ${name}\n`)).map(frame => JSON.parse(frame.split('data: ')[1]));
  return { frames, events };
}

describe('job routes', () => {
  it('lists the job features in hello', async () => {
    const { manage } = await start();
    const hello = ModelHostHelloSchema.parse(JSON.parse((await get(manage, '/v1/hello')).body));
    expect(hello.features).toEqual(['host', 'settings', 'events', 'jobs', 'models', 'ollama-key']);
  });

  it('creates a job, streams its progress, and lets another client cancel it, naming who did', async () => {
    const { manage, jobs } = await start();
    const watcher = stream(manage);
    await until(() => watcher.frames.length > 0, 'host event');
    const created = await send(manage, 'POST', '/v1/jobs', pullRequest());
    expect(created.status).toBe(202);
    const job = PullJobSchema.parse(JSON.parse(created.body));
    expect(job.startedBy).toEqual({ device: 'Laptop', user: null, via: 'local' });
    await until(() => jobs.fake.pulls.length === 1, 'pull');
    jobs.fake.pulls[0].progress(250);
    await until(() => watcher.events('job').some(event => event.progress.completedBytes === 250), 'progress event');

    const list = PullJobListSchema.parse(JSON.parse((await get(manage, '/v1/jobs')).body));
    expect(list.jobs.map(entry => entry.id)).toEqual([job.id]);
    const cancelled = await send(manage, 'POST', `/v1/jobs/${job.id}/cancel`, {
      device: { id: 'device-2', name: 'Desktop' },
    });
    expect(cancelled.status).toBe(200);
    expect(PullJobSchema.parse(JSON.parse(cancelled.body)).cancelledBy).toEqual({
      device: 'Desktop',
      user: null,
      via: 'local',
    });
    await until(() => watcher.events('job').some(event => event.state === 'cancelled'), 'cancel event');
    expect(watcher.events('job').find(event => event.state === 'cancelled').cancelledBy.device).toBe('Desktop');

    expect((await send(manage, 'DELETE', `/v1/jobs/${job.id}`)).status).toBe(200);
    await until(() => watcher.events('job-dismissed').length === 1, 'dismissed event');
    expect((await get(manage, `/v1/jobs/${job.id}`)).status).toBe(404);
  });

  it('sends a new stream every job, but never to a chat connection', async () => {
    const { manage, chat, jobs } = await start();
    await send(manage, 'POST', '/v1/jobs', pullRequest());
    await until(() => jobs.fake.pulls.length === 1, 'pull');
    const managed = stream(manage);
    const chatting = stream(chat);
    await until(() => managed.events('job').length === 1, 'snapshot');
    await until(() => chatting.events('host').length === 1, 'chat host event');
    jobs.fake.pulls[0].progress(100);
    await new Promise(resolve => setTimeout(resolve, 30));
    expect(chatting.events('job')).toEqual([]);
  });

  it('sends a new stream the whole job snapshot at the job caps, with the longest fields, without dropping it', async () => {
    const actor = { device: 'd'.repeat(256), user: 'u'.repeat(256), via: 'ssh' as const };
    const longest = (n: number, state: 'paused' | 'interrupted' | 'failed') =>
      storedJob(jobId(n), state, {
        repo: 'r'.repeat(200),
        buildId: 'b'.repeat(256),
        ref: 'f'.repeat(1024),
        progress: { status: 's'.repeat(256), completedBytes: 2 ** 52, totalBytes: 2 ** 52 },
        startedBy: actor,
        cancelledBy: actor,
        updatedAt: new Date(Date.UTC(2026, 0, 1, 0, 0, n)).toISOString(),
        error: state === 'failed' ? { code: 'c'.repeat(256), message: 'm'.repeat(4096) } : null,
        notice: 'n'.repeat(4096),
      });
    const open = Array.from({ length: DEFAULT_MAX_JOBS }, (_, n) => longest(n, n % 2 ? 'paused' : 'interrupted'));
    const done = Array.from({ length: DEFAULT_MAX_KEPT }, (_, n) => longest(DEFAULT_MAX_JOBS + n, 'failed'));
    const { manage, jobs } = await start(null, [...open, ...done]);
    const total = jobs.jobs.list().reduce((sum, job) => sum + `event: job\ndata: ${JSON.stringify(job)}\n\n`.length, 0);
    expect(total).toBeLessThan(EVENT_BUFFER_BYTES);
    const watcher = stream(manage);
    await until(() => watcher.events('job').length === DEFAULT_MAX_JOBS + DEFAULT_MAX_KEPT, 'snapshot');
  });

  it('refuses every job route to the chat role', async () => {
    const { chat } = await start();
    for (const [method, path] of [
      ['GET', '/v1/jobs'],
      ['POST', '/v1/jobs'],
      ['POST', '/v1/jobs/x/cancel'],
      ['POST', '/v1/jobs/x/pause'],
      ['POST', '/v1/jobs/x/resume'],
      ['DELETE', '/v1/jobs/x'],
      ['DELETE', '/v1/models/x'],
      ['GET', '/v1/ollama/key'],
    ]) {
      const reply = await send(chat, method, path, method === 'POST' ? pullRequest() : undefined);
      expect([path, reply.status]).toEqual([path, 403]);
      expect(ModelHostErrorSchema.parse(JSON.parse(reply.body)).code).toBe('forbidden');
    }
  });

  it('answers a malformed or invalid approval with 400 and starts nothing', async () => {
    const { manage, jobs } = await start();
    const notJson = await send(manage, 'POST', '/v1/jobs', '{');
    expect([notJson.status, JSON.parse(notJson.body).code]).toEqual([400, 'invalid-json']);
    const invalid = await send(manage, 'POST', '/v1/jobs', { ...pullRequest(), sha256: 'nope' });
    expect(invalid.status).toBe(400);
    expect(JSON.parse(invalid.body)).toMatchObject({
      code: 'invalid-request',
      message: expect.stringContaining('sha256'),
    });
    const hostile = await send(manage, 'POST', '/v1/jobs', { ...pullRequest(), device: { id: 'x', name: 'a\nb' } });
    expect(hostile.status).toBe(400);
    expect(jobs.jobs.list()).toEqual([]);
  });

  it('removes a model by its encoded name and refuses names that are not Ollama names', async () => {
    const { manage, jobs } = await start();
    jobs.fake.installed.add('hf.co/org/repo:Q8_0');
    const removed = await send(manage, 'DELETE', `/v1/models/${encodeURIComponent('hf.co/org/repo:Q8_0')}`);
    expect([removed.status, JSON.parse(removed.body)]).toEqual([200, { removed: 'hf.co/org/repo:Q8_0' }]);
    expect((await send(manage, 'DELETE', '/v1/models/nope%3Alatest')).status).toBe(404);
    expect((await send(manage, 'DELETE', `/v1/models/${encodeURIComponent('../x')}`)).status).toBe(400);
  });

  it("returns Ollama's public key from the home Ollama runs with", async () => {
    const { dir } = await tempDir().then(made => (cleanups.push(made.cleanup), made));
    await mkdir(join(dir, '.ollama'));
    const key = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIExample';
    await writeFile(join(dir, '.ollama', 'id_ed25519.pub'), `${key}\n`);
    const { manage } = await start(dir);
    const reply = OllamaKeySchema.parse(JSON.parse((await get(manage, '/v1/ollama/key')).body));
    expect(reply).toEqual({ path: join(dir, '.ollama', 'id_ed25519.pub'), publicKey: key, message: null });
  });
});
