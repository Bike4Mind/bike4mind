import http, { type IncomingHttpHeaders } from 'node:http';
import type { AddressInfo } from 'node:net';
import { inspect } from 'node:util';
import type { IpcMain } from 'electron';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { IPC_CHANNELS } from '@shared/ipc';
import type {
  ModelServerCredentialInput,
  ModelServerKind,
  ModelServerMutationResult,
  ModelServerProbeResult,
  ModelServerView,
} from '@shared/modelServers';
import type { SecretCipher, StoreFile } from '../chat/mcp/McpServerStore';
import { OllamaLocal } from '../chat/OllamaLocal';
import type { CompletionStreamEvent } from '../chat/streamEvents';
import { registerModelServersIpc } from './ipc';
import { LocalModels } from './LocalModels';
import { ModelServerRegistry } from './ModelServerRegistry';
import { ModelServerStore } from './ModelServerStore';

// The `/` and `"` reach the echoing server's JSON escaped, as `\/` and `\"`.
const BEARER = 'sentinel-bearer/7f3a9c2e41d8';
const HEADER_NAME = 'x-api-key';
const HEADER_VALUE = 'sentinel-header"b62d0e95a7c3';
const SENTINELS = [BEARER, HEADER_VALUE];

/** Every form a leak could take: the value, its base64, and its unique tail (a masked or cut copy). */
const LEAK_FORMS = SENTINELS.flatMap(secret => [
  secret,
  Buffer.from(secret).toString('base64'),
  Buffer.from(secret).toString('base64url'),
  secret.slice(-12),
]);

function render(value: unknown): string {
  if (typeof value === 'string') return value;
  const text = inspect(value, {
    depth: Infinity,
    showHidden: true,
    maxArrayLength: Infinity,
    maxStringLength: Infinity,
    breakLength: Infinity,
  });
  return value instanceof Error ? `${String(value)}\n${value.stack ?? ''}\n${text}` : text;
}

/** Everything that leaves main for anywhere but the server's own request headers. */
class Outbound {
  readonly records: { where: string; text: string }[] = [];

  add(where: string, value: unknown): void {
    this.records.push({ where, text: render(value) });
  }

  /** The IPC boundary structured-clones, so a reply that cannot be cloned fails here too. */
  ipc(where: string, value: unknown): void {
    this.add(where, structuredClone(value));
  }

  leaks(): string[] {
    return this.records.flatMap(({ where, text }) =>
      LEAK_FORMS.filter(form => text.includes(form)).map(form => `${where} contains ${form}`)
    );
  }
}

// XOR stands in for safeStorage: the file holds bytes that are not the secret in any encoding.
function xorCipher(keyring: boolean): SecretCipher {
  const flip = (bytes: Uint8Array) => Buffer.from(Uint8Array.from(bytes, byte => byte ^ 0x5a));
  return {
    isEncryptionAvailable: () => keyring,
    encryptString: plain => flip(Buffer.from(plain, 'utf8')),
    decryptString: encrypted => flip(encrypted).toString('utf8'),
  };
}

function capturedFile(out: Outbound, saved: string | null): StoreFile & { contents(): string | null } {
  let contents = saved;
  return {
    read: () => Promise.resolve(contents),
    write: next => {
      contents = next;
      out.add('model-servers.json', next);
      return Promise.resolve();
    },
    contents: () => contents,
  };
}

type Mode =
  'ok' | 'reject' | 'error' | 'hang' | 'echo-401' | 'echo-500' | 'echo-stream' | 'paused-echo-stream' | 'echo-pull';

/** A server or proxy that quotes the credential it was sent back in its error, escaping `/` as some encoders do. */
const echoText = (req: http.IncomingMessage) =>
  `credential ${[req.headers.authorization, req.headers[HEADER_NAME]].filter(Boolean).join(' ')} is not valid here`;
const echoJson = (value: unknown) => JSON.stringify(value).replaceAll('/', '\\/');

interface Seen {
  method: string;
  url: string;
  headers: IncomingHttpHeaders;
  body: string;
}

const servers: http.Server[] = [];

