import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LlamaServerExitError, LocalRuntimeError, ModelNotFoundError, RuntimeProtocolError } from './errors';
import {
  DEFAULT_LLAMA_SERVER_CONTEXT_SIZE,
  LlamaServerRuntime,
  findLlamaServer,
  startLlamaServer,
  type LlamaServerExit,
  type LlamaServerProcess,
  type StartLlamaServerOptions,
} from './llamaServer';

const FIXTURE = fileURLToPath(new URL('./__test__/fakeLlamaServer.mjs', import.meta.url));
const GGUF_BYTES = Buffer.concat([Buffer.from('GGUF'), Buffer.alloc(60)]);

let root: string;
let binDir: string;
let binary: string;
let modelPath: string;

async function writeExecutable(path: string, body: string): Promise<void> {
  await writeFile(path, `#!${process.execPath}\n${body}\n`);
  await chmod(path, 0o755);
}

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'llama-server-test-'));
  binDir = join(root, 'bin');
  await mkdir(binDir);
  binary = join(binDir, 'llama-server');
  await writeExecutable(binary, `import(${JSON.stringify(FIXTURE)});`);
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
  return startLlamaServer({ binaryPath: binary, modelPath, startTimeoutMs: 10_000, env: env(extra), ...overrides });
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

describe('findLlamaServer', () => {
  it('finds the first llama-server on PATH that runs and reads its build', async () => {
    const decoy = join(root, 'decoy');
    await mkdir(decoy, { recursive: true });
    await writeExecutable(join(decoy, 'llama-server'), 'console.log("hello");');
    const found = await findLlamaServer({
      env: { PATH: ['relative/bin', decoy, binDir].join(':') },
      platform: 'linux',
    });
    expect(found).toEqual({ path: binary, version: '0.7.0-dev (build 11912, commit fake)', build: 11912 });
  });

  it('returns null when PATH has no llama-server', async () => {
    expect(await findLlamaServer({ env: { PATH: root }, platform: 'linux' })).toBeNull();
  });

  it('uses a configured path without searching PATH and throws when it cannot run', async () => {
    expect((await findLlamaServer({ path: binary, env: { PATH: '' } }))?.build).toBe(11912);
    await expect(findLlamaServer({ path: join(root, 'missing') })).rejects.toThrow(/is missing or not executable/);
    await expect(findLlamaServer({ path: join(root, 'decoy', 'llama-server') })).rejects.toThrow(/is not llama-server/);
  });
});

describe('startLlamaServer', () => {
  it('serves on loopback with a per-process key passed outside argv, then stops cleanly', async () => {
    const record = join(root, 'record.json');
    const server = await start(
      { threads: 3 },
      { FAKE_LLAMA_RECORD: record, FAKE_LLAMA_LOAD_MS: '400', LLAMA_ARG_HOST: '0.0.0.0', HF_TOKEN: 'hf_secret' }
    );
    try {
      const seen = JSON.parse(await readFile(record, 'utf8')) as { args: string[]; names: string[]; apiKey: string };
      expect(seen.apiKey).toBe(server.apiKey);
      expect(seen.names).toEqual(['LLAMA_API_KEY']);
      expect(seen.args.join(' ')).not.toContain(server.apiKey);
      expect(seen.args).toEqual(
        expect.arrayContaining(['--host', '127.0.0.1', '--offline', '--no-ui', '--jinja', '--threads', '3'])
      );
      expect(seen.args[seen.args.indexOf('--ctx-size') + 1]).toBe(String(DEFAULT_LLAMA_SERVER_CONTEXT_SIZE));
      expect(server.baseUrl).toBe(`http://127.0.0.1:${server.port}`);
      expect(server.model).toBe('tiny-Q4_K_M.gguf');
      expect(server.running).toBe(true);
      expect((await server.runtime.list()).map(model => model.name)).toEqual(['tiny-Q4_K_M.gguf']);
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
    expect((await server.runtime.health()).ok).toBe(false);
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

  it('gives up after the start timeout', async () => {
    await expect(start({ startTimeoutMs: 400 }, { FAKE_LLAMA_MODE: 'hang' })).rejects.toThrow(
      'llama-server did not become ready within 400ms'
    );
  });

  it('validates the model, tuning and extra flags before spawning', async () => {
    await expect(start({ modelPath: join(root, 'missing.gguf') })).rejects.toBeInstanceOf(ModelNotFoundError);
    await expect(start({ extraArgs: ['--host', '0.0.0.0'] })).rejects.toThrow('extraArgs may not set --host');
    await expect(start({ extraArgs: ['--api-key=x'] })).rejects.toThrow('extraArgs may not set --api-key');
    await expect(start({ contextSize: -1 })).rejects.toBeInstanceOf(LocalRuntimeError);
  });

  it('reports a binary that cannot be spawned', async () => {
    const error = await start({ binaryPath: join(root, 'nope') }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(LlamaServerExitError);
    expect((error as Error).message).toMatch(/could not run .*nope/);
  });
});

describe('LlamaServerRuntime', () => {
  it('runs one server per model, stops it on remove, and refuses projectors', async () => {
    const modelsDir = join(root, 'models');
    const runtime = new LlamaServerRuntime({ binaryPath: binary, modelsDir, env: env(), contextSize: 2048 });
    await runtime.store.add(modelPath);
    await runtime.store.add(modelPath, { name: 'mmproj-tiny-F16.gguf' });

    const [first, second] = await Promise.all([runtime.start('tiny-Q4_K_M.gguf'), runtime.start('tiny-Q4_K_M.gguf')]);
    expect(second).toBe(first);
    expect(await runtime.running()).toEqual([first]);
    await expect(runtime.start('mmproj-tiny-F16.gguf')).rejects.toThrow('is a vision projector');
    await expect(runtime.start('absent.gguf')).rejects.toBeInstanceOf(ModelNotFoundError);

    await runtime.remove('tiny-Q4_K_M.gguf');
    expect(first.running).toBe(false);
    expect((await runtime.store.list()).map(model => model.name)).toEqual(['mmproj-tiny-F16.gguf']);
    expect(await runtime.running()).toEqual([]);
  });

  it('starts a fresh server after a crash and stops everything on stopAll', async () => {
    const modelsDir = join(root, 'models-crash');
    const runtime = new LlamaServerRuntime({ binaryPath: binary, modelsDir, env: env() });
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
});
