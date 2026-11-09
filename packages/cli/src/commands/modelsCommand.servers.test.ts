import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  json,
  startFakeServer,
  startFakeVllm,
  type FakeServer,
  type FakeVllm,
  type Handler,
} from '@bike4mind/local-models/testing';
import { loadCuratedManifest, type HardwareProfile } from '@bike4mind/local-models';
import { CancelledError } from '../models/localModels.js';
import { describeSshFailure } from '@bike4mind/local-models/servers';
import { loadModelServers, type SshFetchFor } from '../models/modelServers.js';
import { readSecretOnTerminal, runModelsCommand, type ModelsDeps, type ModelServersDeps } from './modelsCommand.js';

const TOKEN = 'tok-9f8e7d6c5b4a39281706';

const CPU_64: HardwareProfile = {
  platform: 'linux',
  arch: 'x64',
  memoryKind: 'cpu',
  totalMemoryBytes: 64 * 1024 ** 3,
  gpuMemoryBytes: null,
  gpuName: null,
  gpuCount: 0,
  chip: null,
  diskFreeBytes: null,
  confidence: 'high',
};

const ollamaTags = {
  models: [
    {
      name: 'qwen2.5:0.5b',
      model: 'qwen2.5:0.5b',
      size: 397_821_319,
      digest: 'a'.repeat(64),
      modified_at: '2026-01-01T00:00:00Z',
      details: { family: 'qwen2', parameter_size: '494M', quantization_level: 'Q4_K_M' },
    },
  ],
};

/** An Ollama that answers only with the bearer token, and echoes the Authorization header into errors. */
function bearerOllama(token: string): Promise<FakeServer> {
  const guard =
    (inner: Handler): Handler =>
    (request, response) => {
      if (request.headers.authorization === `Bearer ${token}`) return inner(request, response);
      return json({ error: 'unauthorized' }, 401)(request, response);
    };
  return startFakeServer({
    'GET /api/version': guard(json({ version: '0.12.0' })),
    'GET /api/tags': guard(json(ollamaTags)),
    'GET /api/ps': guard(json({ models: [] })),
    'POST /api/pull': guard((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/x-ndjson' });
      response.end(`${JSON.stringify({ status: 'success' })}\n`);
    }),
  });
}

function plainOllama(): Promise<FakeServer> {
  return startFakeServer({
    'GET /api/version': json({ version: '0.12.0' }),
    'GET /api/tags': json(ollamaTags),
    'GET /api/ps': json({ models: [] }),
  });
}

function record(over: Record<string, unknown>): Record<string, unknown> {
  return {
    id: 'a1b2c3',
    name: 'gpu-box',
    kind: 'ollama',
    transport: { type: 'http', baseUrl: 'http://127.0.0.1:1' },
    access: 'manage',
    auth: { type: 'none' },
    models: [],
    addedAt: '2026-10-01T00:00:00.000Z',
    ...over,
  };
}

let dir: string;
let lines: string[];
let saved: { defaultModel?: string; localDefaultModel?: string; ollamaHost?: string }[];
let secrets: Record<string, string>;
const open: { close(): Promise<void> }[] = [];

beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'b4m-servers-'));
  lines = [];
  saved = [];
  secrets = {};
});

afterEach(async () => {
  await Promise.all(open.splice(0).map(server => server.close()));
  await rm(dir, { recursive: true, force: true });
});

async function writeServers(servers: Record<string, unknown>[]): Promise<void> {
  await writeFile(path.join(dir, 'model-servers.json'), JSON.stringify({ version: 1, servers }));
}

/** A llama-swap listing `count` models, answering only with the bearer token. */
function swapServer(token: string, count: number): Promise<FakeServer> {
  return startFakeServer({
    'GET /v1/models': (request, response) =>
      request.headers.authorization === `Bearer ${token}`
        ? json({
            object: 'list',
            data: Array.from({ length: count }, (_, index) => ({ id: `model-${index}`, owned_by: 'llama-swap' })),
          })(request, response)
        : json({ error: { message: `Invalid key ${request.headers.authorization ?? ''}` } }, 401)(request, response),
  });
}

/**
 * Stands in for the system ssh: a forward to `127.0.0.1:<port>` on the far end reaches `farEnd[port]`, and a port with
 * nothing on it fails as ssh's forward does.
 */
function fakeSsh(farEnd: Record<number, string>) {
  const forwards: { destination: string; port: number; path: string; authorization: string | null }[] = [];
  const sshFetchFor: SshFetchFor = endpoint => async (input, init) => {
    const url = new URL(String(input));
    const port = endpoint.port ?? 11434;
    const headers = new Headers(init?.headers);
    for (const [name, value] of Object.entries(endpoint.credentialHeaders?.() ?? {})) headers.set(name, value);
    forwards.push({
      destination: endpoint.destination,
      port,
      path: url.pathname,
      authorization: headers.get('authorization'),
    });
    if (url.origin !== `http://127.0.0.1:${port}`) throw new Error(`${url.origin} is not the forwarded port`);
    const local = farEnd[port];
    if (!local) {
      const cause = describeSshFailure(
        'channel 0: open failed: connect failed: Connection refused\nstdio forwarding failed\n',
        255,
        endpoint.destination,
        'The CLI',
        'linux',
        port
      );
      throw Object.assign(new TypeError('fetch failed'), { cause });
    }
    return fetch(`${local}${url.pathname}${url.search}`, { ...init, headers });
  };
  return { sshFetchFor, forwards };
}

