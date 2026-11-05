import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { startFakeServer, startFakeVllm } from '@bike4mind/local-models/testing';
import { signedOutHeadlessCloudModelMessage } from '../bootstrap/signedOutLocal.js';
import { ConfigStore } from '../storage/ConfigStore.js';
import { handleHeadlessCommand } from './headlessCommand.js';

const OLLAMA = 'http://127.0.0.1:11434';
const LOCAL_MODEL = 'qwen3.5:4b';
const CLOUD_MODEL = 'claude-opus-4';

const json = (body: unknown) =>
  new Response(`${JSON.stringify(body)}\n`, { status: 200, headers: { 'content-type': 'application/json' } });

/** An Ollama on the default loopback address that nobody configured. */
function ollamaFetch(models: string[]) {
  return vi.fn(async (input: string | URL | Request) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.origin !== OLLAMA) throw new TypeError(`fetch failed: ${url.origin} is off in this test`);
    switch (url.pathname) {
      case '/api/version':
        return json({ version: '0.12.0' });
      case '/api/tags':
        return json({ models: models.map(name => ({ name, model: name, size: 1, digest: 'd', details: {} })) });
      case '/api/show':
        return json({ capabilities: ['completion'], model_info: { 'qwen3.context_length': 32768 } });
      case '/api/chat':
        return json({
          model: LOCAL_MODEL,
          created_at: new Date(0).toISOString(),
          message: { role: 'assistant', content: 'hello from ollama' },
          done: true,
          done_reason: 'stop',
          prompt_eval_count: 3,
          eval_count: 4,
        });
      default:
        return new Response('not found', { status: 404 });
    }
  });
}

let home: string;
let stdout: string;
let stderr: string;
let exitCodes: (string | number | null | undefined)[];
let nodeRequests: string[];
let passThrough: string[];
let fetchMock: ReturnType<typeof ollamaFetch>;
const ttyDescriptor = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');
const realFetch = globalThis.fetch;

beforeEach(async () => {
  home = await mkdtemp(path.join(os.tmpdir(), 'b4m-headless-signed-out-'));
  vi.stubEnv('HOME', home);
  vi.stubEnv('B4M_DESKTOP_USER_DATA', home);
  vi.stubEnv('B4M_OLLAMA_HOST', '');
  vi.stubEnv('B4M_ADDITIONAL_DIRS', '');
  Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
  stdout = '';
  stderr = '';
  exitCodes = [];
  nodeRequests = [];
  vi.spyOn(process.stdout, 'write').mockImplementation(chunk => {
    stdout += String(chunk);
    return true;
  });
  vi.spyOn(process.stderr, 'write').mockImplementation(chunk => {
    stderr += String(chunk);
    return true;
  });
  vi.spyOn(process, 'exit').mockImplementation(code => {
    exitCodes.push(code);
    return undefined as never;
  });
  passThrough = [];
  const realHttpRequest = http.request;
  vi.spyOn(http, 'request').mockImplementation(((...args: Parameters<typeof http.request>) => {
    const url = String(args[0]);
    if (passThrough.some(origin => url.startsWith(`${origin}/`))) return realHttpRequest(...args);
    nodeRequests.push(`http:${url}`);
    throw new Error('network is off in this test');
  }) as typeof http.request);
  vi.spyOn(https, 'request').mockImplementation((...args: unknown[]): never => {
    nodeRequests.push(`https:${String(args[0])}`);
    throw new Error('network is off in this test');
  });
});

afterEach(async () => {
  if (ttyDescriptor) Object.defineProperty(process.stdin, 'isTTY', ttyDescriptor);
  else delete (process.stdin as { isTTY?: boolean }).isTTY;
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  await rm(home, { recursive: true, force: true });
});

/** Saves one model server, id s1 named box, the way Desktop does. */
async function saveServer(baseUrl: string): Promise<void> {
  const server = {
    id: 's1',
    name: 'box',
    kind: 'openai-compatible',
    transport: { type: 'http', baseUrl },
    access: 'chat',
    auth: { type: 'none' },
    models: [],
    addedAt: '2026-10-01T00:00:00.000Z',
  };
  await writeFile(path.join(home, 'model-servers.json'), JSON.stringify({ version: 1, servers: [server] }));
}

