import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
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
import { DAEMON_OUTPUT_FILE_NAME } from './daemonOutput';
import { buildHostBundle, E2E_USER_ID as USER_ID, seedSignedInVault, startFakeApi } from './__fixtures__/builtHost';

/**
 * End to end against the BUILT program: the bundle is built into a folder under /tmp, where no
 * node_modules sits above it, so `electron` cannot resolve; `connect` and the daemon then run as
 * plain Node child processes against a fake Bike4Mind API (see __fixtures__/builtHost.ts).
 */

const describePosix = process.platform === 'win32' ? describe.skip : describe;

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
    dataDirectory = join(root, 'host');
    bin = await buildHostBundle(join(root, 'bin'), apiUrl);
    await seedSignedInVault(dataDirectory, apiUrl);
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