function deps(
  over: {
    stdin?: string;
    secretPrompt?: string;
    isTTY?: boolean;
    stdinIsTTY?: boolean;
    pull?: boolean;
    ssh?: { sshFetchFor: SshFetchFor };
    signal?: AbortSignal;
  } = {}
): ModelsDeps {
  const unused = () => {
    throw new Error('not used');
  };
  const servers: ModelServersDeps = {
    load: () =>
      loadModelServers(() =>
        import('@bike4mind/local-models/servers').then(m => m.readDesktopModelServers({ dirs: [dir] }))
      ),
    secret: id => secrets[id],
    saveSecret: async (id, secret) => {
      secrets[id] = secret;
    },
    clearSecret: async id => {
      delete secrets[id];
    },
    readSecret: async () => over.secretPrompt ?? '',
    readStdin: async () => over.stdin ?? '',
    resolveHost: async () => [],
    stdinIsTTY: over.stdinIsTTY ?? over.isTTY ?? true,
    // Never the system ssh: a test that reaches for it without a fake fails here.
    sshFetchFor: over.ssh?.sshFetchFor ?? (() => () => Promise.reject(new Error('ssh is not used in this test'))),
  };
  return {
    hub: unused,
    ollamaRegistry: over.pull
      ? async () => ({ digest: 'd'.repeat(64), layers: ['d'.repeat(64)], sizeBytes: 1000, licenses: [] })
      : unused,
    libraryLayers: over.pull ? async () => null : unused,
    resolveRuntime: unused,
    config: {
      defaultModel: undefined,
      ollamaHost: undefined,
      save: async patch => {
        saved.push(patch);
      },
    },
    confirm: async () => false,
    isTTY: over.isTTY ?? true,
    log: line => lines.push(line),
    progress: { update: () => undefined, end: () => undefined },
    machine: over.pull ? async () => ({ hardware: CPU_64 }) : unused,
    runtimeHost: () => null,
    curated: over.pull ? () => loadCuratedManifest(() => {}) : unused,
    hardware: unused,
    servers,
    signal: over.signal ?? new AbortController().signal,
  };
}

const run = (subcommand: string, argv: Record<string, unknown>, d: ModelsDeps = deps()): Promise<number> =>
  runModelsCommand(subcommand, { _: ['models', subcommand], ...argv }, d);

const output = () => lines.join('\n');