/** A model server on loopback, where http may carry a credential, that records every request it gets. */
async function fakeServer(kind: ModelServerKind) {
  const seen: Seen[] = [];
  const state = { mode: 'ok' as Mode };
  const pausedStream = Promise.withResolvers<() => void>();
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', chunk => (body += chunk));
    req.on('end', () => {
      seen.push({ method: req.method ?? '', url: req.url ?? '', headers: req.headers, body });
      if (state.mode === 'hang') return;
      const send = (status: number, payload: unknown, type = 'application/json') => {
        res.writeHead(status, { 'content-type': type });
        res.end(typeof payload === 'string' ? payload : JSON.stringify(payload));
      };
      if (state.mode === 'reject') return send(401, { error: 'unauthorized' });
      if (state.mode === 'error') return send(500, { error: 'the model failed to load' });
      if (state.mode === 'echo-401' || state.mode === 'echo-500') {
        res.writeHead(state.mode === 'echo-401' ? 401 : 500, `Rejected ${echoText(req)}`, {
          'content-type': 'application/json',
        });
        return res.end(echoJson({ error: echoText(req) }));
      }
      const route = `${req.method} ${req.url}`;
      if (
        state.mode === 'paused-echo-stream' &&
        (route === 'POST /api/chat' || route === 'POST /v1/chat/completions')
      ) {
        const isOllama = route === 'POST /api/chat';
        res.writeHead(200, { 'content-type': isOllama ? 'application/x-ndjson' : 'text/event-stream' });
        res.flushHeaders();
        // The caller can rotate or delete the credential after this request used it, before its error arrives.
        pausedStream.resolve(() =>
          res.end(
            isOllama
              ? `${echoJson({ error: echoText(req) })}\n`
              : `data: ${echoJson({ error: { message: echoText(req) } })}\n\n`
          )
        );
        return;
      }
      if (state.mode === 'echo-pull' && route === 'POST /api/pull')
        return send(
          200,
          `${echoJson({ status: echoText(req) })}\n${echoJson({ error: echoText(req) })}\n`,
          'application/x-ndjson'
        );
      if (state.mode === 'echo-stream' && route === 'POST /api/chat')
        return send(200, `${echoJson({ error: echoText(req) })}\n`, 'application/x-ndjson');
      if (state.mode === 'echo-stream' && route === 'POST /v1/chat/completions')
        return send(200, `data: ${echoJson({ error: { message: echoText(req) } })}\n\n`, 'text/event-stream');
      if (kind === 'ollama') {
        if (route === 'GET /api/version') return send(200, { version: '0.12.0' });
        if (route === 'GET /api/tags') return send(200, { models: [{ name: 'qwen2.5:0.5b', size: 1, digest: 'd1' }] });
        if (route === 'POST /api/show')
          return send(200, { capabilities: ['completion'], model_info: { 'qwen2.context_length': 4096 } });
        if (route === 'POST /api/chat')
          return send(
            200,
            `${JSON.stringify({ message: { content: 'hello' }, done: false })}\n${JSON.stringify({ message: { content: '' }, done: true, done_reason: 'stop' })}\n`,
            'application/x-ndjson'
          );
      } else {
        if (route === 'GET /v1/models') return send(200, { object: 'list', data: [{ id: 'm1', object: 'model' }] });
        if (route === 'POST /v1/chat/completions')
          return send(
            200,
            `data: ${JSON.stringify({ choices: [{ delta: { content: 'hello' } }] })}\n\ndata: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`,
            'text/event-stream'
          );
      }
      return send(404, { error: 'not found' });
    });
  });
  servers.push(server);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    address: `http://127.0.0.1:${port}`,
    seen,
    state,
    pausedStream: pausedStream.promise,
    close: () => {
      server.closeAllConnections();
      return new Promise(resolve => server.close(resolve));
    },
  };
}

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  await Promise.all(
    servers.splice(0).map(server => {
      server.closeAllConnections();
      return new Promise(resolve => server.close(resolve));
    })
  );
});

