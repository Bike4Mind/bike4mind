import { mkdtemp, rm } from 'node:fs/promises';
import http from 'node:http';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
let fetchMock: ReturnType<typeof ollamaFetch>;
const ttyDescriptor = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');

beforeEach(async () => {
  home = await mkdtemp(path.join(os.tmpdir(), 'b4m-headless-signed-out-'));
  vi.stubEnv('HOME', home);
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
  const record =
    (scheme: string) =>
    (...args: unknown[]): never => {
      nodeRequests.push(`${scheme}:${String(args[0])}`);
      throw new Error('network is off in this test');
    };
  vi.spyOn(http, 'request').mockImplementation(record('http'));
  vi.spyOn(https, 'request').mockImplementation(record('https'));
});

afterEach(async () => {
  if (ttyDescriptor) Object.defineProperty(process.stdin, 'isTTY', ttyDescriptor);
  else delete (process.stdin as { isTTY?: boolean }).isTTY;
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  await rm(home, { recursive: true, force: true });
});

async function runSignedOut(config: { defaultModel: string; localDefaultModel?: string }, models: string[] | null) {
  await new ConfigStore().save(config);
  fetchMock = models
    ? ollamaFetch(models)
    : vi.fn(async () => {
        throw new TypeError('fetch failed');
      });
  vi.stubGlobal('fetch', fetchMock);
  await handleHeadlessCommand({
    prompt: 'say hello',
    outputFormat: 'json',
    dangerouslySkipPermissions: false,
    verbose: false,
    addDirs: [],
  });
  const urls = fetchMock.mock.calls.map(([request]) => String(request instanceof Request ? request.url : request));
  expect(urls.filter(url => !url.startsWith(`${OLLAMA}/`))).toEqual([]);
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

  it('says how to start or install Ollama, or sign in, when no local model answers', async () => {
    const output = await runSignedOut({ defaultModel: LOCAL_MODEL, localDefaultModel: LOCAL_MODEL }, null);

    expect(output.error).toContain('No local model found. Start Ollama');
    expect(output.error).toContain('ollama pull qwen3.5');
    expect(output.error).toContain('sign in: run b4m, then /login');
    expect(exitCodes).toEqual([1]);
  }, 30_000);
});
