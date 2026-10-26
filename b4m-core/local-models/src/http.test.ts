import { inspect } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { detectRuntimes } from './detect';
import { LocalRuntimeError, RuntimeConnectionError } from './errors';
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
