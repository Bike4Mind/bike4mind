import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ChatMessage, ChatStreamEvent } from '@shared/chat';
import { applyLiveEvent, startReply } from '@shared/liveReply';
import {
  ATTACHMENT_UPLOAD_CHUNK_BYTES,
  createHostFrameDecoder,
  encodeHostFrame,
  HOST_ERROR_CODES,
  HOST_PROTOCOL_VERSION,
  type EventCursor,
  type HostMessage,
  type HostNotification,
  type HostResponse,
} from '@shared/hostProtocol';
import { makePdf } from '../../main/chat/pdfFixtures';
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
    expect(hello.capabilities).toEqual([
      'queue',
      'backgroundProcesses',
      'attachments',
      'sessionSettings',
      'turnRevision',
    ]);
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

  it('ships a bundle with no require of electron', () => {
    const source = readFileSync(bin, 'utf8');
    expect(source).not.toMatch(/require\(\s*["']electron["']\s*\)/);
    expect(source).not.toMatch(/from\s*["']electron["']/);
  });

  type SessionRead = { session: { messages: ChatMessage[] } | null; cursor: EventCursor };
  type EventParams = { sessionId: string; seq: number; epoch?: string; event: ChatStreamEvent };

  const transcript = (messages: readonly ChatMessage[]) =>
    messages.map(({ id, role, content }) => ({ id, role, content }));

  const hostTranscript = async (connection: Connection, sessionId: string) =>
    transcript((await result<SessionRead>(connection.request('session/get', { sessionId }))).session?.messages ?? []);

  /**
   * One client's copy of a session, kept as the renderer keeps it: read once, then built from the
   * session's events, and read again whenever an event carries an epoch the copy does not hold.
   */
  function mirror(connection: Connection, sessionId: string) {
    let messages: ChatMessage[] = [];
    let cursor: EventCursor | null = null;
    let next = 0;
    let reading: Promise<void> | null = null;
    let resyncs = 0;

    const read = () => {
      reading = result<SessionRead>(connection.request('session/get', { sessionId })).then(answer => {
        messages = answer.session?.messages ?? [];
        cursor = answer.cursor;
        reading = null;
      });
      return reading;
    };

    const pump = () => {
      while (!reading && cursor && next < connection.notifications.length) {
        const notification = connection.notifications[next++];
        if (notification.method !== 'session/event') continue;
        const params = notification.params as EventParams;
        if (params.sessionId !== sessionId || params.seq <= cursor.seq) continue;
        if (params.epoch !== undefined && params.epoch !== cursor.epoch) {
          resyncs += 1;
          void read();
          return;
        }
        cursor = { epoch: cursor.epoch, seq: params.seq };
        const { event } = params;
        if (event.type === 'start') messages = startReply(messages, event.messageId);
        else messages = messages.map(message => applyLiveEvent(message, event));
        if (event.type === 'done') {
          messages = messages.map(message =>
            message.id === event.messageId ? { ...message, content: event.content } : message
          );
        }
      }
    };

    return {
      async open() {
        await result(connection.request('session/subscribe', { sessionId }));
        await read();
      },
      pump,
      messages: () => transcript(messages),
      resyncs: () => resyncs,
      settled: () => !reading,
    };
  }

  async function newSession(connection: Connection): Promise<string> {
    const created = await result<{ ok: boolean; session?: { id: string } }>(connection.request('session/create'));
    expect(created.ok).toBe(true);
    return created.session?.id ?? '';
  }

  async function finishTurn(connection: Connection, sessionId: string, messageId: string) {
    await until(
      () =>
        sessionEvents(connection, sessionId).some(
          e => e.event.type === 'done' && (e.event as { messageId?: string }).messageId === messageId
        ),
      `the end of reply ${messageId}`
    );
  }

  async function upload(connection: Connection, sessionId: string, name: string, bytes: Buffer) {
    const { uploadId } = await result<{ uploadId: string }>(
      connection.request('attachment/uploadBegin', { sessionId, name, byteSize: bytes.length })
    );
    for (let index = 0; index * ATTACHMENT_UPLOAD_CHUNK_BYTES < bytes.length; index++) {
      const data = bytes
        .subarray(index * ATTACHMENT_UPLOAD_CHUNK_BYTES, (index + 1) * ATTACHMENT_UPLOAD_CHUNK_BYTES)
        .toString('base64');
      await result(connection.request('attachment/uploadChunk', { uploadId, index, data }));
    }
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    return result<{ attachment?: { id: string; kind: string }; rejected?: unknown }>(
      connection.request('attachment/uploadCommit', { uploadId, sha256 })
    );
  }

  it('uploads an image, a text file and a multi-chunk PDF, and sends them to the model', async () => {
    const connection = connect();
    await initialize(connection);
    const sessionId = await newSession(connection);
    await result(connection.request('session/subscribe', { sessionId }));

    const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 1)]);
    const image = await upload(connection, sessionId, 'shot.png', png);
    expect(image.attachment).toMatchObject({ kind: 'image' });

    const text = await upload(connection, sessionId, 'notes.txt', Buffer.from('marker-in-the-text-file'));
    expect(text.attachment).toMatchObject({ kind: 'text' });

    const page = Array.from({ length: 2500 }, (_, line) => `line ${line} of the long upload`).join('\n');
    const pdfBytes = makePdf([page, page, page, 'marker-in-the-pdf']);
    expect(pdfBytes.length).toBeGreaterThan(ATTACHMENT_UPLOAD_CHUNK_BYTES);
    const pdf = await upload(connection, sessionId, 'long.pdf', pdfBytes);
    expect(pdf.attachment).toMatchObject({ kind: 'pdf' });

    const before = api.completionBodies().length;
    const sent = await result<{ ok: boolean; messageId: string }>(
      connection.request('turn/send', {
        sessionId,
        text: 'Read these',
        attachments: [image.attachment, text.attachment, pdf.attachment],
      })
    );
    await finishTurn(connection, sessionId, sent.messageId);

    const body = api.completionBodies()[before] ?? '';
    expect(body).toContain(png.toString('base64'));
    expect(body).toContain('marker-in-the-text-file');
    expect(body).toContain('marker-in-the-pdf');
    connection.child.kill('SIGKILL');
  }, 120_000);

  it('tells every client of a configure, and applies none of a refused one', async () => {
    const first = connect();
    const second = connect();
    await initialize(first);
    await initialize(second);
    const sessionId = await newSession(first);
    const initial = await result<{ session: { approvalMode?: string } }>(first.request('session/get', { sessionId }));
    const target = initial.session.approvalMode === 'ask' ? 'auto' : 'ask';

    const refused = await first.request('session/configure', {
      sessionId,
      patch: { approvalMode: target, reasoningEffort: 'not-an-effort' },
    });
    expect(refused).toMatchObject({ error: { code: HOST_ERROR_CODES.invalidParams } });
    const unknownKey = await first.request('session/configure', { sessionId, patch: { approvalMode: target, x: 1 } });
    expect(unknownKey).toMatchObject({ error: { code: HOST_ERROR_CODES.invalidParams } });
    const untouched = await result<{ session: { approvalMode?: string } }>(first.request('session/get', { sessionId }));
    expect(untouched.session.approvalMode).toBe(initial.session.approvalMode);

    const configured = await result<{ summary: { id: string; approvalMode?: string; promptCacheTtl?: string } }>(
      first.request('session/configure', { sessionId, patch: { approvalMode: target, promptCacheTtl: '1h' } })
    );
    expect(configured.summary).toMatchObject({ id: sessionId, approvalMode: target, promptCacheTtl: '1h' });
    await until(
      () =>
        second.notifications.some(
          n =>
            n.method === 'session/summaryChanged' &&
            (n.params as { summary: { id: string; approvalMode?: string } }).summary.id === sessionId &&
            (n.params as { summary: { approvalMode?: string } }).summary.approvalMode === target
        ),
      'the configure on the second client'
    );
    first.child.kill('SIGKILL');
    second.child.kill('SIGKILL');
  }, 60_000);

  it('leaves a watching client and a client resuming from an old cursor with the host transcript after an edit and a regenerate', async () => {
    const driver = connect();
    const watcher = connect();
    await initialize(driver);
    await initialize(watcher);
    const sessionId = await newSession(driver);
    await result(driver.request('session/subscribe', { sessionId }));

    const first = await result<{ messageId: string }>(driver.request('turn/send', { sessionId, text: 'First' }));
    await finishTurn(driver, sessionId, first.messageId);
    const view = mirror(watcher, sessionId);
    await view.open();
    const oldCursor = (await result<SessionRead>(driver.request('session/get', { sessionId }))).cursor;
    const prompt = (await result<SessionRead>(driver.request('session/get', { sessionId }))).session?.messages.find(
      message => message.role === 'user'
    );

    const settle = async (messageId: string) => {
      await finishTurn(driver, sessionId, messageId);
      await finishTurn(watcher, sessionId, messageId);
      await until(() => {
        view.pump();
        return view.settled() && view.messages().some(message => message.id === messageId);
      }, 'the watcher to catch up');
      view.pump();
    };

    const edited = await result<{ ok: boolean; messageId: string }>(
      driver.request('turn/edit', { sessionId, messageId: prompt?.id, text: 'First, edited' })
    );
    expect(edited.ok).toBe(true);
    await settle(edited.messageId);
    const afterEdit = await hostTranscript(driver, sessionId);
    expect(afterEdit.map(message => message.content)).toEqual(['First, edited', 'Hello there.']);
    await until(
      () => (view.pump(), JSON.stringify(view.messages()) === JSON.stringify(afterEdit)),
      'equal transcripts'
    );
    expect(view.resyncs()).toBeGreaterThan(0);

    const regenerated = await result<{ ok: boolean; messageId: string }>(
      driver.request('turn/regenerate', { sessionId, messageId: edited.messageId })
    );
    expect(regenerated.ok).toBe(true);
    await settle(regenerated.messageId);
    const afterRegenerate = await hostTranscript(driver, sessionId);
    expect(afterRegenerate.map(message => message.id)).not.toContain(edited.messageId);
    await until(
      () => (view.pump(), JSON.stringify(view.messages()) === JSON.stringify(afterRegenerate)),
      'equal transcripts after the regenerate'
    );

    const stale = await driver.request('turn/regenerate', { sessionId, messageId: edited.messageId });
    expect(stale).toMatchObject({ result: { ok: false } });

    const late = connect();
    await initialize(late);
    const resumed = await late.request('session/subscribe', { sessionId, after: oldCursor });
    expect(resumed).toMatchObject({ error: { code: HOST_ERROR_CODES.snapshotRequired } });
    expect(await hostTranscript(late, sessionId)).toEqual(afterRegenerate);

    const continued = await result<{ ok: boolean; error?: string }>(driver.request('turn/continue', { sessionId }));
    expect(continued).toMatchObject({ ok: false });
    for (const connection of [driver, watcher, late]) connection.child.kill('SIGKILL');
  }, 120_000);

  it('still serves a 1.3 client', async () => {
    const old = connect();
    const hello = await result<{ protocol: { major: number; minor: number } }>(
      old.request('host/initialize', {
        clientId: 'e2e-old',
        clientName: 'a 1.3 client',
        clientVersion: '1',
        protocol: { major: 1, minor: 3 },
      })
    );
    // The host answers with the version both sides agree on.
    expect(hello.protocol).toEqual({ major: 1, minor: 3 });
    const sessionId = await newSession(old);
    await result(old.request('session/subscribe', { sessionId }));
    const sent = await result<{ messageId: string }>(old.request('turn/send', { sessionId, text: 'Hi' }));
    await finishTurn(old, sessionId, sent.messageId);
    expect(await result(old.request('session/list'))).toMatchObject({ sessions: expect.any(Array) });
    old.child.kill('SIGKILL');
  }, 60_000);

  it('stops the daemon and removes its socket and lock', () => {
    expect(run('stop').status).toBe(0);
    expect(JSON.parse(run('status', '--json').stdout)).toEqual({ running: false });
  });
});
