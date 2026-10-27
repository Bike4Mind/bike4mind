import { getEventListeners } from 'node:events';
import { chmod, mkdir, mkdtemp, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  LlamaServerBinaryError,
  LlamaServerExitError,
  LlamaServerStartError,
  LlamaServerVersionError,
  LocalRuntimeError,
  ModelIncompleteError,
  ModelNotFoundError,
} from './errors';
import type { HubGgufBuild, HubModelDetail, HuggingFaceHub } from './huggingface';
import {
  DEFAULT_LLAMA_SERVER_CONTEXT_SIZE,
  MIN_LLAMA_SERVER_BUILD,
  findLlamaServer,
  startLlamaServer,
  trackedLlamaServerCount,
  type LlamaServerExit,
  type LlamaServerProcess,
  type StartLlamaServerOptions,
} from './llamaServer';
import { LlamaServerRuntime, parseLlamaServerPullRef, type LlamaServerRuntimeOptions } from './llamaServerRuntime';
import { OpenAICompatibleRuntime } from './openaiCompatible';

const FIXTURE = fileURLToPath(new URL('./__test__/fakeLlamaServer.mjs', import.meta.url));
const GGUF_BYTES = Buffer.concat([Buffer.from('GGUF'), Buffer.alloc(60)]);
const FAKE_VERSION = '0.7.0-dev (build 11912, commit fake)';
// The fake runs under this Node, so the tests need no executable file and work on Windows too.
const BINARY = { binaryPath: process.execPath, binaryArgs: [FIXTURE] };

let root: string;
let modelPath: string;

async function writeExecutable(path: string, body: string): Promise<void> {
  await writeFile(path, `#!${process.execPath}\n${body}\n`);
  await chmod(path, 0o755);
}

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'llama-server-test-'));
  modelPath = join(root, 'tiny-Q4_K_M.gguf');
  await writeFile(modelPath, GGUF_BYTES);
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

function env(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return { PATH: process.env.PATH, ...extra };
}

function start(overrides: Partial<StartLlamaServerOptions> = {}, extra: Record<string, string> = {}) {
  return startLlamaServer({ ...BINARY, modelPath, startTimeoutMs: 10_000, env: env(extra), ...overrides });
}

function client(server: LlamaServerProcess): OpenAICompatibleRuntime {
  return new OpenAICompatibleRuntime({ baseUrl: server.baseUrl, apiKey: server.apiKey, product: 'llama-server' });
}

async function refused(port: number): Promise<boolean> {
  return fetch(`http://127.0.0.1:${port}/health`).then(
    () => false,
    () => true
  );
}

/** A listener that accepts any key and claims to serve any model, recording each Authorization header. */
function hostile(): Promise<{ server: Server; port: number; authorizations: (string | undefined)[] }> {
  const authorizations: (string | undefined)[] = [];
  const server = createServer((request, response) => {
    authorizations.push(request.headers.authorization);
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ status: 'ok', data: [{ id: 'tiny-Q4_K_M.gguf' }] }));
  });
  return new Promise(done => {
    server.listen(0, '127.0.0.1', () =>
      done({ server, port: (server.address() as { port: number }).port, authorizations })
    );
  });
}

const portIn = (lines: string[]) => Number(/port: (\d+)/.exec(lines.find(line => /port: \d+/.test(line)) ?? '')?.[1]);

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function recorded(path: string): Promise<{ args: string[]; names: string[]; apiKey: string }> {
  return readFile(path, 'utf8').then(text => JSON.parse(text) as { args: string[]; names: string[]; apiKey: string });
}