/** main as chat/index.ts wires it, with every exit from main captured. */
function desktopMain(cipher: SecretCipher, out = new Outbound(), saved: string | null = null) {
  for (const level of ['log', 'info', 'warn', 'error', 'debug', 'trace'] as const) {
    vi.spyOn(console, level).mockImplementation((...args: unknown[]) => out.add(`console.${level}`, args));
  }
  // Anything on the global fetch is not a saved server's request; "This computer" gets no Ollama here.
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: unknown, init?: unknown) => {
      out.add('global fetch', { input, init });
      throw new TypeError('fetch failed', { cause: Object.assign(new Error('refused'), { code: 'ECONNREFUSED' }) });
    })
  );
  const logger = {
    debug: (message: string) => out.add('log.debug', message),
    warn: (message: string) => out.add('log.warn', message),
  };
  const file = capturedFile(out, saved);
  const store = new ModelServerStore(cipher, file, logger);
  const registry = new ModelServerRegistry({
    store,
    logger,
    changed: views => out.ipc(`push ${IPC_CHANNELS.modelServersChanged}`, views),
  });
  const local = new LocalModels(new OllamaLocal(), registry);

  const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>();
  const ipcMain = {
    handle: (channel: string, listener: (event: unknown, ...args: unknown[]) => unknown) => {
      handlers.set(channel, listener);
    },
  } as unknown as Pick<IpcMain, 'handle'>;
  registerModelServersIpc(ipcMain, registry);
  const invoke = async <T>(channel: string, ...args: unknown[]): Promise<T> => {
    const handler = handlers.get(channel);
    if (!handler) throw new Error(`no handler for ${channel}`);
    const reply = (await handler({}, ...args)) as T;
    out.ipc(`reply ${channel}`, reply);
    return reply;
  };

  const listModels = async () => out.ipc(`reply ${IPC_CHANNELS.chatListModels}`, await local.models());

  /** A chat turn as ChatService runs it: events go to the renderer, a failure's message to the log, renderer and history. */
  const chat = async (model: string, signal?: AbortSignal) => {
    const events: CompletionStreamEvent[] = [];
    try {
      await local.stream({ model, messages: [{ role: 'user', content: 'hi' }] }, event => events.push(event), signal);
      return { events, error: null };
    } catch (err) {
      out.add('chat error', err);
      return { events, error: err as Error };
    } finally {
      out.ipc('push chat events', events);
    }
  };

  return { out, store, registry, file, invoke, listModels, chat };
}

function credential(type: 'bearer' | 'header'): ModelServerCredentialInput {
  return type === 'bearer' ? { type, token: BEARER } : { type, name: HEADER_NAME, value: HEADER_VALUE };
}

/** The sentinel may reach the server only as the exact credential header; never in a URL, body or other header. */
function requestLeaks(seen: Seen[]): string[] {
  return seen.flatMap(request => {
    const where = `${request.method} ${request.url}`;
    const found = LEAK_FORMS.filter(form => request.url.includes(form) || request.body.includes(form)).map(
      form => `${where} url or body contains ${form}`
    );
    for (const [name, value] of Object.entries(request.headers)) {
      const text = String(value);
      const allowed =
        (name === 'authorization' && text === `Bearer ${BEARER}`) || (name === HEADER_NAME && text === HEADER_VALUE);
      if (!allowed) found.push(...LEAK_FORMS.filter(form => text.includes(form)).map(form => `${where} ${name}`));
    }
    return found;
  });
}