/** `models` null means no Ollama answers; `local` origins (fake model servers) reach the real network. */
async function runSignedOut(
  config: { defaultModel: string; localDefaultModel?: string },
  models: string[] | null,
  local: string[] = []
) {
  passThrough = local;
  await new ConfigStore().save(config);
  const ollama = models
    ? ollamaFetch(models)
    : vi.fn(async () => {
        throw new TypeError('fetch failed');
      });
  fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    return passThrough.some(origin => url.startsWith(`${origin}/`)) ? realFetch(input, init) : ollama(input);
  }) as unknown as typeof fetchMock;
  vi.stubGlobal('fetch', fetchMock);
  await handleHeadlessCommand({
    prompt: 'say hello',
    outputFormat: 'json',
    dangerouslySkipPermissions: false,
    verbose: false,
    addDirs: [],
  });
  const urls = fetchMock.mock.calls.map(([request]) => String(request instanceof Request ? request.url : request));
  const allowed = [OLLAMA, ...local];
  expect(urls.filter(url => !allowed.some(origin => url.startsWith(`${origin}/`)))).toEqual([]);
  expect(nodeRequests).toEqual([]);
  return JSON.parse(stdout) as { result?: string; error?: string };
}

describe('b4m -p while signed out', () => {
  it('answers on the saved local model without reaching Bike4Mind', async () => {
    const output = await runSignedOut({ defaultModel: CLOUD_MODEL, localDefaultModel: LOCAL_MODEL }, [LOCAL_MODEL]);

    expect(output.error).toBeUndefined();
    expect(output.result).toContain('hello from ollama');
    expect(exitCodes).toEqual([0]);
    expect(stderr).toContain(`using the saved local model "${LOCAL_MODEL}" instead of "${CLOUD_MODEL}"`);
    expect(fetchMock.mock.calls.some(([request]) => String(request).endsWith('/api/chat'))).toBe(true);
  }, 30_000);

  it('says how to sign in when the default is a cloud model', async () => {
    const output = await runSignedOut({ defaultModel: CLOUD_MODEL }, [LOCAL_MODEL]);

    expect(output.error).toBe(signedOutHeadlessCloudModelMessage(CLOUD_MODEL));
    expect(exitCodes).toEqual([1]);
  }, 30_000);

  it.each([
    ['Ollama is not running', null],
    ['Ollama has other models', [LOCAL_MODEL]],
  ])(
    'answers on a saved local default on a saved model server when %s',
    async (_case, ollamaModels) => {
      const vllm = await startFakeVllm();
      try {
        await saveServer(vllm.baseUrl);

        const output = await runSignedOut(
          { defaultModel: CLOUD_MODEL, localDefaultModel: 'local:srv-s1:qwen-small' },
          ollamaModels,
          [vllm.baseUrl]
        );

        expect(output.error).toBeUndefined();
        expect(output.result).toContain('Hello.');
        expect(exitCodes).toEqual([0]);
        expect(vllm.requests.map(request => request.model)).toEqual(['qwen-small']);
      } finally {
        await vllm.close();
      }
    },
    30_000
  );

  it.each([
    ['Ollama is not running', null],
    ['Ollama has other models', [LOCAL_MODEL]],
  ])(
    'names the saved model server holding the saved local default when it does not answer and %s',
    async (_case, ollamaModels) => {
      const gone = await startFakeServer({});
      await gone.close();
      await saveServer(gone.baseUrl);

      const output = await runSignedOut(
        { defaultModel: CLOUD_MODEL, localDefaultModel: 'local:srv-s1:qwen-small' },
        ollamaModels,
        [gone.baseUrl]
      );

      expect(output.error).toMatch(
        /^The saved local default qwen-small is on the model server box, which did not answer: .+\. Start it, or pick another model with: b4m models use <name>\./
      );
      expect(output.error).not.toContain('Start Ollama');
      expect(exitCodes).toEqual([1]);
    },
    30_000
  );

  it('says how to start or install Ollama, or sign in, when no local model answers', async () => {
    const output = await runSignedOut({ defaultModel: LOCAL_MODEL, localDefaultModel: LOCAL_MODEL }, null);

    expect(output.error).toContain('No local model found. Start Ollama');
    expect(output.error).toContain('ollama pull qwen3.5');
    expect(output.error).toContain('sign in: run b4m, then /login');
    expect(exitCodes).toEqual([1]);
  }, 30_000);
});