describe('findLlamaServer', () => {
  it('runs a configured binary through binaryArgs and reads its build', async () => {
    expect(
      await findLlamaServer({ path: BINARY.binaryPath, binaryArgs: BINARY.binaryArgs, env: { PATH: '' } })
    ).toEqual({ path: process.execPath, version: FAKE_VERSION, build: 11912 });
  });

  it('throws LlamaServerVersionError for a configured binary that is too old or names no build', async () => {
    const old = await findLlamaServer({ ...pathOf(BINARY), env: { FAKE_LLAMA_VERSION: '5499 (0123abc)' } }).catch(
      (caught: unknown) => caught
    );
    expect(old).toBeInstanceOf(LlamaServerVersionError);
    expect(old).toMatchObject({ found: 5499, required: MIN_LLAMA_SERVER_BUILD, path: process.execPath });
    const unnumbered = await findLlamaServer({ ...pathOf(BINARY), env: { FAKE_LLAMA_VERSION: 'dev' } }).catch(
      (caught: unknown) => caught
    );
    expect(unnumbered).toMatchObject({ name: 'LlamaServerVersionError', found: null });
    const oldest = await findLlamaServer({
      ...pathOf(BINARY),
      env: { FAKE_LLAMA_VERSION: `${MIN_LLAMA_SERVER_BUILD} (x)` },
    });
    expect(oldest?.build).toBe(MIN_LLAMA_SERVER_BUILD);
  });

  it.skipIf(process.platform !== 'linux')(
    'puts the binary directory on LD_LIBRARY_PATH when libllama.so is there',
    async () => {
      const print = "console.log('version: 5501 (' + (process.env.LD_LIBRARY_PATH ?? '') + ')')";
      const bundled = join(root, 'bundled');
      const bare = join(root, 'bare');
      await mkdir(bundled);
      await mkdir(bare);
      await writeExecutable(join(bundled, 'llama-server'), print);
      await writeExecutable(join(bare, 'llama-server'), print);
      await writeFile(join(bundled, 'libllama.so'), '');
      const found = await findLlamaServer({
        path: join(bundled, 'llama-server'),
        env: { LD_LIBRARY_PATH: '/opt/lib' },
      });
      expect(found?.version).toBe(`5501 (${bundled}:/opt/lib)`);
      expect((await findLlamaServer({ path: join(bundled, 'llama-server'), env: {} }))?.version).toBe(
        `5501 (${bundled})`
      );
      expect((await findLlamaServer({ path: join(bare, 'llama-server'), env: {} }))?.version).toBe('5501 ()');
    }
  );

  it('throws when a configured binary cannot run', async () => {
    await expect(findLlamaServer({ path: join(root, 'missing') })).rejects.toThrow(/is missing or not executable/);
    await expect(findLlamaServer({ path: process.execPath, binaryArgs: ['-e', 'console.log(1)'] })).rejects.toThrow(
      /is not llama-server/
    );
  });

  describe.skipIf(process.platform === 'win32')('on PATH', () => {
    let decoy: string;
    let old: string;
    let current: string;

    beforeAll(async () => {
      decoy = join(root, 'decoy');
      old = join(root, 'old');
      current = join(root, 'current');
      for (const dir of [decoy, old, current]) await mkdir(dir, { recursive: true });
      await writeExecutable(join(decoy, 'llama-server'), 'console.log("hello");');
      await writeExecutable(join(old, 'llama-server'), 'process.stderr.write("version: 4000 (abc)\\n");');
      await writeExecutable(join(current, 'llama-server'), `import(${JSON.stringify(FIXTURE)});`);
    });

    it('skips entries that are relative, not llama-server, or too old', async () => {
      const found = await findLlamaServer({
        env: { PATH: ['relative/bin', decoy, old, current].join(':') },
        platform: 'linux',
      });
      expect(found).toEqual({ path: join(current, 'llama-server'), version: FAKE_VERSION, build: 11912 });
    });

    it('throws the version error only when no entry qualifies, and null when none exists', async () => {
      await expect(findLlamaServer({ env: { PATH: [decoy, old].join(':') }, platform: 'linux' })).rejects.toMatchObject(
        {
          name: 'LlamaServerVersionError',
          found: 4000,
        }
      );
      expect(await findLlamaServer({ env: { PATH: root }, platform: 'linux' })).toBeNull();
    });
  });
});

function pathOf(binary: typeof BINARY) {
  return { path: binary.binaryPath, binaryArgs: binary.binaryArgs };
}