describe('b4m models servers', () => {
  it('lists Ollama and vLLM servers with their status and credential state', async () => {
    const ollama = await plainOllama();
    const vllm: FakeVllm = await startFakeVllm();
    const locked = await bearerOllama(TOKEN);
    open.push(ollama, vllm, locked);
    await writeServers([
      record({ id: 'aaa', name: 'shared', transport: { type: 'http', baseUrl: ollama.baseUrl } }),
      record({
        id: 'bbb',
        name: 'vllm',
        kind: 'openai-compatible',
        access: 'chat',
        transport: { type: 'http', baseUrl: vllm.baseUrl },
        models: ['qwen-small'],
      }),
      record({
        id: 'ccc',
        name: 'locked',
        auth: { type: 'bearer' },
        transport: { type: 'http', baseUrl: locked.baseUrl },
      }),
    ]);

    expect(await run('servers', {})).toBe(0);
    const text = output();
    expect(text).toMatch(/shared\s+Ollama\s+http:\/\/127\.0\.0\.1:\d+\s+Manage\s+none\s+online/);
    expect(text).toMatch(/vllm\s+vLLM\s+http:\/\/127\.0\.0\.1:\d+\s+Chat only\s+none\s+online/);
    expect(text).toMatch(/locked\s+Ollama\s+.*needed: b4m models servers login locked\s+needs credentials/);
  });

  it('reports the tools hint when a vLLM refuses tool calls', async () => {
    const vllm = await startFakeVllm({ toolFlags: false });
    open.push(vllm);
    await writeServers([
      record({
        id: 'bbb',
        name: 'vllm',
        kind: 'openai-compatible',
        transport: { type: 'http', baseUrl: vllm.baseUrl },
        models: ['qwen-small'],
      }),
    ]);
    await run('servers', { 'check-tools': true });
    expect(output()).toContain('--enable-auto-tool-choice');
    expect(output()).toContain('b4m models servers --check-tools');
  });

  it('does not send a chat request unless asked to check tools', async () => {
    const vllm = await startFakeVllm({ toolFlags: false });
    open.push(vllm);
    await writeServers([
      record({
        id: 'bbb',
        name: 'vllm',
        kind: 'openai-compatible',
        transport: { type: 'http', baseUrl: vllm.baseUrl },
        models: ['qwen-small'],
      }),
    ]);
    await run('servers', {});
    expect(output()).toContain('Tool support: not checked');
    expect(output()).toContain('--check-tools');
    expect(vllm.requests).toEqual([]);
  });

  it('mirrors the list as JSON without any credential', async () => {
    const locked = await bearerOllama(TOKEN);
    open.push(locked);
    await writeServers([
      record({
        id: 'ccc',
        name: 'locked',
        auth: { type: 'bearer' },
        transport: { type: 'http', baseUrl: locked.baseUrl },
      }),
    ]);
    secrets.ccc = TOKEN;
    await run('servers', { 'output-format': 'json' });
    const parsed = JSON.parse(output()) as {
      servers: { name: string; credentials: string; status: { state: string } }[];
    };
    expect(parsed.servers).toMatchObject([{ name: 'locked', credentials: 'set', status: { state: 'online' } }]);
    expect(output()).not.toContain(TOKEN);
  });

  it('says so when Desktop has no servers', async () => {
    await run('servers', {});
    expect(output()).toMatch(/No model servers are saved in Desktop/);
  });

  it('lists, checks and uses Desktop SSH servers, an old one without a port as Ollama on 11434', async () => {
    const ollama = await plainOllama();
    const swap = await swapServer(TOKEN, 120);
    open.push(ollama, swap);
    await writeServers([
      record({ id: 'sss', name: 'lab', access: 'chat', transport: { type: 'ssh', destination: 'me@lab' } }),
      record({
        id: 'ttt',
        name: 'swap',
        kind: 'openai-compatible',
        auth: { type: 'bearer' },
        transport: { type: 'ssh', destination: 'me@lab', port: 8080 },
      }),
    ]);
    secrets.ttt = TOKEN;
    const ssh = fakeSsh({ 11434: ollama.baseUrl, 8080: swap.baseUrl });
    expect(await run('servers', {}, deps({ ssh }))).toBe(0);
    expect(output()).toMatch(/lab\s+Ollama\s+ssh me@lab\s+Chat only\s+none\s+online/);
    expect(output()).toMatch(/swap\s+llama-swap\s+ssh me@lab port 8080\s+Manage\s+set\s+online/);
    expect(ssh.forwards.every(forward => forward.destination === 'me@lab')).toBe(true);
    expect(
      ssh.forwards.filter(forward => forward.port === 11434).every(forward => forward.authorization === null)
    ).toBe(true);

    lines.length = 0;
    await run('servers', { 'output-format': 'json' }, deps({ ssh }));
    const parsed = JSON.parse(output()) as { servers: { name: string; transport: string; address: string }[] };
    expect(parsed.servers.map(server => [server.name, server.transport, server.address])).toEqual([
      ['lab', 'ssh', 'ssh me@lab'],
      ['swap', 'ssh', 'ssh me@lab port 8080'],
    ]);

    lines.length = 0;
    expect(await run('ls', { server: 'swap', 'output-format': 'json' }, deps({ ssh }))).toBe(0);
    expect(output()).toContain('model-119');
    expect(swap.requests.some(request => request.headers.authorization === `Bearer ${TOKEN}`)).toBe(true);
    expect(output()).not.toContain(TOKEN);
  });

  it('lists an SSH server saved with a port or destination it cannot use, says why, and never runs ssh for it', async () => {
    const ollama = await plainOllama();
    open.push(ollama);
    await writeServers([
      record({ id: 'sss', name: 'lab', transport: { type: 'ssh', destination: 'me@lab' } }),
      record({ id: 'bad', name: 'typo', transport: { type: 'ssh', destination: 'me@lab', port: 99999 } }),
      record({ id: 'opt', name: 'hostile', transport: { type: 'ssh', destination: '-oProxyCommand=x', port: 22 } }),
    ]);
    const ssh = fakeSsh({ 11434: ollama.baseUrl });
    const why = 'Remove it in Desktop and add it again.';
    expect(await run('servers', {}, deps({ ssh }))).toBe(0);
    expect(output()).toMatch(/lab\s+Ollama\s+ssh me@lab\s+Manage\s+none\s+online/);
    expect(output()).toMatch(
      new RegExp(
        `typo\\s+Ollama\\s+ssh me@lab\\s+Manage\\s+none\\s+Its saved SSH port is not a number from 1 to 65535\\. ${why}`
      )
    );
    expect(output()).toMatch(/hostile\s+Ollama\s+unusable address\s+Manage\s+none\s+Its saved SSH destination is not/);
    expect(output()).not.toContain('ProxyCommand');
    expect(ssh.forwards.every(forward => forward.port === 11434)).toBe(true);

    lines.length = 0;
    await run('servers', { 'output-format': 'json' }, deps({ ssh }));
    const parsed = JSON.parse(output()) as {
      servers: { name: string; address: string; status: { state: string; text: string } }[];
    };
    expect(parsed.servers.map(server => [server.name, server.address, server.status.state])).toEqual([
      ['lab', 'ssh me@lab', 'online'],
      ['typo', 'ssh me@lab', 'refused'],
      ['hostile', 'unusable address', 'refused'],
    ]);
    expect(parsed.servers[1].status.text).toBe(`Its saved SSH port is not a number from 1 to 65535. ${why}`);

    lines.length = 0;
    await expect(run('ls', { server: 'typo' }, deps({ ssh }))).rejects.toThrow(
      `typo cannot be used: Its saved SSH port is not a number from 1 to 65535. ${why}`
    );
  });

  it('names the port to check when an SSH server is not running', async () => {
    await writeServers([
      record({ id: 'sss', name: 'lab', transport: { type: 'ssh', destination: 'me@lab', port: 9001 } }),
    ]);
    await run('servers', {}, deps({ ssh: fakeSsh({}) }));
    expect(output()).toMatch(/lab\s+Ollama\s+ssh me@lab port 9001\s+.*nothing answers at 127\.0\.0\.1:9001/);
  });

  it('reports an unreachable server as offline', async () => {
    await writeServers([record({ name: 'gone' })]);
    await run('servers', {});
    expect(output()).toMatch(/gone\s+Ollama\s+.*connection refused/);
  });
});

