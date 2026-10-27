import { inspect } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { detectRuntimes } from './detect';
import { LocalRuntimeError, RuntimeConnectionError, RuntimeHttpError } from './errors';
import { send } from './http';
import { OllamaRuntime } from './ollama';
import { OpenAICompatibleRuntime } from './openaiCompatible';
import { json, startFakeServer, type FakeServer } from './__test__/fakeServer';

let server: FakeServer | undefined;

afterEach(async () => {
  await server?.close();
  server = undefined;
});

const SECRET = 'sk-SECRET-KEY';
// fetch rejects CR, LF and NUL with an error quoting the whole header value, and anything past U+00FF.
const badKeys = [10, 13, 0, 0x2028].map(code => [code, `${SECRET}${String.fromCharCode(code)}tail`] as const);

describe('HTTP error bodies', () => {
  it.each([
    ['Ollama', { error: 'Invalid API key' }, 'Invalid API key'],
    ['OpenAI', { error: { message: 'Invalid API key' } }, 'Invalid API key'],
    ['FastAPI', { detail: 'Invalid API key' }, 'Invalid API key'],
    ['empty detail', { detail: '' }, ''],
    ['both formats', { error: 'Primary error', detail: 'Secondary error' }, 'Primary error'],
    ['invalid error with valid detail', { error: null, detail: 'Fallback error' }, 'Fallback error'],
    ['non-string detail', { detail: [{ msg: 'x' }] }, null],
    ['missing detail', {}, null],
    ['null body', null, null],
    ['array body', [{ detail: 'Invalid API key' }], null],
    ['non-JSON body', '<html>Unauthorized</html>', null],
  ])('preserves status and extracts only a supported message (%s)', async (_name, body, detail) => {
    const client = {
      runtimeId: 'test-runtime',
      baseUrl: 'http://runtime.test',
      fetch: async () => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status: 403 }),
    };
    const request = send(client, '/v1/models');
    await expect(request).rejects.toBeInstanceOf(RuntimeHttpError);
    await expect(request).rejects.toMatchObject({
      runtimeId: client.runtimeId,
      status: 403,
      detail,
      message: `test-runtime /v1/models returned HTTP 403${detail === null ? '' : `: ${detail}`}`,
    });
  });
});

function expectNoSecret(error: unknown): void {
  expect(error).toBeInstanceOf(LocalRuntimeError);
  expect(error).not.toBeInstanceOf(RuntimeConnectionError);
  expect((error as Error).message).toMatch(/authorization header contains a character HTTP does not allow/);
  expect((error as Error).message).not.toContain(SECRET);
  expect((error as Error).cause).toBeUndefined();
  expect(inspect(error, { depth: 10 })).not.toContain(SECRET);
}

describe('header values fetch would reject', () => {
  it.each(badKeys)('keep the API key out of errors (char %i)', async (_code, apiKey) => {
    server = await startFakeServer({ 'GET /api/tags': json({ models: [] }), 'GET /v1/models': json({ data: [] }) });
    const ollama = new OllamaRuntime({ baseUrl: server.baseUrl, apiKey });
    const openai = new OpenAICompatibleRuntime({ baseUrl: server.baseUrl, apiKey });
    for (const call of [() => ollama.list(), () => ollama.inspect('m'), () => openai.list()]) {
      expectNoSecret(await call().catch((error: unknown) => error));
    }
    for (const health of [await ollama.health(), await openai.health()]) {
      expect(health.ok).toBe(false);
      expect(health.error).not.toContain(SECRET);
    }
    const detected = await detectRuntimes({ hosts: [{ url: server.baseUrl, apiKey }], defaultHosts: [] });
    expect(inspect(detected, { depth: 10 })).not.toContain(SECRET);
    expect(server.requests).toEqual([]);
  });
});
