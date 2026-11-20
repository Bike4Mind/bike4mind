import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  OllamaServeError,
  findOllamaBinary,
  ollamaLaunchEnv,
  startOllamaServe,
  type StartOllamaServeOptions,
} from './ollamaServe';
import { trackedChildCount } from './processTree';

const FIXTURE = fileURLToPath(new URL('./__test__/fakeOllama.mjs', import.meta.url));
// The fake runs under this Node, so the tests need no executable file.
const BINARY = { binaryPath: process.execPath, binaryArgs: [FIXTURE] };

let root: string;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'ollama-serve-test-'));
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

function freePort(): Promise<number> {
  return new Promise(done => {
    const server = createServer();
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as { port: number };
      server.close(() => done(port));
    });
  });
}

function holder(): Promise<{ server: Server; port: number }> {
  return new Promise(done => {
    const server = createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ version: '9.9.9' }));
    });
    server.listen(0, '127.0.0.1', () => done({ server, port: (server.address() as { port: number }).port }));
  });
}

async function start(overrides: Partial<StartOllamaServeOptions> = {}, extra: Record<string, string> = {}) {
  return startOllamaServe({
    ...BINARY,
    port: await freePort(),
    startTimeoutMs: 10_000,
    env: { PATH: process.env.PATH, ...extra },
    ...overrides,
  });
}

const refused = (port: number) =>
  fetch(`http://127.0.0.1:${port}/api/version`).then(
    () => false,
    () => true
  );

describe('ollamaLaunchEnv', () => {
  it('sets the cache type and turns flash attention on for a quantized one left unset', () => {
    expect(ollamaLaunchEnv({})).toEqual({});
    expect(ollamaLaunchEnv({ kvCacheType: 'q8_0' })).toEqual({
      OLLAMA_KV_CACHE_TYPE: 'q8_0',
      OLLAMA_FLASH_ATTENTION: '1',
    });
    expect(ollamaLaunchEnv({ kvCacheType: 'f16' })).toEqual({ OLLAMA_KV_CACHE_TYPE: 'f16' });
    expect(ollamaLaunchEnv({ kvCacheType: 'q4_0', flashAttention: false })).toEqual({
      OLLAMA_KV_CACHE_TYPE: 'q4_0',
      OLLAMA_FLASH_ATTENTION: '0',
    });
    expect(ollamaLaunchEnv({ flashAttention: true })).toEqual({ OLLAMA_FLASH_ATTENTION: '1' });
  });
});