describe('b4m models servers discover', () => {
  it('finds every server on the usual ports and says where to save one, sending no token', async () => {
    const ollama = await plainOllama();
    const swap = await swapServer(TOKEN, 3);
    open.push(ollama, swap);
    const ssh = fakeSsh({ 11434: ollama.baseUrl, 8080: swap.baseUrl });
    expect(await run('servers', { action: 'discover', name: 'me@lab' }, deps({ ssh }))).toBe(0);
    expect(output()).toContain(
      'Looking for model servers on me@lab (Ollama 11434, LM Studio 1234, llama-server 8080, vLLM 8000)'
    );
    expect(output()).toMatch(/11434\s+Ollama\s+0\.12\.0\s+1/);
    expect(output()).toMatch(/8080\s+OpenAI-compatible\s+asks for an API key/);
    expect(output()).toContain('add it in Desktop under Settings, Model servers: choose SSH and enter me@lab');
    expect(new Set(ssh.forwards.map(forward => forward.port))).toEqual(new Set([11434, 1234, 8080, 8000]));
    expect(ssh.forwards.every(forward => forward.authorization === null)).toBe(true);
  });

  it('looks only at a port given with --port, and answers as JSON', async () => {
    const swap = await swapServer(TOKEN, 3);
    open.push(swap);
    const ssh = fakeSsh({ 9001: swap.baseUrl });
    expect(
      await run('servers', { action: 'discover', name: 'me@lab', port: '9001', 'output-format': 'json' }, deps({ ssh }))
    ).toBe(0);
    expect(JSON.parse(output())).toMatchObject({
      destination: 'me@lab',
      found: [{ port: 9001, kind: 'openai-compatible', needsCredentials: true }],
      error: null,
    });
    expect(new Set(ssh.forwards.map(forward => forward.port))).toEqual(new Set([9001]));
  });

  it('says what to do when nothing answers', async () => {
    await expect(run('servers', { action: 'discover', name: 'me@lab' }, deps({ ssh: fakeSsh({}) }))).rejects.toThrow(
      'SSH to me@lab works, but no model server answers on the usual ports there (Ollama 11434, LM Studio 1234, llama-server 8080, vLLM 8000). Start the server on that machine, or enter the port it listens on.'
    );
    lines.length = 0;
    expect(
      await run('servers', { action: 'discover', name: 'me@lab', 'output-format': 'json' }, deps({ ssh: fakeSsh({}) }))
    ).toBe(1);
    expect(JSON.parse(output())).toMatchObject({
      found: [],
      error: expect.stringContaining('no model server answers'),
    });
  });

  it('refuses a bad port or destination before running ssh', async () => {
    const ssh = fakeSsh({});
    for (const port of ['', ' ', '0', '70000', '8080;id', '-W']) {
      await expect(run('servers', { action: 'discover', name: 'me@lab', port }, deps({ ssh }))).rejects.toThrow(
        'a number from 1 to 65535'
      );
    }
    await expect(run('servers', { action: 'discover', name: '-oProxyCommand=x' }, deps({ ssh }))).rejects.toThrow(
      'cannot start with "-"'
    );
    await expect(run('servers', { action: 'discover' }, deps({ ssh }))).rejects.toThrow(
      'Usage: b4m models servers discover'
    );
    expect(ssh.forwards).toEqual([]);
  });

  it('refuses --port outside discover rather than ignoring it', async () => {
    await expect(run('servers', { action: 'login', name: 'locked', port: '8080' })).rejects.toThrow(
      '--port works only with: b4m models servers discover'
    );
  });

  it('on Ctrl-C, ends the ssh requests in flight and starts no more', async () => {
    const requests: AbortSignal[] = [];
    const sshFetchFor: SshFetchFor = () => (_input, init) =>
      new Promise((_resolve, reject) => {
        const signal = init?.signal as AbortSignal;
        requests.push(signal);
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      });
    const ctrlC = new AbortController();
    const running = run(
      'servers',
      { action: 'discover', name: 'me@lab' },
      deps({ ssh: { sshFetchFor }, signal: ctrlC.signal })
    );
    await vi.waitFor(() => expect(requests).toHaveLength(1));
    ctrlC.abort(new DOMException('Cancelled', 'AbortError'));
    expect(await running).toBe(130);
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(requests).toHaveLength(1);
    expect(requests.every(signal => signal.aborted)).toBe(true);
  });

  it('starts nothing when Ctrl-C came first, and leaves no rejection unhandled', async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on('unhandledRejection', onUnhandled);
    try {
      const ssh = fakeSsh({});
      const ctrlC = new AbortController();
      ctrlC.abort(new DOMException('Cancelled', 'AbortError'));
      const code = await run('servers', { action: 'discover', name: 'me@lab' }, deps({ ssh, signal: ctrlC.signal }));
      expect(code).toBe(130);
      await new Promise(resolve => setTimeout(resolve, 20));
      expect(ssh.forwards).toEqual([]);
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });

  it('on Ctrl-C, ends the ssh request already running for a listing, a login and a --server command', async () => {
    await writeServers([
      record({
        id: 'ttt',
        name: 'swap',
        kind: 'openai-compatible',
        auth: { type: 'bearer' },
        transport: { type: 'ssh', destination: 'me@lab', port: 8080 },
      }),
    ]);
    secrets.ttt = TOKEN;
    const commands: [string, Record<string, unknown>][] = [
      ['servers', {}],
      ['servers', { action: 'login', name: 'swap', 'token-stdin': true }],
      ['ls', { server: 'swap' }],
    ];
    for (const [subcommand, argv] of commands) {
      const requests: (AbortSignal | undefined)[] = [];
      const sshFetchFor: SshFetchFor = () => (_input, init) =>
        new Promise((_resolve, reject) => {
          const signal = init?.signal ?? undefined;
          requests.push(signal);
          signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
        });
      const ctrlC = new AbortController();
      const running = run(subcommand, argv, deps({ stdin: TOKEN, ssh: { sshFetchFor }, signal: ctrlC.signal })).catch(
        () => 130
      );
      await vi.waitFor(() => expect(requests.length).toBeGreaterThan(0));
      ctrlC.abort(new DOMException('Cancelled', 'AbortError'));
      await running;
      expect(requests.every(signal => signal?.aborted === true)).toBe(true);
    }
  });
});

