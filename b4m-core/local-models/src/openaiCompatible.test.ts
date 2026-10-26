import { afterEach, describe, expect, it } from 'vitest';
import { LocalRuntimeError, ModelNotFoundError, RuntimeUnsupportedError } from './errors';
import { OpenAICompatibleRuntime } from './openaiCompatible';
import { closedPort, json, sendJson, startFakeServer, type FakeServer } from './__test__/fakeServer';

let server: FakeServer | undefined;

afterEach(async () => {
  await server?.close();
  server = undefined;
});

// Shapes from the llama-server README (`GET /v1/models`) and LM Studio's REST docs (`GET /api/v0/models`).
const llamaServerModels = {
  object: 'list',
  data: [
    {
      id: '../models/Meta-Llama-3.1-8B-Instruct-Q4_K_M.gguf',
      object: 'model',
      created: 1735142223,
      owned_by: 'llamacpp',
      meta: {
        vocab_type: 2,
        n_vocab: 128256,
        n_ctx_train: 131072,
        n_embd: 4096,
        n_params: 8030261312,
        size: 4912898304,
      },
    },
  ],
};

const lmStudioV0Models = {
  object: 'list',
  data: [
    {
      id: 'qwen2-vl-7b-instruct',
      object: 'model',
      type: 'vlm',
      publisher: 'mlx-community',
      arch: 'qwen2_vl',
      compatibility_type: 'mlx',
      quantization: '4bit',
      state: 'not-loaded',
      max_context_length: 32768,
    },
    {
      id: 'meta-llama-3.1-8b-instruct',
      object: 'model',
      type: 'llm',
      publisher: 'lmstudio-community',
      arch: 'llama',
      compatibility_type: 'gguf',
      quantization: 'Q4_K_M',
      state: 'not-loaded',
      max_context_length: 131072,
    },
    {
      id: 'text-embedding-nomic-embed-text-v1.5',
      object: 'model',
      type: 'embeddings',
      publisher: 'nomic-ai',
      arch: 'nomic-bert',
      compatibility_type: 'gguf',
      quantization: 'Q4_0',
      state: 'not-loaded',
      max_context_length: 2048,
    },
  ],
};

const lmStudioV1Models = {
  object: 'list',
  data: lmStudioV0Models.data.map(model => ({ id: model.id, object: 'model', owned_by: 'organization_owner' })),
};