async function scenario(kind: ModelServerKind, keyring: boolean, first: 'bearer' | 'header') {
  const second = first === 'bearer' ? 'header' : 'bearer';
  const target = await fakeServer(kind);
  const cipher = xorCipher(keyring);
  const main = desktopMain(cipher);
  const { invoke, out } = main;
  await main.registry.start();

  // Entered: a value HTTP refuses is turned away without the value in the message.
  const invalid: ModelServerCredentialInput =
    first === 'bearer'
      ? { type: 'bearer', token: `${BEARER} more` }
      : { type: 'header', name: HEADER_NAME, value: `${HEADER_VALUE}\u0007` };
  const refusedInput = await invoke<ModelServerProbeResult>(IPC_CHANNELS.modelServersProbe, {
    address: target.address,
    credential: invalid,
  });
  expect(refusedInput.ok).toBe(false);
  expect(target.seen).toHaveLength(0);

  target.state.mode = 'reject';
  const rejected = await invoke<ModelServerProbeResult>(IPC_CHANNELS.modelServersProbe, {
    address: target.address,
    credential: credential(first),
  });
  expect(rejected).toMatchObject({ ok: false, needsCredentials: true });

  target.state.mode = 'ok';
  const probe = await invoke<ModelServerProbeResult>(IPC_CHANNELS.modelServersProbe, {
    address: target.address,
    credential: credential(first),
  });
  expect(probe).toMatchObject({ ok: true, kind });

  const added = await invoke<ModelServerMutationResult>(IPC_CHANNELS.modelServersAdd, {
    address: target.address,
    credential: credential(first),
    name: 'gpu box',
    kind,
    access: 'chat',
  });
  if (!added.ok) throw new Error(added.error);
  const saved = added.servers.find(server => !server.local) as ModelServerView;
  expect(saved.health.state).toBe('online');
  const model = `local:srv-${saved.id}:${kind === 'ollama' ? 'qwen2.5:0.5b' : 'm1'}`;

  await invoke(IPC_CHANNELS.modelServersList);
  await invoke(IPC_CHANNELS.modelServersCheck, saved.id);
  await invoke(IPC_CHANNELS.modelServersCheck);
  await main.listModels();
  expect((await main.chat(model)).events).toContainEqual({ type: 'content', text: 'hello' });

  // Loaded: Desktop restarts on the saved file. Without a keyring the credential was kept for that run only.
  const restarted = desktopMain(cipher, out, main.file.contents());
  await restarted.registry.start();
  const reloaded = await restarted.invoke<ModelServerView[]>(IPC_CHANNELS.modelServersList);
  expect(reloaded.find(server => server.id === saved.id)?.credentialsMissing).toBe(!keyring);
  const afterRestart = await restarted.chat(model);
  if (keyring) expect(afterRestart.events).toContainEqual({ type: 'content', text: 'hello' });
  else expect(afterRestart.error?.name).toBe('ServerCredentialsError');
  restarted.registry.stop();
  if (keyring) {
    const locked = desktopMain(
      {
        ...cipher,
        decryptString: () => {
          throw new Error('the keyring is locked');
        },
      },
      out,
      main.file.contents()
    );
    expect((await locked.chat(model)).error?.name).toBe('ServerCredentialsError');
    await locked.invoke(IPC_CHANNELS.modelServersCheck, saved.id);
    expect(out.records.some(record => record.where === 'log.warn')).toBe(true);
  }

  // Echoed: the server quotes the credential back in 401 and 500 replies and inside a streamed reply,
  // before and after the edit below.
  const echoes = async (current: 'bearer' | 'header', label: string) => {
    const chatErrors: Record<string, Error | null> = {};
    for (const mode of ['echo-401', 'echo-500', 'echo-stream'] as const) {
      target.state.mode = mode;
      await invoke(IPC_CHANNELS.modelServersProbe, { address: target.address, credential: credential(current) });
      await invoke(IPC_CHANNELS.modelServersCheck, saved.id);
      chatErrors[mode] = (await main.chat(model)).error;
      await main.listModels();
    }
    target.state.mode = 'ok';
    const echoed = 'credential [redacted] is not valid here';
    expect(chatErrors['echo-401']?.name).toBe('ServerCredentialsError');
    expect(chatErrors['echo-500']?.message).toBe(`${label} returned HTTP 500: ${echoed}`);
    expect(chatErrors['echo-stream']?.message).toBe(kind === 'ollama' ? echoed : `${label}: ${echoed}`);
  };
  await echoes(first, 'gpu box');

  // Edited: renamed, then the credential replaced with the other kind.
  await invoke(IPC_CHANNELS.modelServersUpdate, saved.id, { name: 'gpu box 2' });
  const edited = await invoke<ModelServerMutationResult>(IPC_CHANNELS.modelServersUpdate, saved.id, {
    credential: credential(second),
  });
  expect(edited.ok).toBe(true);
  expect((await main.chat(model)).events).toContainEqual({ type: 'content', text: 'hello' });
  await echoes(second, 'gpu box 2');

  // Failures: the server refuses the credential, errors, stops answering, then is gone.
  target.state.mode = 'reject';
  await invoke(IPC_CHANNELS.modelServersCheck, saved.id);
  expect((await main.chat(model)).error?.name).toBe('ServerCredentialsError');
  await main.listModels();

  target.state.mode = 'error';
  expect((await main.chat(model)).error?.message).toContain('HTTP 500');

  target.state.mode = 'hang';
  const timedOut = await invoke<ModelServerView[]>(IPC_CHANNELS.modelServersCheck, saved.id);
  expect(timedOut.find(server => server.id === saved.id)?.health.error).toMatch(/did not answer in time/);
  expect((await main.chat(model, AbortSignal.timeout(300))).error).not.toBeNull();

  await target.close();
  const down = await invoke<ModelServerView[]>(IPC_CHANNELS.modelServersCheck, saved.id);
  expect(down.find(server => server.id === saved.id)?.health.error).toMatch(/connection refused/);
  expect((await main.chat(model)).error?.name).toBe('ServerUnreachableError');
  await main.listModels();

  const removed = await invoke<ModelServerMutationResult>(IPC_CHANNELS.modelServersRemove, saved.id);
  if (!removed.ok) throw new Error(removed.error);
  expect(removed.servers.map(server => server.id)).not.toContain(saved.id);
  await main.chat(model);
  main.registry.stop();

  expect(out.leaks()).toEqual([]);
  expect(requestLeaks(target.seen)).toEqual([]);
  // The server did get both credentials, as headers.
  expect(target.seen.some(request => request.headers.authorization === `Bearer ${BEARER}`)).toBe(true);
  expect(target.seen.some(request => request.headers[HEADER_NAME] === HEADER_VALUE)).toBe(true);
  // Removal forgets the secret in main too, and the file never held it.
  expect(SENTINELS.filter(secret => render(main.store).includes(secret))).toEqual([]);
  expect(main.file.contents()).not.toMatch(/"secret"/);
  return out;
}