describe('b4m models servers login and logout', () => {
  async function lockedServer() {
    const locked = await bearerOllama(TOKEN);
    open.push(locked);
    await writeServers([
      record({
        id: 'ccc',
        name: 'locked',
        auth: { type: 'bearer' },
        transport: { type: 'http', baseUrl: locked.baseUrl },
      }),
    ]);
    return locked;
  }

  it.each([
    { transport: 'http', phase: 'probe' },
    { transport: 'http', phase: 'listing' },
    { transport: 'ssh', phase: 'probe' },
    { transport: 'ssh', phase: 'listing' },
  ] as const)(
    'on Ctrl-C during $phase on an $transport server, ends the request and saves nothing',
    async ({ transport, phase }) => {
      let requests = 0;
      let pending = false;
      let closed = false;
      const models = { data: [{ id: 'qwen', owned_by: 'other' }] };
      const stalled = await startFakeServer({
        'GET /v1/models': (request, response) => {
          requests += 1;
          if (phase === 'listing' && requests === 1) return json(models)(request, response);
          pending = true;
          response.once('close', () => {
            closed = true;
          });
        },
      });
      open.push(stalled);
      const signals: AbortSignal[] = [];
      const sshFetchFor: SshFetchFor = () => async (_input, init) => {
        requests += 1;
        if (phase === 'listing' && requests === 1) return Response.json(models);
        const signal = init?.signal;
        if (!signal) throw new Error('The request must be abortable.');
        signals.push(signal);
        pending = true;
        return new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(signal.reason), { once: true });
        });
      };
      await writeServers([
        record({
          id: 'ccc',
          name: 'locked',
          kind: 'openai-compatible',
          auth: { type: 'bearer' },
          transport:
            transport === 'ssh'
              ? { type: 'ssh', destination: 'me@lab', port: 8080 }
              : { type: 'http', baseUrl: stalled.baseUrl },
        }),
      ]);
      const ctrlC = new AbortController();
      const running = run(
        'servers',
        { action: 'login', name: 'locked', 'token-stdin': true },
        deps({ stdin: TOKEN, ssh: { sshFetchFor }, signal: ctrlC.signal })
      );
      await vi.waitFor(() => expect(pending).toBe(true));
      const started = performance.now();
      ctrlC.abort(new DOMException('Cancelled', 'AbortError'));
      expect(await running).toBe(130);
      expect(performance.now() - started).toBeLessThan(1_000);
      if (transport === 'ssh') {
        expect(signals).toHaveLength(1);
        expect(signals[0].aborted).toBe(true);
      } else {
        await vi.waitFor(() => expect(closed).toBe(true), { timeout: 1_000 });
      }
      expect(output()).toBe('Cancelled.');
      expect(secrets).toEqual({});
    }
  );

  it('saves the credential only after the server answers with it', async () => {
    await lockedServer();
    const code = await run('servers', { action: 'login', name: 'locked' }, deps({ secretPrompt: TOKEN }));
    expect(code).toBe(0);
    expect(secrets).toEqual({ ccc: TOKEN });
    expect(output()).not.toContain(TOKEN);
  });

  it('refuses a wrong token and saves nothing', async () => {
    await lockedServer();
    const attempt = run(
      'servers',
      { action: 'login', name: 'locked' },
      deps({ secretPrompt: 'wrong-token-value-1234' })
    );
    await expect(attempt).rejects.toThrow('locked refused these credentials. Nothing was saved.');
    expect(secrets).toEqual({});
  });

  it('reads the token from stdin with --token-stdin, even without a terminal', async () => {
    await lockedServer();
    const code = await run(
      'servers',
      { action: 'login', name: 'locked', 'token-stdin': true },
      deps({ stdin: `${TOKEN}\n`, isTTY: false })
    );
    expect(code).toBe(0);
    expect(secrets).toEqual({ ccc: TOKEN });
  });

  it('refuses a wrong token when the version endpoint is open but the model list is protected', async () => {
    const tagsOnly: Handler = (request, response) =>
      request.headers.authorization === `Bearer ${TOKEN}`
        ? json(ollamaTags)(request, response)
        : json({ error: 'unauthorized' }, 401)(request, response);
    const half = await startFakeServer({
      'GET /api/version': json({ version: '0.12.0' }),
      'GET /api/tags': tagsOnly,
      'GET /api/ps': json({ models: [] }),
    });
    open.push(half);
    await writeServers([
      record({ id: 'ccc', name: 'half', auth: { type: 'bearer' }, transport: { type: 'http', baseUrl: half.baseUrl } }),
    ]);
    await expect(
      run('servers', { action: 'login', name: 'half' }, deps({ secretPrompt: 'wrong-token-value-1234' }))
    ).rejects.toThrow('half refused these credentials. Nothing was saved.');
    expect(secrets).toEqual({});
    expect(await run('servers', { action: 'login', name: 'half' }, deps({ secretPrompt: TOKEN }))).toBe(0);
    expect(secrets).toEqual({ ccc: TOKEN });
  });

  it('prompts when only stdin is a terminal', async () => {
    await lockedServer();
    const code = await run(
      'servers',
      { action: 'login', name: 'locked' },
      deps({ secretPrompt: TOKEN, isTTY: false, stdinIsTTY: true })
    );
    expect(code).toBe(0);
    expect(secrets).toEqual({ ccc: TOKEN });
  });

  it('logout by name removes the credential of a saved server Desktop cannot use', async () => {
    await writeServers([
      record({
        id: 'bad',
        name: 'typo',
        auth: { type: 'bearer' },
        transport: { type: 'ssh', destination: 'me@lab', port: 0 },
      }),
    ]);
    secrets.bad = TOKEN;
    await run('servers', { action: 'logout', name: 'typo' });
    expect(secrets).toEqual({});
    expect(output()).toContain("Removed the CLI's saved credentials for typo");
  });

  it('logout accepts the raw id of a server Desktop no longer lists', async () => {
    secrets.gone123 = TOKEN;
    await run('servers', { action: 'logout', name: 'gone123' });
    expect(secrets).toEqual({});
    expect(output()).toContain("Removed the CLI's saved credentials for gone123");
  });

  it('asks for --token-stdin when there is no terminal to prompt on', async () => {
    await lockedServer();
    await expect(run('servers', { action: 'login', name: 'locked' }, deps({ isTTY: false }))).rejects.toThrow(
      '--token-stdin'
    );
  });

  it('does not take credentials for a server that needs none', async () => {
    const ollama = await plainOllama();
    open.push(ollama);
    await writeServers([record({ name: 'shared', transport: { type: 'http', baseUrl: ollama.baseUrl } })]);
    await expect(run('servers', { action: 'login', name: 'shared' }, deps({ secretPrompt: 'x' }))).rejects.toThrow(
      'does not use credentials'
    );
  });

  it('logout removes the saved credential', async () => {
    await lockedServer();
    secrets.ccc = TOKEN;
    await run('servers', { action: 'logout', name: 'locked' });
    expect(secrets).toEqual({});
    expect(output()).toContain("Removed the CLI's saved credentials for locked");
    lines.length = 0;
    await run('servers', { action: 'logout', name: 'locked' });
    expect(output()).toContain('no saved credentials');
  });

  it('names the saved servers when the name is unknown', async () => {
    await lockedServer();
    await expect(run('servers', { action: 'login', name: 'nope' }, deps({ secretPrompt: 'x' }))).rejects.toThrow(
      /No model server named nope\. Saved servers: locked\./
    );
  });
});

