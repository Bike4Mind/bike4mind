import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LlamaServerExitError, LocalRuntimeError } from './errors';
import { startLlamaRouter, type StartLlamaRouterOptions } from './llamaServer';
import { LlamaServerRuntime, ROUTER_LOG_NAME } from './llamaServerRuntime';
import { OpenAICompatibleRuntime } from './openaiCompatible';

const FIXTURE = fileURLToPath(new URL('./__test__/fakeLlamaServer.mjs', import.meta.url));
const BINARY = { binaryPath: process.execPath, binaryArgs: [FIXTURE] };
const GGUF_BYTES = Buffer.concat([Buffer.from('GGUF'), Buffer.alloc(60)]);

let root: string;
let modelsDir: string;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'llama-router-test-'));
  modelsDir = join(root, 'models');
  await mkdir(modelsDir);
  await writeFile(join(modelsDir, 'tiny-Q4_K_M.gguf'), GGUF_BYTES);
  await writeFile(join(modelsDir, 'other-Q8_0.gguf'), GGUF_BYTES);
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

function holder(): Promise<{ server: Server; port: number; authorizations: (string | undefined)[] }> {
  const authorizations: (string | undefined)[] = [];
  const server = createServer((request, response) => {
    authorizations.push(request.headers.authorization);
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ status: 'ok', role: 'router' }));
  });
  return new Promise(done => {
    server.listen(0, '127.0.0.1', () =>
      done({ server, port: (server.address() as { port: number }).port, authorizations })
    );
  });
}

async function start(overrides: Partial<StartLlamaRouterOptions> = {}, extra: Record<string, string> = {}) {
  return startLlamaRouter({
    ...BINARY,
    modelsDir,
    port: await freePort(),
    startTimeoutMs: 10_000,
    env: { PATH: process.env.PATH, ...extra },
    ...overrides,
  });
}

const recorded = (path: string) =>
  readFile(path, 'utf8').then(text => JSON.parse(text) as { args: string[]; names: string[]; apiKey: string });

describe('startLlamaRouter', () => {
  it('serves every model in the folder on its fixed port with a key kept out of argv', async () => {
    const record = join(root, 'record.json');
    const port = await freePort();
    const server = await start({ port, modelsMax: 2 }, { FAKE_LLAMA_RECORD: record, LLAMA_ARG_HOST: '0.0.0.0' });
    try {
      const seen = await recorded(record);
      expect(seen.names).toEqual(['LLAMA_API_KEY']);
      expect(seen.apiKey).toBe(server.apiKey);
      expect(seen.args.join(' ')).not.toContain(server.apiKey);
      expect(seen.args).toEqual(
        expect.arrayContaining(['--models-dir', modelsDir, '--host', '127.0.0.1', '--offline', '--no-webui', '--jinja'])
      );
      expect(seen.args[seen.args.indexOf('--port') + 1]).toBe(String(port));
      expect(seen.args[seen.args.indexOf('--models-max') + 1]).toBe('2');
      expect(seen.args).not.toContain('--model');
      expect(server.port).toBe(port);
      expect(server.baseUrl).toBe(`http://127.0.0.1:${port}`);
      expect(server.modelsDir).toBe(modelsDir);
      const client = new OpenAICompatibleRuntime({
        baseUrl: server.baseUrl,
        apiKey: server.apiKey,
        product: 'llama-server',
      });
      expect((await client.list()).map(model => model.name).sort()).toEqual(['other-Q8_0', 'tiny-Q4_K_M']);
      expect((await fetch(`${server.baseUrl}/v1/models`)).status).toBe(401);
    } finally {
      expect(await server.stop()).toEqual({ code: 0, signal: null, stopped: true });
    }
    expect(server.running).toBe(false);
  });

  it('fails on a port another listener holds, without sending it the key', async () => {
    const taken = await holder();
    try {
      const error = await start({ port: taken.port }).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(LlamaServerExitError);
      expect(error).toMatchObject({ portInUse: true });
      expect(taken.authorizations.filter(Boolean)).toEqual([]);
    } finally {
      taken.server.close();
    }
  });

  it('names a build without router mode', async () => {
    const error = await start({}, { FAKE_LLAMA_NO_ROUTER: '1' }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(LlamaServerExitError);
    expect((error as Error).message).toContain('has no router mode');
  });

  it('refuses a server that answers with its key but not as a router', async () => {
    await expect(start({}, { FAKE_LLAMA_NOT_ROUTER: '1' })).rejects.toMatchObject({
      name: 'LlamaServerStartError',
      reason: 'wrong-server',
    });
  });

  it('checks the folder, port and models-max before spawning', async () => {
    await expect(start({ modelsDir: join(root, 'absent') })).rejects.toThrow('is not a folder');
    await expect(start({ port: 70_000 })).rejects.toThrow(LocalRuntimeError);
    await expect(start({ modelsMax: -1 })).rejects.toThrow('modelsMax');
    await expect(start({ extraArgs: ['--model', 'x.gguf'] })).rejects.toThrow('may not pass --model');
  });
});

describe('LlamaServerRuntime.startRouter', () => {
  it("runs the runtime's binary over its models folder with the flash attention flag for its build", async () => {
    const record = join(root, 'record-runtime.json');
    const logs: string[] = [];
    const runtime = new LlamaServerRuntime({
      ...BINARY,
      modelsDir,
      env: { PATH: process.env.PATH, FAKE_LLAMA_RECORD: record, FAKE_LLAMA_VERSION: '7000 (abc)' },
      onLog: model => logs.push(model),
    });
    const port = await freePort();
    const router = await runtime.startRouter({ port, flashAttention: 'on' });
    try {
      const { args } = await recorded(record);
      expect(args.slice(args.indexOf('-fa'), args.indexOf('-fa') + 2)).toEqual(['-fa', 'on']);
      expect(args[args.indexOf('--models-dir') + 1]).toBe(modelsDir);
      expect(router.port).toBe(port);
      expect(logs.length).toBeGreaterThan(0);
      expect(new Set(logs)).toEqual(new Set([ROUTER_LOG_NAME]));
      expect(await runtime.running()).toEqual([]);
    } finally {
      await router.stop();
    }
  });
});
