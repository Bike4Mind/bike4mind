import { getEventListeners } from 'node:events';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  LlamaServerExitError,
  LlamaServerVersionError,
  LocalRuntimeError,
  ModelNotFoundError,
  RuntimeProtocolError,
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

function occupy(): Promise<Server> {
  return new Promise(done => {
    const server = createServer();
    server.listen(0, '127.0.0.1', () => done(server));
  });
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
      expect(seen.args[seen.args.indexOf('--ctx-size') + 1]).toBe(String(DEFAULT_LLAMA_SERVER_CONTEXT_SIZE));
      expect(server.contextSize).toBe(DEFAULT_LLAMA_SERVER_CONTEXT_SIZE);
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

  it('picks another port when the free one is taken before the server binds it', async () => {
    const counter = join(root, 'bind-fails');
    await writeFile(counter, '2');
    const lines: string[] = [];
    const server = await start({ onLog: line => lines.push(line) }, { FAKE_LLAMA_BIND_FAILS: counter });
    await server.stop();
    expect(lines.filter(line => line.includes("couldn't bind"))).toHaveLength(2);
    expect(await readFile(counter, 'utf8')).toBe('0');
  });

  it('reports a fixed port in use without retrying', async () => {
    const taken = await occupy();
    const port = (taken.address() as { port: number }).port;
    try {
      const error = await start({ port }).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(LlamaServerExitError);
      expect(error).toMatchObject({
        portInUse: true,
        code: 1,
        message: expect.stringContaining(`port ${port} is in use`),
      });
    } finally {
      taken.close();
    }
  });

  it('rejects with the last error line when the process exits during start', async () => {
    const error = await start({}, { FAKE_LLAMA_MODE: 'crash' }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(LlamaServerExitError);
    expect(error).toMatchObject({ portInUse: false, code: 1, runtimeId: 'llama-server' });
    expect((error as Error).message).toMatch(/exited before it was ready \(code 1\): .*error loading model/);
  });

  it('refuses a port that answers for a different server', async () => {
    await expect(start({}, { FAKE_LLAMA_MODE: 'wrong-model' })).rejects.toBeInstanceOf(RuntimeProtocolError);
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
      { FAKE_LLAMA_LOAD_MS: '60000' }
    );
    setTimeout(() => controller.abort(reason), 300);
    await expect(pending).rejects.toBe(reason);
    const port = Number(/:(\d+)$/.exec(lines.find(line => line.includes('listening on')) ?? '')?.[1]);
    expect(await refused(port)).toBe(true);
  });

  it('leaves no abort listener on a long-lived signal after it starts', async () => {
    const controller = new AbortController();
    const server = await start({ signal: controller.signal }, { FAKE_LLAMA_LOAD_MS: '400' });
    await server.stop();
    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);
  });

  it('gives up after the start timeout', async () => {
    await expect(start({ startTimeoutMs: 400 }, { FAKE_LLAMA_MODE: 'hang' })).rejects.toThrow(
      'llama-server did not become ready within 400ms'
    );
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
    ];
    for (const extraArgs of refusedFlags) {
      await expect(start({ extraArgs })).rejects.toThrow(/extraArgs may not pass -/);
    }
    await expect(start({ extraArgs: ['--temp=0.2'] })).rejects.toThrow(
      'llama-server takes the value of --temp as a separate argument'
    );
    const record = join(root, 'record-tuning.json');
    const extraArgs = ['-fa', 'on', '--temp', '0.2', '-ctk', 'q8_0', '--n-predict', '-1', '--no-mmap', '-np', '2'];
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
    getModel: async repo => ({ id: repo, builds }) as unknown as HubModelDetail,
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
      { FAKE_LLAMA_LOAD_MS: '60000' }
    );
    await runtime.store.add(modelPath, { name: 'slow.gguf' });
    const pending = runtime.start('slow.gguf');
    const outcome = pending.catch((caught: unknown) => caught);
    while (!lines.some(line => line.includes('listening on'))) await new Promise(done => setTimeout(done, 20));
    const startedAt = Date.now();
    expect(await runtime.running()).toEqual([]);
    expect(await runtime.loaded()).toEqual([]);
    await runtime.stop('slow.gguf');
    expect(Date.now() - startedAt).toBeLessThan(5_000);
    expect(await outcome).toMatchObject({ message: 'slow.gguf was stopped before it was ready' });
    const port = Number(/:(\d+)$/.exec(lines.find(line => line.includes('listening on')) ?? '')?.[1]);
    expect(await refused(port)).toBe(true);
    const fresh = await runtimeIn('models-pending').start('slow.gguf');
    await fresh.stop();
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
  });

  it('pulls the Hugging Face build whose quant matches the ref', async () => {
    const { hub, downloads } = fakeHub([build('Q2_K', 'm-Q2_K.gguf'), build('Q4_K_M', 'm-Q4_K_M.gguf')]);
    const runtime = runtimeIn('models-pull', { hub });
    await runtime.pull('hf.co/org/repo:q4_k_m');
    expect(downloads).toEqual(['m-Q4_K_M.gguf']);
    await runtime.pull('org/repo');
    expect(downloads).toEqual(['m-Q4_K_M.gguf']);
    expect((await runtime.list()).map(model => model.name)).toEqual(['m-Q4_K_M.gguf']);
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
