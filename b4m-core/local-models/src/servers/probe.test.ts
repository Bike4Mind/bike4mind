import { afterEach, describe, expect, it } from 'vitest';
import { startFakeVllm, type FakeVllm } from '../__test__/fakeVllm';
import { answersWithoutCredentials, probeServer } from './probe';

const fetchLike = (input: string, init?: RequestInit) => fetch(input, init);

let vllm: FakeVllm | undefined;
afterEach(async () => {
  await vllm?.close();
  vllm = undefined;
});

describe('probeServer', () => {
  it('identifies vLLM from owned_by and reads its version', async () => {
    vllm = await startFakeVllm();
    const outcome = await probeServer(fetchLike, vllm.baseUrl, 'gpu', Date.now);
    expect(outcome).toMatchObject({ kind: 'openai-compatible', product: 'vllm', version: '0.32.0', models: 3 });
  });

  it('identifies Ollama by /api/version', async () => {
    const fake = (input: string) =>
      Promise.resolve(
        input.endsWith('/api/version')
          ? Response.json({ version: '0.9.0' })
          : input.endsWith('/api/tags')
            ? Response.json({ models: [{}, {}] })
            : new Response(null, { status: 404 })
      );
    expect(await probeServer(fake, 'http://h', 'box', Date.now)).toMatchObject({
      kind: 'ollama',
      version: '0.9.0',
      models: 2,
    });
  });

  it('reports a credential demand and an unreachable server', async () => {
    const denied = () => Promise.resolve(new Response(null, { status: 401 }));
    expect(await probeServer(denied, 'http://h', 'box', Date.now)).toMatchObject({ kind: null, auth: true });
    const down = () => Promise.reject(new TypeError('fetch failed', { cause: { code: 'ECONNREFUSED' } }));
    expect((await probeServer(down, 'http://h', 'box', Date.now)).error).toBe(
      'Could not reach box: connection refused'
    );
  });

  it('reports a 403 as a refusal, not a credential demand', async () => {
    const forbidden = () => Promise.resolve(new Response(null, { status: 403 }));
    expect(await probeServer(forbidden, 'http://h', 'box', Date.now)).toMatchObject({
      kind: null,
      auth: false,
      forbidden: true,
      refused: true,
      error: 'box answered 403 Forbidden: the server or a proxy in front of it refused the request.',
    });
    const mixed = (input: string) =>
      Promise.resolve(new Response(null, { status: input.endsWith('/v1/models') ? 401 : 403 }));
    expect(await probeServer(mixed, 'http://h', 'box', Date.now)).toMatchObject({ auth: true, forbidden: false });
  });
});

describe('answersWithoutCredentials', () => {
  it('is true when the model list answers', async () => {
    vllm = await startFakeVllm();
    expect(await answersWithoutCredentials(fetchLike, vllm.baseUrl, 'openai-compatible')).toBe(true);
    expect(await answersWithoutCredentials(() => Promise.reject(new Error('x')), vllm.baseUrl, 'ollama')).toBe(false);
  });
});