describe('--server routing', () => {
  it('ls --server needs the login first, then lists with the saved credential', async () => {
    const locked = await bearerOllama(TOKEN);
    open.push(locked);
    await writeServers([
      record({
        id: 'ccc',
        name: 'locked',
        auth: { type: 'bearer' },
        transport: { type: 'http', baseUrl: locked.baseUrl },
      }),
    ]);
    await expect(run('ls', { server: 'locked' })).rejects.toThrow(
      'locked needs credentials. Run: b4m models servers login locked'
    );
    secrets.ccc = TOKEN;
    expect(await run('ls', { server: 'locked' })).toBe(0);
    expect(output()).toContain('Ollama "locked" at');
    expect(output()).toContain('qwen2.5:0.5b');
    expect(locked.requests.every(request => request.path === '/api/version' || request.headers.authorization)).toBe(
      true
    );
  });

  it('a stale saved credential is refused with the login hint', async () => {
    const locked = await bearerOllama(TOKEN);
    open.push(locked);
    await writeServers([
      record({
        id: 'ccc',
        name: 'locked',
        auth: { type: 'bearer' },
        transport: { type: 'http', baseUrl: locked.baseUrl },
      }),
    ]);
    secrets.ccc = 'rotated-token-value-0000';
    await expect(run('ls', { server: 'locked' })).rejects.toThrow(
      /refused the saved credentials\. Run: b4m models servers login locked/
    );
  });

  it('ls --server on vLLM lists each model once with aliases, LoRA bases and context', async () => {
    const vllm = await startFakeVllm({ maxModelLen: 4096 });
    open.push(vllm);
    await writeServers([
      record({
        id: 'bbb',
        name: 'vllm',
        kind: 'openai-compatible',
        access: 'chat',
        transport: { type: 'http', baseUrl: vllm.baseUrl },
      }),
    ]);
    await run('ls', { server: 'vllm' });
    const text = output();
    expect(text).toMatch(/NAME\s+CONTEXT\s+NOTE/);
    expect(text).toMatch(/qwen-small\s+4096\s+also: qwen/);
    expect(text).toMatch(/sql-lora\s+4096\s+LoRA on qwen-small/);
    expect(text.match(/^qwen-small/gm)?.length).toBe(1);
  });

  it('use --server saves the server-scoped id, canonicalizing an alias, on vLLM and on Ollama', async () => {
    const vllm = await startFakeVllm();
    const ollama = await plainOllama();
    open.push(vllm, ollama);
    await writeServers([
      record({
        id: 'bbb',
        name: 'vllm',
        kind: 'openai-compatible',
        access: 'chat',
        transport: { type: 'http', baseUrl: vllm.baseUrl },
      }),
      record({ id: 'aaa', name: 'shared', transport: { type: 'http', baseUrl: ollama.baseUrl } }),
    ]);
    expect(await run('use', { server: 'vllm', name: 'qwen' })).toBe(0);
    expect(output()).toContain('qwen is another name for qwen-small on vllm; saving qwen-small.');
    expect(output()).toContain('Default model: qwen-small on vllm');
    expect(await run('use', { server: 'shared', name: 'qwen2.5:0.5b' })).toBe(0);
    expect(saved).toEqual([
      { defaultModel: 'local:srv-bbb:qwen-small', localDefaultModel: 'local:srv-bbb:qwen-small' },
      { defaultModel: 'local:srv-aaa:qwen2.5:0.5b', localDefaultModel: 'local:srv-aaa:qwen2.5:0.5b' },
    ]);
    expect(vllm.requests).toEqual([]);
  });

  it('use --server names the server and saves nothing when it does not serve the model', async () => {
    const vllm = await startFakeVllm();
    open.push(vllm);
    await writeServers([
      record({
        id: 'bbb',
        name: 'vllm',
        kind: 'openai-compatible',
        access: 'chat',
        transport: { type: 'http', baseUrl: vllm.baseUrl },
      }),
    ]);
    await expect(run('use', { server: 'vllm', name: 'llama3' })).rejects.toThrow(
      'No model named llama3 on vllm. See: b4m models ls --server vllm'
    );
    expect(saved).toEqual([]);
  });

  it('an empty --server is an error, not the local runtime', async () => {
    await expect(run('ls', { server: '' })).rejects.toThrow('--server needs a server name (see: b4m models servers)');
    await expect(run('ls', { server: '  ' })).rejects.toThrow('--server needs a server name');
  });

  it('pull --server is refused for a Chat only server and for vLLM, before anything is read', async () => {
    const ollama = await plainOllama();
    const vllm = await startFakeVllm();
    open.push(ollama, vllm);
    await writeServers([
      record({ id: 'aaa', name: 'chatty', access: 'chat', transport: { type: 'http', baseUrl: ollama.baseUrl } }),
      record({
        id: 'bbb',
        name: 'vllm',
        kind: 'openai-compatible',
        access: 'manage',
        transport: { type: 'http', baseUrl: vllm.baseUrl },
      }),
    ]);
    await expect(run('pull', { server: 'chatty', ref: 'smollm2:135m' })).rejects.toThrow(
      'chatty is set to Chat only in Desktop.'
    );
    await expect(run('pull', { server: 'vllm', ref: 'smollm2:135m' })).rejects.toThrow(/no pull or remove/);
    await expect(run('rm', { server: 'vllm', name: 'qwen-small', yes: true })).rejects.toThrow(/no pull or remove/);
    expect(ollama.requests).toEqual([]);
    expect(vllm.requests).toEqual([]);
  });

  it('rm --server removes on a manageable Ollama server', async () => {
    const removed = vi.fn();
    const ollama = await startFakeServer({
      'GET /api/version': json({ version: '0.12.0' }),
      'GET /api/tags': json(ollamaTags),
      'GET /api/ps': json({ models: [] }),
      'DELETE /api/delete': (request, response) => {
        removed(request.body);
        response.writeHead(200).end();
      },
    });
    open.push(ollama);
    await writeServers([record({ id: 'aaa', name: 'shared', transport: { type: 'http', baseUrl: ollama.baseUrl } })]);
    expect(await run('rm', { server: 'shared', name: 'qwen2.5:0.5b', yes: true })).toBe(0);
    expect(removed).toHaveBeenCalledOnce();
    expect(output()).toContain('Removed qwen2.5:0.5b.');
  });

  it('is rejected for subcommands that do not use a runtime', async () => {
    await expect(run('search', { server: 'x', query: 'q' })).rejects.toThrow(
      '--server works with ls, use, pull and rm.'
    );
  });
});