describe('a model server credential never leaves main except in its own request headers', () => {
  describe.each(['ollama', 'openai-compatible'] as const)('%s in-flight credential changes', kind => {
    it.each(['rotate', 'clear', 'remove'] as const)(
      'redacts an old credential after %s while a streamed error is pending',
      async mutation => {
        const target = await fakeServer(kind);
        const main = desktopMain(xorCipher(false));
        await main.registry.start();
        const added = await main.invoke<ModelServerMutationResult>(IPC_CHANNELS.modelServersAdd, {
          address: target.address,
          credential: credential('bearer'),
          name: 'gpu box',
          kind,
          access: 'chat',
        });
        if (!added.ok) throw new Error(added.error);
        const saved = added.servers.find(server => !server.local);
        if (!saved) throw new Error('The model server was not saved.');
        const model = `local:srv-${saved.id}:${kind === 'ollama' ? 'qwen2.5:0.5b' : 'm1'}`;

        target.state.mode = 'paused-echo-stream';
        const pendingChat = main.chat(model);
        const releaseError = await target.pausedStream;
        const request = target.seen.at(-1);
        expect(request?.headers.authorization).toBe(`Bearer ${BEARER}`);

        if (mutation === 'remove') {
          await main.store.remove(saved.id);
          expect(await main.store.get(saved.id)).toBeNull();
        } else {
          const updated = await main.store.update(saved.id, {
            credential: mutation === 'rotate' ? credential('header') : { type: 'none' },
          });
          expect(main.store.headers(updated)).toEqual(mutation === 'rotate' ? { [HEADER_NAME]: HEADER_VALUE } : null);
        }
        releaseError();
        const result = await pendingChat;
        main.registry.stop();

        const echoed = 'credential [redacted] is not valid here';
        expect(result.error?.message).toBe(kind === 'ollama' ? echoed : `gpu box: ${echoed}`);
        expect(result.events).toEqual([]);
        expect(main.out.leaks()).toEqual([]);
        expect(requestLeaks(target.seen)).toEqual([]);
      }
    );
  });

  it.each(['bearer', 'header'] as const)('redacts a %s credential echoed into a streamed pull', async type => {
    const target = await fakeServer('ollama');
    const main = desktopMain(xorCipher(true));
    await main.registry.start();
    const added = await main.invoke<ModelServerMutationResult>(IPC_CHANNELS.modelServersAdd, {
      address: target.address,
      credential: credential(type),
      name: 'gpu box',
      kind: 'ollama',
      access: 'manage',
    });
    if (!added.ok) throw new Error(added.error);
    const saved = added.servers.find(server => !server.local);
    const hub = saved && main.registry.hubServer(saved.id);
    if (!hub) throw new Error('The model server was not saved.');

    target.state.mode = 'echo-pull';
    const statuses: string[] = [];
    const error = await hub.runtime
      .pull('qwen2.5:0.5b', { onProgress: progress => statuses.push(progress.status) })
      .catch((err: unknown) => err);
    main.out.add('pull error', error);
    main.out.add('pull statuses', statuses);
    main.registry.stop();

    expect((error as Error).message).toMatch(
      /could not pull qwen2\.5:0\.5b: credential \[redacted\] is not valid here$/
    );
    expect(statuses).toEqual(['credential [redacted] is not valid here']);
    expect(target.seen.some(request => request.url === '/api/pull')).toBe(true);
    expect(main.out.leaks()).toEqual([]);
    expect(requestLeaks(target.seen)).toEqual([]);
  });

  it('Ollama with a keyring: bearer token, then a custom header', { timeout: 60_000 }, async () => {
    const out = await scenario('ollama', true, 'bearer');
    expect(out.records.some(record => record.where === 'model-servers.json' && record.text.includes('"secret"'))).toBe(
      true
    );
  });

  it('OpenAI-compatible without a keyring: custom header, then a bearer token', { timeout: 60_000 }, async () => {
    const out = await scenario('openai-compatible', false, 'header');
    expect(out.records.some(record => record.where === 'model-servers.json' && record.text.includes('"secret"'))).toBe(
      false
    );
  });
});