describe('startLlamaServer', () => {
  it('serves on loopback with a per-process key passed outside argv, then stops cleanly', async () => {
    const record = join(root, 'record.json');
    const server = await start(
      { threads: 3, gpuLayers: 0 },
      { FAKE_LLAMA_RECORD: record, FAKE_LLAMA_LOAD_MS: '400', LLAMA_ARG_HOST: '0.0.0.0', HF_TOKEN: 'hf_secret' }
    );
    try {
      const seen = await recorded(record);
      expect(seen.apiKey).toBe(server.apiKey);
      expect(seen.names).toEqual(['LLAMA_API_KEY']);
      expect(seen.args.join(' ')).not.toContain(server.apiKey);
      expect(seen.args).toEqual(
        expect.arrayContaining(['--host', '127.0.0.1', '--offline', '--no-webui', '--jinja', '--threads', '3'])
      );
      expect(seen.args[seen.args.indexOf('--n-gpu-layers') + 1]).toBe('0');
      expect(seen.args[seen.args.indexOf('--port') + 1]).toBe('0');
      expect(seen.args[seen.args.indexOf('--ctx-size') + 1]).toBe('16384');
      expect(server.contextSize).toBe(DEFAULT_LLAMA_SERVER_CONTEXT_SIZE);
      expect(server.port).toBeGreaterThan(0);
      expect(server.baseUrl).toBe(`http://127.0.0.1:${server.port}`);
      expect(server.model).toBe('tiny-Q4_K_M.gguf');
      expect(server.running).toBe(true);
      expect(server).not.toHaveProperty('runtime');
      expect((await client(server).list()).map(model => model.name)).toEqual(['tiny-Q4_K_M.gguf']);
      expect((await fetch(`${server.baseUrl}/v1/models`)).status).toBe(401);
      expect(server.log().some(line => line.includes('listening on'))).toBe(true);
    } finally {
      const exit = await server.stop();
      expect(exit).toEqual({ code: 0, signal: null, stopped: true });
    }
    expect(server.running).toBe(false);
    expect(await refused(server.port)).toBe(true);
  });

  it('reads the port from the line b5501 logs on binding, before the model loads', async () => {
    const server = await start({}, { FAKE_LLAMA_LOG: 'b5501', FAKE_LLAMA_LOAD_MS: '300' });
    expect(server.port).toBe(portIn(server.log()));
    expect((await client(server).list()).map(model => model.name)).toEqual(['tiny-Q4_K_M.gguf']);
    await server.stop();
  });

  it('fails on a fixed port another listener holds, without sending it the key', async () => {
    const taken = await hostile();
    try {
      const error = await start({ port: taken.port }).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(LlamaServerExitError);
      expect(error).toMatchObject({
        portInUse: true,
        code: 1,
        message: expect.stringContaining(`port ${taken.port} is in use`),
      });
      expect(taken.authorizations).toEqual([]);
    } finally {
      taken.server.close();
    }
  });

  it('rejects with the last error line when the process exits during start', async () => {
    const error = await start({}, { FAKE_LLAMA_MODE: 'crash' }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(LlamaServerExitError);
    expect(error).toMatchObject({ portInUse: false, code: 1, runtimeId: 'llama-server' });
    expect((error as Error).message).toMatch(/exited before it was ready \(code 1\): .*error loading model/);
  });

  it('refuses a server that answers for a different model', async () => {
    await expect(start({}, { FAKE_LLAMA_MODE: 'wrong-model' })).rejects.toMatchObject({
      name: 'LlamaServerStartError',
      reason: 'wrong-server',
    });
  });

  it('accepts a public /v1/models as old builds have, since /props still needs the key', async () => {
    const server = await start({}, { FAKE_LLAMA_PUBLIC_MODELS: '1' });
    expect((await fetch(`${server.baseUrl}/v1/models`)).status).toBe(200);
    expect((await fetch(`${server.baseUrl}/props`)).status).toBe(401);
    await server.stop();
  });

  it('stops a server that answers without its key and fails closed', async () => {
    const lines: string[] = [];
    const error = await start(
      { onLog: line => lines.push(line) },
      { FAKE_LLAMA_NO_KEY: '1', FAKE_LLAMA_LOG: 'b5501' }
    ).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(LlamaServerStartError);
    expect(error).toMatchObject({ reason: 'unauthenticated', message: expect.stringContaining('(200)') });
    expect(await refused(portIn(lines))).toBe(true);
  });

  it.skipIf(process.platform === 'win32')('fails closed behind a launcher that drops the environment', async () => {
    const error = await start({ binaryPath: '/usr/bin/env', binaryArgs: ['-i', process.execPath, FIXTURE] }).catch(
      (caught: unknown) => caught
    );
    expect(error).toMatchObject({ name: 'LlamaServerStartError', reason: 'unauthenticated' });
  });

  it.skipIf(process.platform === 'win32')('stops the processes a launcher started along with it', async () => {
    const pidFile = join(root, 'grandchild.pid');
    const server = await start({}, { FAKE_LLAMA_GRANDCHILD: pidFile });
    const grandchild = Number(await readFile(pidFile, 'utf8'));
    expect(alive(grandchild)).toBe(true);
    await server.stop();
    for (let i = 0; i < 50 && alive(grandchild); i++) await new Promise(done => setTimeout(done, 20));
    expect(alive(grandchild)).toBe(false);
  });

  it('refuses a batch file and wraps a spawn that throws', async () => {
    await expect(start({ binaryPath: 'C:\\llama\\llama-server.CMD' })).rejects.toBeInstanceOf(LlamaServerBinaryError);
    await expect(findLlamaServer({ path: 'run.bat' })).rejects.toBeInstanceOf(LlamaServerBinaryError);
    const error = await start({ binaryPath: `${process.execPath}\0` }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(LlamaServerExitError);
    expect((error as Error).message).toMatch(/could not run/);
  });

  it('reports a crash after start through exited and onExit', async () => {
    const exits: LlamaServerExit[] = [];
    const server = await start({ onExit: exit => exits.push(exit) });
    process.kill(server.pid, 'SIGKILL');
    expect(await server.exited).toEqual({ code: null, signal: 'SIGKILL', stopped: false });
    expect(exits).toEqual([{ code: null, signal: 'SIGKILL', stopped: false }]);
    expect(server.running).toBe(false);
    expect((await client(server).health()).ok).toBe(false);
    expect(await server.stop()).toEqual(exits[0]);
  });

  it('kills a server that ignores SIGTERM after the stop timeout', async () => {
    const server = await start({ stopTimeoutMs: 300 }, { FAKE_LLAMA_MODE: 'ignore-term' });
    expect(await server.stop()).toEqual({ code: null, signal: 'SIGKILL', stopped: true });
  });

  it('stops the process and rejects with the reason when the start is aborted', async () => {
    const controller = new AbortController();
    const reason = new Error('user cancelled');
    const lines: string[] = [];
    const pending = start(
      { signal: controller.signal, onLog: line => lines.push(line) },
      { FAKE_LLAMA_LOAD_MS: '60000', FAKE_LLAMA_LOG: 'b5501' }
    );
    setTimeout(() => controller.abort(reason), 300);
    await expect(pending).rejects.toBe(reason);
    expect(await refused(portIn(lines))).toBe(true);
  });

  it('leaves no abort listener on a long-lived signal after it starts', async () => {
    const controller = new AbortController();
    const server = await start({ signal: controller.signal }, { FAKE_LLAMA_LOAD_MS: '400' });
    await server.stop();
    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);
  });

  it('gives up on a process that prints nothing for the start timeout, and waits for one still loading', async () => {
    await expect(start({ startTimeoutMs: 400 }, { FAKE_LLAMA_MODE: 'hang' })).rejects.toMatchObject({
      name: 'LlamaServerStartError',
      reason: 'timeout',
      message: 'llama-server printed nothing for 400ms while starting',
    });
    const server = await start({ startTimeoutMs: 400 }, { FAKE_LLAMA_LOAD_MS: '1500', FAKE_LLAMA_CHATTY: '1' });
    expect(server.running).toBe(true);
    await server.stop();
  });

  it('validates the model, alias and tuning before spawning', async () => {
    await expect(start({ modelPath: join(root, 'missing.gguf') })).rejects.toBeInstanceOf(ModelNotFoundError);
    await expect(start({ contextSize: -1 })).rejects.toBeInstanceOf(LocalRuntimeError);
    await expect(start({ gpuLayers: -1 })).rejects.toThrow('gpuLayers must be a non-negative integer');
    await expect(start({ alias: 'a,b' })).rejects.toThrow('cannot be a llama-server alias');
    const commaPath = join(root, 'tiny,Q4_K_M.gguf');
    await writeFile(commaPath, GGUF_BYTES);
    await expect(start({ modelPath: commaPath })).rejects.toThrow('cannot be a llama-server alias');
  });

  it('accepts only tuning flags in extraArgs, short or long, with values as separate arguments', async () => {
    const refusedFlags = [
      ['--host', '0.0.0.0'],
      ['--api-key=x'],
      ['-m', 'other.gguf'],
      ['-ag'],
      ['--tools', 'all'],
      ['--mcp-servers-config', 'x.json'],
      ['--webui-mcp-proxy'],
      ['--ui-mcp-proxy'],
      ['--reuse-port'],
      ['--api-prefix', '/x'],
      ['--path', '/'],
      ['--media-path', '/'],
      ['--ssl-key-file', 'k.pem'],
      ['--temp', '0.2', '--connect-code', 'x'],
      ['-hf', 'org/repo'],
      ['--mmproj-url', 'https://example.com/x.gguf'],
      // Current builds reject these, so they are not tuning flags here either.
      ['--no-mmap'],
      ['--mlock'],
    ];
    for (const extraArgs of refusedFlags) {
      await expect(start({ extraArgs })).rejects.toThrow(/extraArgs may not pass -/);
    }
    await expect(start({ extraArgs: ['--temp=0.2'] })).rejects.toThrow(
      'llama-server takes the value of --temp as a separate argument'
    );
    const record = join(root, 'record-tuning.json');
    const extraArgs = ['-fa', 'on', '--temp', '0.2', '-ctk', 'q8_0', '--n-predict', '-1', '--no-warmup', '-np', '2'];
    const server = await start({ extraArgs }, { FAKE_LLAMA_RECORD: record });
    await server.stop();
    expect((await recorded(record)).args.slice(-extraArgs.length)).toEqual(extraArgs);
  });

  it('reports a binary that cannot be spawned and forgets it', async () => {
    const before = trackedLlamaServerCount();
    const error = await start({ binaryPath: join(root, 'nope'), binaryArgs: [] }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(LlamaServerExitError);
    expect((error as Error).message).toMatch(/could not run .*nope/);
    expect(trackedLlamaServerCount()).toBe(before);
  });
});

function build(quant: string, path: string): HubGgufBuild {
  return {
    id: path.replace(/\.gguf$/, ''),
    quant,
    files: [{ path, sizeBytes: GGUF_BYTES.length, sha256: null, url: `https://hub.test/org/repo/resolve/abc/${path}` }],
    sizeBytes: GGUF_BYTES.length,
    split: false,
    complete: true,
    ollamaRef: null,
    ollamaRefIssue: null,
  };
}

function fakeHub(builds: HubGgufBuild[]) {
  const downloads: string[] = [];
  const hub: Pick<HuggingFaceHub, 'getModel' | 'download'> = {
    getModel: async repo => ({ id: repo, revision: 'abc', builds }) as unknown as HubModelDetail,
    download: async (file, destination) => {
      downloads.push(file.path);
      await writeFile(destination, GGUF_BYTES);
      return { path: destination, sizeBytes: GGUF_BYTES.length, sha256: null, resumedBytes: 0 };
    },
  };
  return { hub, downloads };
}

describe('LlamaServerRuntime', () => {
  function runtimeIn(
    dir: string,
    options: Partial<LlamaServerRuntimeOptions> = {},
    extra: Record<string, string> = {}
  ) {
    return new LlamaServerRuntime({ ...BINARY, modelsDir: join(root, dir), env: env(extra), ...options });
  }

  it('runs one server per model, stops it on remove, and refuses projectors', async () => {
    const runtime = runtimeIn('models', { contextSize: 2048 });
    await runtime.store.add(modelPath);
    await runtime.store.add(modelPath, { name: 'mmproj-tiny-F16.gguf' });

    const [first, second] = await Promise.all([runtime.start('tiny-Q4_K_M.gguf'), runtime.start('tiny-Q4_K_M.gguf')]);
    expect(second).toBe(first);
    expect(await runtime.running()).toEqual([first]);
    expect(await runtime.loaded()).toEqual([
      { name: 'tiny-Q4_K_M.gguf', sizeBytes: GGUF_BYTES.length, vramBytes: 0, contextLength: 2048, expiresAt: null },
    ]);
    await expect(runtime.start('mmproj-tiny-F16.gguf')).rejects.toThrow('is a vision projector');
    await expect(runtime.start('absent.gguf')).rejects.toBeInstanceOf(ModelNotFoundError);

    await runtime.remove('tiny-Q4_K_M.gguf');
    expect(first.running).toBe(false);
    expect((await runtime.store.list()).map(model => model.name)).toEqual(['mmproj-tiny-F16.gguf']);
    expect(await runtime.running()).toEqual([]);
    expect(await runtime.loaded()).toEqual([]);
  });

  it('starts a fresh server when start is called while a stop is in progress', async () => {
    const runtime = runtimeIn('models-restart', { stopTimeoutMs: 300 }, { FAKE_LLAMA_MODE: 'ignore-term' });
    await runtime.store.add(modelPath, { name: 'r.gguf' });
    const old = await runtime.start('r.gguf');
    const stopping = runtime.stop('r.gguf');
    const fresh = await runtime.start('r.gguf');
    await stopping;
    expect(fresh).not.toBe(old);
    expect(old.running).toBe(false);
    expect(fresh.running).toBe(true);
    expect(await runtime.running()).toEqual([fresh]);
    await runtime.stopAll();
  });

  it('starts a fresh server after a crash and stops everything on stopAll', async () => {
    const runtime = runtimeIn('models-crash');
    await runtime.store.add(modelPath, { name: 'a.gguf' });
    await runtime.store.add(modelPath, { name: 'b.gguf' });
    const crashed: LlamaServerProcess = await runtime.start('a.gguf');
    process.kill(crashed.pid, 'SIGKILL');
    await crashed.exited;
    const again = await runtime.start('a.gguf');
    expect(again).not.toBe(crashed);
    const other = await runtime.start('b.gguf');
    await runtime.stopAll();
    expect([again.running, other.running]).toEqual([false, false]);
    expect(await refused(again.port)).toBe(true);
  });

  it('cancels a start that is still loading when stopped, without running() waiting on it', async () => {
    const lines: string[] = [];
    const runtime = runtimeIn(
      'models-pending',
      { onLog: (_, line) => lines.push(line) },
      { FAKE_LLAMA_LOAD_MS: '60000', FAKE_LLAMA_LOG: 'b5501' }
    );
    await runtime.store.add(modelPath, { name: 'slow.gguf' });
    const pending = runtime.start('slow.gguf');
    const outcome = pending.catch((caught: unknown) => caught);
    while (!portIn(lines)) await new Promise(done => setTimeout(done, 20));
    const startedAt = Date.now();
    expect(await runtime.running()).toEqual([]);
    expect(await runtime.loaded()).toEqual([]);
    await runtime.stop('slow.gguf');
    expect(Date.now() - startedAt).toBeLessThan(5_000);
    expect(await outcome).toMatchObject({ message: 'slow.gguf was stopped before it was ready' });
    expect(await refused(portIn(lines))).toBe(true);
    const fresh = await runtimeIn('models-pending').start('slow.gguf');
    await fresh.stop();
  });

  it('lets each caller of a shared start abort alone, and cancels it once all have', async () => {
    const lines: string[] = [];
    const runtime = runtimeIn(
      'models-shared',
      { onLog: (_, line) => lines.push(line) },
      { FAKE_LLAMA_LOAD_MS: '800', FAKE_LLAMA_LOG: 'b5501' }
    );
    await runtime.store.add(modelPath, { name: 'shared.gguf' });
    const first = new AbortController();
    const exits: string[] = [];
    const leaving = runtime.start('shared.gguf', { signal: first.signal, onExit: () => exits.push('first') });
    const staying = runtime.start('shared.gguf', { onExit: () => exits.push('second') });
    const reason = new Error('first caller left');
    first.abort(reason);
    await expect(leaving).rejects.toBe(reason);
    const server = await staying;
    expect(server.running).toBe(true);
    await runtime.stop('shared.gguf');
    expect(exits).toEqual(['second']);

    lines.length = 0;
    const a = new AbortController();
    const b = new AbortController();
    const both = [a, b].map(controller =>
      runtime.start('shared.gguf', { signal: controller.signal }).catch((caught: unknown) => caught)
    );
    while (!portIn(lines)) await new Promise(done => setTimeout(done, 20));
    a.abort(new Error('a'));
    expect(await runtime.running()).toEqual([]);
    b.abort(new Error('b'));
    expect(await Promise.all(both)).toEqual([new Error('a'), new Error('b')]);
    for (let i = 0; i < 50 && !(await refused(portIn(lines))); i++) await new Promise(done => setTimeout(done, 20));
    expect(await refused(portIn(lines))).toBe(true);
  });

  it.skipIf(process.platform === 'win32')('keeps a healthy answer until the binary file changes', async () => {
    const binary = join(root, 'versioned-llama-server');
    const versionFile = join(root, 'version.txt');
    await writeFile(versionFile, '6000 (one)');
    await writeExecutable(
      binary,
      `process.stderr.write('version: ' + require('fs').readFileSync(${JSON.stringify(versionFile)}, 'utf8') + '\\n');`
    );
    const runtime = runtimeIn('models-health', { binaryPath: binary, binaryArgs: [] });
    expect((await runtime.health()).version).toBe('6000 (one)');
    await writeFile(versionFile, '6001 (two)');
    expect((await runtime.health()).version).toBe('6000 (one)');
    const later = new Date(Date.now() + 5_000);
    await utimes(binary, later, later);
    expect((await runtime.health()).version).toBe('6001 (two)');
  });

  it('is a LocalRuntime over the models directory', async () => {
    const runtime = runtimeIn('models-adapter');
    expect(runtime).toMatchObject({
      id: 'llama-server',
      kind: 'llama-server',
      baseUrl: pathToFileURL(join(root, 'models-adapter')).href,
      capabilities: { canPull: true, canRemove: true, canInspect: false, reportsLoaded: true },
    });
    expect(await runtime.health()).toEqual({ ok: true, version: FAKE_VERSION, error: null });
    expect(await runtimeIn('models-adapter', {}, { FAKE_LLAMA_VERSION: '5000 (abc)' }).health()).toEqual({
      ok: false,
      version: null,
      error: expect.stringContaining(`build ${MIN_LLAMA_SERVER_BUILD} or newer is required`),
    });
    expect((await runtimeIn('x', { binaryPath: join(root, 'nope') }).health()).ok).toBe(false);

    await runtime.store.add(modelPath, { name: 'chat-Q4_K_M.gguf' });
    await runtime.store.add(modelPath, { name: 'mmproj-chat-F16.gguf' });
    await runtime.store.add(modelPath, { name: 'big-00001-of-00002.gguf' });
    expect((await runtime.list()).map(model => model.name)).toEqual(['chat-Q4_K_M.gguf']);
    expect(await runtime.list()).toEqual([expect.not.objectContaining({ path: expect.anything() })]);
    expect(await runtime.inspect('chat-Q4_K_M.gguf')).toMatchObject({
      model: { name: 'chat-Q4_K_M.gguf', quantization: 'Q4_K_M' },
      arch: null,
      tensorStats: null,
    });
    await expect(runtime.inspect('mmproj-chat-F16.gguf')).rejects.toBeInstanceOf(ModelNotFoundError);
    const incomplete = await runtime.start('big-00001-of-00002.gguf').catch((caught: unknown) => caught);
    expect(incomplete).toBeInstanceOf(ModelIncompleteError);
    expect(incomplete).toMatchObject({ missing: ['big-00002-of-00002.gguf'] });
  });

  it('pulls the Hugging Face build whose quant matches the ref', async () => {
    const { hub, downloads } = fakeHub([build('Q2_K', 'm-Q2_K.gguf'), build('Q4_K_M', 'm-Q4_K_M.gguf')]);
    const runtime = runtimeIn('models-pull', { hub });
    await runtime.pull('hf.co/org/repo:q4_k_m');
    expect(downloads).toEqual(['m-Q4_K_M.gguf']);
    await runtime.pull('org/repo');
    expect(downloads).toEqual(['m-Q4_K_M.gguf']);
    expect((await runtime.list()).map(model => model.name)).toEqual(['org/repo/m-Q4_K_M.gguf']);
    expect((await runtime.store.get('org/repo/m-Q4_K_M.gguf')).source).toEqual({
      repo: 'org/repo',
      revision: 'abc',
      sha256: null,
      sizeBytes: GGUF_BYTES.length,
    });
    const missing = await runtime.pull('hf.co/org/repo:Q8_0').catch((caught: unknown) => caught);
    expect(missing).toBeInstanceOf(ModelNotFoundError);
    expect((missing as Error).cause).toMatchObject({ message: 'org/repo offers Q2_K, Q4_K_M' });
    await expect(runtime.pull('not a ref')).rejects.toThrow('is not a Hugging Face model ref');
  });

  it('parses pull refs', () => {
    expect(parseLlamaServerPullRef('hf.co/org/repo:Q5_K_M')).toEqual({ repo: 'org/repo', quant: 'Q5_K_M' });
    expect(parseLlamaServerPullRef('huggingface.co/org/repo')).toEqual({ repo: 'org/repo', quant: 'Q4_K_M' });
    expect(parseLlamaServerPullRef('org/repo:latest')).toEqual({ repo: 'org/repo', quant: 'Q4_K_M' });
    expect(() => parseLlamaServerPullRef('hf.co/org')).toThrow(LocalRuntimeError);
    expect(() => parseLlamaServerPullRef('hf.co/org/repo:a:b')).toThrow(LocalRuntimeError);
  });
});