describe('credentials never reach output', () => {
  it('stays out of stdout and errors when the server echoes Authorization into error bodies', async () => {
    const echo =
      (status: number): Handler =>
      (request, response) => {
        response.writeHead(status, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ error: `bad request, saw ${request.headers.authorization}` }));
      };
    const server = await startFakeServer({
      'GET /api/version': json({ version: '0.12.0' }),
      'GET /api/tags': echo(500),
      'GET /api/ps': echo(400),
    });
    open.push(server);
    await writeServers([
      record({
        id: 'ccc',
        name: 'echo',
        auth: { type: 'bearer' },
        transport: { type: 'http', baseUrl: server.baseUrl },
      }),
    ]);
    secrets.ccc = TOKEN;
    const stderr = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    let failure = '';
    try {
      await run('ls', { server: 'echo' });
    } catch (error) {
      failure = error instanceof Error ? error.message : String(error);
    }
    await run('servers', {});
    await run('servers', { 'output-format': 'json' });
    const everything = [output(), failure, ...stderr.mock.calls.flat().map(String)].join('\n');
    stderr.mockRestore();
    expect(failure).not.toBe('');
    expect(everything).not.toContain(TOKEN);
    expect(server.requests.some(request => request.headers.authorization === `Bearer ${TOKEN}`)).toBe(true);
  });

  it('pull progress that echoes the token is scrubbed', async () => {
    const server = await startFakeServer({
      'GET /api/version': json({ version: '0.12.0' }),
      'GET /api/tags': json(ollamaTags),
      'GET /api/ps': json({ models: [] }),
      'POST /api/pull': (request, response) => {
        response.writeHead(200, { 'content-type': 'application/x-ndjson' });
        response.write(`${JSON.stringify({ status: `pulling, saw ${request.headers.authorization}` })}\n`);
        response.end(`${JSON.stringify({ status: 'success' })}\n`);
      },
    });
    open.push(server);
    await writeServers([
      record({
        id: 'ccc',
        name: 'echo',
        auth: { type: 'bearer' },
        transport: { type: 'http', baseUrl: server.baseUrl },
      }),
    ]);
    secrets.ccc = TOKEN;
    const d = deps({ pull: true, isTTY: false });
    await run('pull', { server: 'echo', ref: 'tiny:latest', yes: true, 'accept-license': true }, d);
    expect(server.requests.some(request => request.path === '/api/pull')).toBe(true);
    expect(output()).toContain('pulling, saw');
    expect(output()).not.toContain(TOKEN);
  });

  it('a wrong token typed at login is not echoed back in the refusal', async () => {
    const locked = await bearerOllama(TOKEN);
    open.push(locked);
    await writeServers([
      record({
        id: 'ccc',
        name: 'locked',
        auth: { type: 'bearer' },
        transport: { type: 'http', baseUrl: locked.baseUrl },
      }),
    ]);
    const typed = 'typed-secret-value-abcdef';
    let failure = '';
    try {
      await run('servers', { action: 'login', name: 'locked' }, deps({ secretPrompt: typed }));
    } catch (error) {
      failure = error instanceof Error ? error.message : String(error);
    }
    expect(failure).not.toContain(typed);
    expect(output()).not.toContain(typed);
  });
});

