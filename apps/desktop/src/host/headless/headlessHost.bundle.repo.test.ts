import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createHostFrameDecoder,
  encodeHostFrame,
  HOST_PROTOCOL_VERSION,
  type EventCursor,
  type HostMessage,
  type HostNotification,
  type HostResponse,
} from '@shared/hostProtocol';
import { ensurePrivateDirectory } from '../auth/privateDirectory';
import { DAEMON_OUTPUT_FILE_NAME } from './daemonOutput';
import { createPermissionProtectedCipher } from '../auth/permissionProtectedCipher';
import { TokenVault } from '../../main/auth/tokenVault';
import { createVaultFile } from '../../main/auth/vaultFile';

/**
 * End to end against the BUILT program: vite.host.config.ts builds the bundle into a folder under
 * /tmp, where no node_modules sits above it, so `electron` cannot resolve; `connect` and the
 * daemon then run as plain Node child processes. The seam is the Bike4Mind HTTP API: a local
 * server answers sign-in identity, settings, the model list and the completions stream, so the
 * real chat service, runtime, protocol server, daemon and bridge all run unchanged.
 */

const describePosix = process.platform === 'win32' ? describe.skip : describe;
const DESKTOP = resolve(__dirname, '../../..');
const USER_ID = 'user-e2e';

function fakeAccessToken(userId: string): string {
  const payload = Buffer.from(JSON.stringify({ id: userId }), 'utf8').toString('base64url');
  return `header.${payload}.signature`;
}