describe('OpenAICompatibleRuntime', () => {
  it('normalizes the base url and builds a host:port id', () => {
    const runtime = new OpenAICompatibleRuntime({ baseUrl: 'http://127.0.0.1:1234/v1/' });
    expect(runtime.baseUrl).toBe('http://127.0.0.1:1234');
    expect(runtime.id).toBe('openai-compatible:127.0.0.1:1234');
    expect(runtime.kind).toBe('openai-compatible');
    expect(runtime.capabilities).toEqual({ canPull: false, canRemove: false, canInspect: false, reportsLoaded: false });
  });

  it('lists /v1/models ids, taking llama-server meta.size when present', async () => {
    server = await startFakeServer({ 'GET /v1/models': json(llamaServerModels) });
    const models = await new OpenAICompatibleRuntime({ baseUrl: server.baseUrl }).list();
    expect(models).toEqual([
      {
        name: '../models/Meta-Llama-3.1-8B-Instruct-Q4_K_M.gguf',
        sizeBytes: 4912898304,
        quantization: null,
        family: null,
        parameterSize: null,
        modifiedAt: null,
        capabilities: { tools: false, vision: false, thinking: false, embeddings: false, completion: false },
      },
    ]);
  });

  it('skips malformed /v1/models entries', async () => {
    server = await startFakeServer({
      'GET /v1/models': json({ data: [{ id: 'a' }, { id: '' }, null, { name: 'b' }] }),
    });
    const models = await new OpenAICompatibleRuntime({ baseUrl: server.baseUrl }).list();
    expect(models.map(model => model.name)).toEqual(['a']);
  });

  it('uses LM Studio /api/v0/models for quantization, family and capabilities', async () => {
    server = await startFakeServer({
      'GET /api/v0/models': json(lmStudioV0Models),
      'GET /v1/models': json(lmStudioV1Models),
    });
    const models = await new OpenAICompatibleRuntime({ baseUrl: server.baseUrl, product: 'lmstudio' }).list();
    expect(models.map(model => [model.name, model.quantization, model.family])).toEqual([
      ['qwen2-vl-7b-instruct', '4bit', 'qwen2_vl'],
      ['meta-llama-3.1-8b-instruct', 'Q4_K_M', 'llama'],
      ['text-embedding-nomic-embed-text-v1.5', 'Q4_0', 'nomic-bert'],
    ]);
    expect(models[0]?.capabilities).toMatchObject({ completion: true, vision: true, embeddings: false });
    expect(models[1]?.capabilities).toMatchObject({ completion: true, vision: false });
    expect(models[2]?.capabilities).toMatchObject({ completion: false, embeddings: true });
    expect(server.requests.some(request => request.path === '/v1/models')).toBe(false);
  });

  it('falls back to /v1/models when the LM Studio endpoint is unavailable', async () => {
    server = await startFakeServer({ 'GET /v1/models': json(lmStudioV1Models) });
    const models = await new OpenAICompatibleRuntime({ baseUrl: server.baseUrl, product: 'lmstudio' }).list();
    expect(models).toHaveLength(3);
    expect(models[0]?.quantization).toBeNull();
  });

  it('inspects a listed model with arch null and rejects unknown ones', async () => {
    server = await startFakeServer({ 'GET /v1/models': json(llamaServerModels) });
    const runtime = new OpenAICompatibleRuntime({ baseUrl: server.baseUrl });
    const id = llamaServerModels.data[0]?.id ?? '';
    const result = await runtime.inspect(id);
    expect(result.arch).toBeNull();
    expect(result.model.name).toBe(id);
    await expect(runtime.inspect('missing')).rejects.toBeInstanceOf(ModelNotFoundError);
  });

  it('throws RuntimeUnsupportedError for pull, remove and loaded', async () => {
    const runtime = new OpenAICompatibleRuntime({ baseUrl: 'http://127.0.0.1:1' });
    await expect(runtime.pull('qwen3:8b')).rejects.toBeInstanceOf(RuntimeUnsupportedError);
    await expect(runtime.remove('qwen3:8b')).rejects.toBeInstanceOf(RuntimeUnsupportedError);
    await expect(runtime.loaded()).rejects.toMatchObject({ name: 'RuntimeUnsupportedError', operation: 'loaded' });
  });

  it('sends the API key as a bearer token and names auth failures in health', async () => {
    server = await startFakeServer({
      'GET /v1/models': (request, response) =>
        request.headers.authorization === 'Bearer sk-test'
          ? sendJson(response, llamaServerModels)
          : sendJson(response, { error: 'unauthorized' }, 401),
    });
    const keyed = new OpenAICompatibleRuntime({ baseUrl: server.baseUrl, apiKey: 'sk-test' });
    expect(await keyed.list()).toHaveLength(1);
    expect(await keyed.health()).toEqual({ ok: true, version: null, error: null });

    const anonymous = new OpenAICompatibleRuntime({ baseUrl: server.baseUrl });
    expect(await anonymous.health()).toEqual({ ok: false, version: null, error: 'Requires an API key' });
  });

  it('throws LocalRuntimeError for an unusable base url', () => {
    expect(() => new OpenAICompatibleRuntime({ baseUrl: 'not a url' })).toThrow(LocalRuntimeError);
  });

  it('reports health from /v1/models without throwing', async () => {
    server = await startFakeServer({ 'GET /v1/models': json(llamaServerModels) });
    expect(await new OpenAICompatibleRuntime({ baseUrl: server.baseUrl }).health()).toEqual({
      ok: true,
      version: null,
      error: null,
    });

    const port = await closedPort();
    expect(await new OpenAICompatibleRuntime({ baseUrl: `http://127.0.0.1:${port}` }).health()).toEqual({
      ok: false,
      version: null,
      error: 'connection refused',
    });
  });
});