describe('readSecretOnTerminal', () => {
  it('returns the typed line and echoes nothing but the prompt', async () => {
    const input = new PassThrough();
    const written: string[] = [];
    const output = new PassThrough();
    output.on('data', chunk => written.push(String(chunk)));
    const answer = readSecretOnTerminal('Token: ', new AbortController().signal, { input, output });
    input.write('s3cret-value\n');
    expect(await answer).toBe('s3cret-value');
    expect(written.join('')).toContain('Token: ');
    expect(written.join('')).not.toContain('s3cret');
  });

  it('cancels when the input closes before a line is entered (Ctrl+D)', async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const answer = readSecretOnTerminal('Token: ', new AbortController().signal, { input, output });
    input.end();
    await expect(answer).rejects.toBeInstanceOf(CancelledError);
  });
});

describe('the saved file is read, not changed', () => {
  it('leaves Desktop model-servers.json untouched', async () => {
    const ollama = await plainOllama();
    open.push(ollama);
    await writeServers([record({ name: 'shared', transport: { type: 'http', baseUrl: ollama.baseUrl } })]);
    const before = await readFile(path.join(dir, 'model-servers.json'), 'utf8');
    await run('servers', {});
    expect(await readFile(path.join(dir, 'model-servers.json'), 'utf8')).toBe(before);
  });
});