/** The Bike4Mind API, as far as one chat turn needs it. The first completion is held until released. */
function startFakeApi() {
  let releaseTurn: () => void = () => undefined;
  const turnReleased = new Promise<void>(resolve => {
    releaseTurn = resolve;
  });
  let completions = 0;
  const unexpected: string[] = [];
  const sse = (body: unknown) => `data: ${typeof body === 'string' ? body : JSON.stringify(body)}\n\n`;

  const json = (response: ServerResponse, body: unknown) => {
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify(body));
  };
  const server: Server = createServer((request: IncomingMessage, response: ServerResponse) => {
    const path = (request.url ?? '').split('?')[0];
    request.resume();
    if (path === '/api/identify') return json(response, { user: { id: USER_ID, email: 'rider@example.com' } });
    if (path === '/api/settings/fetch') return json(response, {});
    if (path === '/api/settings/serverConfig') return json(response, {});
    if (path === '/api/skills') return json(response, { data: [] });
    if (path === '/api/models' || path === '/api/v1/models' || path === '/api/v1/video-models') {
      return json(response, { data: [], models: [] });
    }
    if (path === '/api/ai/v1/completions' && request.method === 'POST') {
      const first = ++completions === 1;
      response.writeHead(200, { 'Content-Type': 'text/event-stream' });
      response.write(sse({ type: 'content', text: 'Hello ' }));
      const finish = () =>
        response.end(sse({ type: 'content', text: 'there.', stopReason: 'end_turn' }) + sse('[DONE]'));
      if (first) void turnReleased.then(finish);
      else finish();
      return;
    }
    unexpected.push(`${request.method} ${path}`);
    response.writeHead(404).end();
  });
  return {
    server,
    unexpected,
    releaseTurn: () => releaseTurn(),
    completions: () => completions,
    listen: () =>
      new Promise<string>(resolve =>
        server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}`))
      ),
  };
}

type Connection = {
  child: ChildProcessWithoutNullStreams;
  stdout: () => string;
  request(method: string, params?: unknown): Promise<HostResponse>;
  notifications: HostNotification[];
  exited: Promise<number | null>;
};

describePosix('the built b4m-host program', () => {
  const api = startFakeApi();
  let root = '';
  let bin = '';
  let dataDirectory = '';
  let apiUrl = '';
  const children: ChildProcessWithoutNullStreams[] = [];

  /** Only what Node needs: no inherited NODE_OPTIONS, and a home inside the scratch folder. */
  const childEnv = () => ({ PATH: process.env.PATH ?? '', HOME: root, TMPDIR: root });

  function run(...args: string[]) {
    return spawnSync(process.execPath, [bin, ...args, '--data-dir', dataDirectory], {
      cwd: root,
      env: childEnv(),
      encoding: 'utf8',
      timeout: 30_000,
    });
  }

  function connect(): Connection {
    const child = spawn(process.execPath, [bin, 'connect', '--data-dir', dataDirectory], {
      cwd: root,
      env: childEnv(),
    });
    children.push(child);
    const decoder = createHostFrameDecoder();
    const waiting = new Map<string | number, (response: HostResponse) => void>();
    const notifications: HostNotification[] = [];
    let raw = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      raw += chunk;
      for (const frame of decoder.push(chunk)) {
        if (!frame.ok) throw new Error(`connect wrote something that is not a host frame: ${frame.error.message}`);
        const message: HostMessage = frame.message;
        if ('id' in message && message.id !== null && !('method' in message)) waiting.get(message.id)?.(message);
        else if ('method' in message && !('id' in message)) notifications.push(message);
      }
    });
    const exited = new Promise<number | null>(resolve => child.once('exit', code => resolve(code)));
    let nextId = 1;
    return {
      child,
      notifications,
      exited,
      stdout: () => raw,
      request: (method, params) => {
        const id = nextId++;
        const answered = new Promise<HostResponse>(resolve => waiting.set(id, resolve));
        child.stdin.write(encodeHostFrame({ jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) }));
        return answered;
      },
    };
  }

  async function result<T>(response: Promise<HostResponse>): Promise<T> {
    const settled = await response;
    if ('error' in settled) throw new Error(`host error ${settled.error.code}: ${settled.error.message}`);
    return settled.result as T;
  }

  const initialize = (connection: Connection) =>
    result<{ hostId: string; capabilities: string[]; account: { userId: string } | null }>(
      connection.request('host/initialize', {
        clientId: 'e2e',
        clientName: 'bundle e2e',
        clientVersion: '1',
        protocol: HOST_PROTOCOL_VERSION,
      })
    );

  const sessionEvents = (connection: Connection, sessionId: string) =>
    connection.notifications
      .filter(notification => notification.method === 'session/event')
      .map(notification => notification.params as { sessionId: string; seq: number; event: { type: string } })
      .filter(params => params.sessionId === sessionId);

  async function until(check: () => boolean, what: string, timeoutMs = 20_000) {
    const deadline = Date.now() + timeoutMs;
    while (!check()) {
      if (Date.now() > deadline) {
        const tail = (name: string) => {
          try {
            return readFileSync(join(dataDirectory, name), 'utf8').slice(-4000);
          } catch {
            return `(no ${name})`;
          }
        };
        throw new Error(
          `Timed out waiting for ${what}. host.log tail:\n${tail('host.log')}\n${DAEMON_OUTPUT_FILE_NAME} tail:\n${tail(DAEMON_OUTPUT_FILE_NAME)}`
        );
      }
      await new Promise(resolve => setTimeout(resolve, 50));
    }
  }

  const daemonPid = () => (JSON.parse(readFileSync(join(dataDirectory, 'host.lock'), 'utf8')) as { pid: number }).pid;

  beforeAll(async () => {
    apiUrl = await api.listen();
    root = await mkdtemp('/tmp/b4mh-e2e-');
    bin = join(root, 'bin');
    dataDirectory = join(root, 'host');

    // A fork bakes its own server the same way; here it keeps every call on the fake API.
    const baked = process.env.B4M_DEFAULT_API_URL;
    process.env.B4M_DEFAULT_API_URL = apiUrl;
    try {
      const { build } = await import('vite');
      await build({
        configFile: join(DESKTOP, 'vite.host.config.ts'),
        root: DESKTOP,
        mode: 'production',
        logLevel: 'error',
        build: { outDir: bin, emptyOutDir: true },
      });
    } finally {
      if (baked === undefined) delete process.env.B4M_DEFAULT_API_URL;
      else process.env.B4M_DEFAULT_API_URL = baked;
    }
    bin = join(bin, 'b4m-host.cjs');

    // Signed in already, as a user who ran sign-in once before: tokens far from expiry.
    await ensurePrivateDirectory(dataDirectory);
    const vault = new TokenVault(
      createPermissionProtectedCipher(),
      createVaultFile(join(dataDirectory, 'auth-vault.json')),
      {
        debug: () => undefined,
        warn: () => undefined,
        error: () => undefined,
      }
    );
    await vault.setEnvironment({ preset: 'custom', customUrl: apiUrl });
    await vault.setTokens(apiUrl, {
      accessToken: fakeAccessToken(USER_ID),
      refreshToken: 'refresh-e2e',
      expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
      userId: USER_ID,
    });
  }, 180_000);

  afterAll(async () => {
    if (bin.endsWith('.cjs')) run('stop');
    for (const child of children) child.kill('SIGKILL');
    await new Promise<void>(resolve => api.server.close(() => resolve()));
    if (root) await rm(root, { recursive: true, force: true });
  });

  it('cannot resolve electron from where it runs', () => {
    const probe = spawnSync(process.execPath, ['-e', 'require.resolve("electron")'], { cwd: root, env: childEnv() });
    expect(probe.status).not.toBe(0);
  });

  it('runs a turn through connect and resumes it from the cursor after a reconnect', async () => {
    const first = connect();
    const hello = await initialize(first);
    expect(hello.capabilities).toEqual(['queue', 'backgroundProcesses', 'attachments']);
    expect(hello.account).toMatchObject({ userId: USER_ID });
    expect(await result(first.request('host/info'))).toMatchObject({ hostId: hello.hostId });
    const pid = daemonPid();

    const created = await result<{ ok: boolean; session?: { id: string } }>(first.request('session/create'));
    expect(created.ok).toBe(true);
    const sessionId = created.session?.id ?? '';
    const { cursor } = await result<{ cursor: EventCursor }>(first.request('session/subscribe', { sessionId }));
    expect(await result(first.request('turn/send', { sessionId, text: 'Say hello' }))).toMatchObject({ ok: true });

    // Part of the reply has streamed; the model is now held mid-turn.
    await until(() => sessionEvents(first, sessionId).some(e => e.event.type === 'delta'), 'the first delta');
    const seen = sessionEvents(first, sessionId);
    first.child.kill('SIGKILL');
    await first.exited;

    // The turn finishes while no client is connected.
    api.releaseTurn();
    const second = connect();
    await initialize(second);
    expect(daemonPid()).toBe(pid);
    const last = seen[seen.length - 1];
    await result(second.request('session/subscribe', { sessionId, after: { epoch: cursor.epoch, seq: last.seq } }));
    await until(() => sessionEvents(second, sessionId).some(e => e.event.type === 'done'), 'the end of the turn');

    const resumed = sessionEvents(second, sessionId);
    const seqs = [...seen, ...resumed].map(e => e.seq);
    expect(new Set(seqs).size).toBe(seqs.length);
    expect(seqs).toEqual(Array.from({ length: seqs.length }, (_, index) => seqs[0] + index));
    expect(resumed[0].seq).toBe(last.seq + 1);

    second.child.stdin.end();
    expect(await second.exited).toBe(0);
    expect(api.unexpected).toEqual([]);

    const status = run('status', '--json');
    expect(JSON.parse(status.stdout)).toMatchObject({ running: true, pid });
  }, 120_000);

  it('stops the daemon and removes its socket and lock', () => {
    expect(run('stop').status).toBe(0);
    expect(JSON.parse(run('status', '--json').stdout)).toEqual({ running: false });
  });
});