describe('findOllamaBinary', () => {
  const only = (wanted: string[]) => async (file: string) => wanted.includes(file);

  it('takes the first absolute PATH entry with ollama, skipping relative ones', async () => {
    const found = await findOllamaBinary({
      platform: 'linux',
      path: 'bin:/opt/one:/opt/two',
      home: '/home/u',
      isExecutable: only(['bin/ollama', '/opt/two/ollama']),
    });
    expect(found).toBe('/opt/two/ollama');
  });

  it('falls back to where the macOS app and the Windows installer put it', async () => {
    const mac = '/Applications/Ollama.app/Contents/Resources/ollama';
    expect(
      await findOllamaBinary({ platform: 'darwin', path: '/usr/bin', home: '/Users/u', isExecutable: only([mac]) })
    ).toBe(mac);
    const windows = 'C:\\Users\\u\\AppData\\Local\\Programs\\Ollama\\ollama.exe';
    expect(
      await findOllamaBinary({
        platform: 'win32',
        path: 'C:\\Windows',
        env: { LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local' },
        home: 'C:\\Users\\u',
        isExecutable: only([windows]),
      })
    ).toBe(windows);
    expect(
      await findOllamaBinary({ platform: 'linux', path: '/usr/bin', home: '/h', isExecutable: only([]) })
    ).toBeNull();
  });
});

describe('startOllamaServe', () => {
  it('runs ollama serve on the port with its launch settings in place of inherited ones, then stops it', async () => {
    const record = join(root, 'record.json');
    const server = await start(
      { settings: { kvCacheType: 'q8_0' } },
      {
        FAKE_OLLAMA_RECORD: record,
        OLLAMA_HOST: '0.0.0.0:1',
        OLLAMA_KV_CACHE_TYPE: 'q4_0',
        OLLAMA_FLASH_ATTENTION: '0',
        OLLAMA_MODELS: '/models',
      }
    );
    try {
      const seen = JSON.parse(await readFile(record, 'utf8')) as { args: string[]; env: Record<string, string> };
      expect(seen.args).toEqual(['serve']);
      expect(seen.env).toEqual({
        OLLAMA_HOST: `127.0.0.1:${server.port}`,
        OLLAMA_KV_CACHE_TYPE: 'q8_0',
        OLLAMA_FLASH_ATTENTION: '1',
        OLLAMA_MODELS: '/models',
      });
      expect(server.launchEnv).toEqual({
        OLLAMA_HOST: `127.0.0.1:${server.port}`,
        OLLAMA_KV_CACHE_TYPE: 'q8_0',
        OLLAMA_FLASH_ATTENTION: '1',
      });
      expect(server.baseUrl).toBe(`http://127.0.0.1:${server.port}`);
      expect(server.running).toBe(true);
      expect(await (await fetch(`${server.baseUrl}/api/version`)).json()).toEqual({ version: '0.12.0' });
      expect(server.log().some(line => line.includes('Listening on'))).toBe(true);
    } finally {
      expect(await server.stop()).toEqual({ code: 0, signal: null, stopped: true });
    }
    expect(server.running).toBe(false);
    expect(await refused(server.port)).toBe(true);
  });

  it('gives a child none of the inherited launch variables when the settings set none', async () => {
    const record = join(root, 'record-unset.json');
    const server = await start(
      { settings: {} },
      { FAKE_OLLAMA_RECORD: record, OLLAMA_FLASH_ATTENTION: '0', OLLAMA_KV_CACHE_TYPE: 'q4_0' }
    );
    try {
      const seen = JSON.parse(await readFile(record, 'utf8')) as { env: Record<string, string> };
      expect(seen.env).toEqual({ OLLAMA_HOST: `127.0.0.1:${server.port}` });
    } finally {
      await server.stop();
    }
  });

  it('fails with portInUse when another server holds the port, never taking its answers as its own', async () => {
    const taken = await holder();
    try {
      const error = await start({ port: taken.port }).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(OllamaServeError);
      expect(error).toMatchObject({
        portInUse: true,
        message: expect.stringContaining(`port ${taken.port} is in use`),
      });
    } finally {
      taken.server.close();
    }
  });

  it('is not ready on an answer alone: a process that never logs its listener times out and is stopped', async () => {
    const pidFile = join(root, 'silent.pid');
    const error = await start(
      { startTimeoutMs: 800 },
      { FAKE_OLLAMA_MODE: 'silent', FAKE_OLLAMA_PID_FILE: pidFile }
    ).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(OllamaServeError);
    expect((error as Error).message).toMatch(
      /not ready within 800ms: it answers at 127\.0\.0\.1:\d+ but never logged "Listening on/
    );
    const pid = Number(await readFile(pidFile, 'utf8'));
    expect(() => process.kill(pid, 0)).toThrow();
  });

  it('rejects with the error line when it exits during start', async () => {
    const error = await start({}, { FAKE_OLLAMA_MODE: 'crash' }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(OllamaServeError);
    expect(error).toMatchObject({ portInUse: false });
    expect((error as Error).message).toMatch(/exited before it was ready \(code 1\): .*unable to initialize/);
  });

  it('stops the process when the start is aborted', async () => {
    const controller = new AbortController();
    const reason = new Error('cancelled');
    const pidFile = join(root, 'aborted.pid');
    const starting = start(
      { signal: controller.signal, startTimeoutMs: 10_000 },
      { FAKE_OLLAMA_MODE: 'silent', FAKE_OLLAMA_PID_FILE: pidFile }
    );
    await vi.waitFor(() => readFile(pidFile, 'utf8'), { timeout: 5_000 });
    controller.abort(reason);
    await expect(starting).rejects.toBe(reason);
    const pid = Number(await readFile(pidFile, 'utf8'));
    expect(() => process.kill(pid, 0)).toThrow();
  });

  it('stops the process when the start is aborted during its last readiness check', async () => {
    const controller = new AbortController();
    const reason = new Error('cancelled');
    const pidFile = join(root, 'aborted-ready.pid');
    const result = await start(
      {
        signal: controller.signal,
        fetch: async (input, init) => {
          const response = await fetch(input, init);
          controller.abort(reason);
          return response;
        },
      },
      { FAKE_OLLAMA_PID_FILE: pidFile }
    ).catch((caught: unknown) => caught);
    if (result && typeof result === 'object' && 'stop' in result) await (result as { stop(): Promise<unknown> }).stop();
    expect(result).toBe(reason);
    const pid = Number(await readFile(pidFile, 'utf8'));
    expect(() => process.kill(pid, 0)).toThrow();
  });

  it('reports an exit after start through exited and onExit, and kills one that ignores SIGTERM', async () => {
    const exits: unknown[] = [];
    const crashed = await start({ onExit: exit => exits.push(exit) });
    process.kill(crashed.pid, 'SIGKILL');
    expect(await crashed.exited).toEqual({ code: null, signal: 'SIGKILL', stopped: false });
    expect(exits).toEqual([{ code: null, signal: 'SIGKILL', stopped: false }]);

    const stubborn = await start({ stopTimeoutMs: 300 }, { FAKE_OLLAMA_MODE: 'ignore-term' });
    expect(await stubborn.stop()).toMatchObject({ signal: 'SIGKILL', stopped: true });
    expect(trackedChildCount()).toBe(0);
  });

  it('refuses a port out of range and reports a binary that cannot be spawned', async () => {
    await expect(startOllamaServe({ binaryPath: 'ollama', port: 0 })).rejects.toThrow('port must be');
    const error = await startOllamaServe({ binaryPath: join(root, 'absent'), port: await freePort() }).catch(
      (caught: unknown) => caught
    );
    expect(error).toBeInstanceOf(OllamaServeError);
    expect((error as Error).message).toMatch(/could not run .*absent/);
  });
});
