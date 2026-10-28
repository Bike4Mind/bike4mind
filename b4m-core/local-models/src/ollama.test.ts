import { afterEach, describe, expect, it } from 'vitest';
import {
  LocalRuntimeError,
  ModelNotFoundError,
  RuntimeConnectionError,
  RuntimeHttpError,
  RuntimeProtocolError,
} from './errors';
import { OllamaRuntime } from './ollama';
import type { PullProgress } from './types';
import { closedPort, delay, hang, json, sendJson, startFakeServer, type FakeServer } from './__test__/fakeServer';
import {
  cloudTag,
  fixtureTags,
  gemma4Show,
  legacyTags,
  liveArch,
  liveModelInfo,
  showFor,
  tags,
} from './__test__/ollamaFixtures';

let server: FakeServer | undefined;

afterEach(async () => {
  await server?.close();
  server = undefined;
});

const runtimeFor = (fake: FakeServer, options: { healthTimeoutMs?: number } = {}) =>
  new OllamaRuntime({ baseUrl: fake.baseUrl, ...options });

const ndjson = (lines: unknown[]) => lines.map(line => JSON.stringify(line)).join('\n') + '\n';

describe('OllamaRuntime identity', () => {
  it('uses the bare id for the default daemon and host:port otherwise', () => {
    expect(new OllamaRuntime().id).toBe('ollama');
    expect(new OllamaRuntime().baseUrl).toBe('http://127.0.0.1:11434');
    expect(new OllamaRuntime({ baseUrl: 'http://10.0.0.5:11500/' }).id).toBe('ollama:10.0.0.5:11500');
  });

  it('takes an explicit id over the address, so two servers at one address stay apart', async () => {
    server = await startFakeServer({ 'GET /api/tags': json({ models: null }) });
    const saved = new OllamaRuntime({ baseUrl: server.baseUrl, id: 'srv-a1b2c3' });
    const tunnelled = new OllamaRuntime({ baseUrl: server.baseUrl, id: 'srv-d4e5f6' });
    expect(saved.id).toBe('srv-a1b2c3');
    expect(tunnelled.id).toBe('srv-d4e5f6');
    expect(new OllamaRuntime({ id: 'srv-a1b2c3' }).id).toBe('srv-a1b2c3');
    const down = new OllamaRuntime({ baseUrl: `http://127.0.0.1:${await closedPort()}`, id: 'srv-a1b2c3' });
    await expect(down.list()).rejects.toMatchObject({ runtimeId: 'srv-a1b2c3' });
    expect(await saved.list()).toEqual([]);
  });

  it('refuses an unusable explicit id', () => {
    expect(() => new OllamaRuntime({ id: '' })).toThrow('Invalid ollama runtime id');
    expect(() => new OllamaRuntime({ id: 'srv a' })).toThrow(LocalRuntimeError);
    expect(() => new OllamaRuntime({ id: 'x'.repeat(129) })).toThrow(LocalRuntimeError);
  });

  it('canonicalizes localhost to 127.0.0.1', () => {
    const runtime = new OllamaRuntime({ baseUrl: 'localhost:11434' });
    expect(runtime.baseUrl).toBe('http://127.0.0.1:11434');
    expect(runtime.id).toBe('ollama');
  });

  it('refuses credentials in the base url without echoing them', () => {
    const create = () => new OllamaRuntime({ baseUrl: 'http://user:hunter2@10.0.0.5:11434' });
    expect(create).toThrow(LocalRuntimeError);
    expect(create).toThrow('ollama base URL must not contain credentials; pass apiKey instead');
    expect(create).not.toThrow(/hunter2/);
  });

  it('sends apiKey as a bearer token', async () => {
    server = await startFakeServer({
      'GET /api/tags': json({ models: [] }),
      'POST /api/pull': (_request, response) => response.end(ndjson([{ status: 'success' }])),
    });
    const runtime = new OllamaRuntime({ baseUrl: server.baseUrl, apiKey: 'sk-test' });
    await runtime.list();
    await runtime.pull('qwen3:8b');
    expect(server.requests.map(request => request.headers.authorization)).toEqual(['Bearer sk-test', 'Bearer sk-test']);
  });

  it('throws LocalRuntimeError for an unusable base url', () => {
    expect(() => new OllamaRuntime({ baseUrl: 'http://' })).toThrow(LocalRuntimeError);
    expect(() => new OllamaRuntime({ baseUrl: 'ftp://127.0.0.1:11434' })).toThrow('Invalid ollama base URL');
  });
});

describe('OllamaRuntime.list', () => {
  it('reads inline capabilities from /api/tags without calling /api/show, skipping cloud models', async () => {
    server = await startFakeServer({ 'GET /api/tags': json(tags) });
    const models = await runtimeFor(server).list();

    expect(models.map(model => model.name)).toEqual([
      'qwen3.6:35b-a3b-q4_K_M',
      'gemma4:26b-a4b-it-q4_K_M',
      'qwen3-embedding:0.6b',
    ]);
    expect(models[0]).toEqual({
      name: 'qwen3.6:35b-a3b-q4_K_M',
      sizeBytes: 23938333577,
      quantization: 'Q4_K_M',
      family: 'qwen35moe',
      parameterSize: '36.0B',
      modifiedAt: '2026-07-26T05:52:19.181062713Z',
      capabilities: { tools: true, vision: true, thinking: true, embeddings: false, completion: true },
    });
    expect(models[2]?.capabilities).toEqual({
      tools: false,
      vision: false,
      thinking: false,
      embeddings: true,
      completion: false,
    });
    expect(server.requests.some(request => request.path === '/api/show')).toBe(false);
  });

  it('falls back to /api/show per model on pre-0.30 daemons, at most four at a time', async () => {
    const extra = Array.from({ length: 6 }, (_, index) => ({ ...legacyTags.models[0], name: `filler:${index}` }));
    let inFlight = 0;
    let peak = 0;
    server = await startFakeServer({
      'GET /api/tags': json({ models: [...legacyTags.models, ...extra] }),
      'POST /api/show': async (request, response) => {
        inFlight++;
        peak = Math.max(peak, inFlight);
        await delay(20);
        inFlight--;
        const { model } = JSON.parse(request.body) as { model: string };
        if (model === fixtureTags.qwen3Embedding.name) return sendJson(response, { error: 'boom' }, 500);
        if (model === fixtureTags.gemma4.name) return sendJson(response, gemma4Show);
        return sendJson(response, showFor(fixtureTags.qwen36));
      },
    });

    const models = await runtimeFor(server).list();

    expect(models).toHaveLength(9);
    expect(peak).toBeLessThanOrEqual(4);
    expect(peak).toBeGreaterThan(1);
    const gemma = models.find(model => model.name === fixtureTags.gemma4.name);
    expect(gemma?.capabilities).toEqual({
      tools: true,
      vision: true,
      thinking: true,
      embeddings: false,
      completion: true,
    });
    expect(gemma?.quantization).toBe('Q4_K_M');
    // A model whose /api/show failed is still installed; its capabilities are just unreported.
    const embedding = models.find(model => model.name === fixtureTags.qwen3Embedding.name);
    expect(embedding?.sizeBytes).toBe(639150858);
    expect(embedding?.capabilities.embeddings).toBe(false);
  });

  it('drops a legacy-listed model whose /api/show reveals a cloud proxy', async () => {
    const aliasTag = { name: 'alias:latest', model: 'alias:latest', size: cloudTag.size, details: cloudTag.details };
    server = await startFakeServer({
      'GET /api/tags': json({ models: [legacyTags.models[0], aliasTag] }),
      'POST /api/show': (request, response) => {
        const { model } = JSON.parse(request.body) as { model: string };
        if (model === 'alias:latest') return sendJson(response, { ...showFor(fixtureTags.qwen36), remote_host: 'x' });
        return sendJson(response, showFor(fixtureTags.qwen36));
      },
    });
    const models = await runtimeFor(server).list();
    expect(models.map(model => model.name)).toEqual([fixtureTags.qwen36.name]);
  });

  it('treats a null model list as empty and skips malformed entries', async () => {
    server = await startFakeServer({ 'GET /api/tags': json({ models: null }) });
    expect(await runtimeFor(server).list()).toEqual([]);
    await server.close();

    server = await startFakeServer({
      'GET /api/tags': json({ models: [null, { details: {} }, { name: 'ok:latest', capabilities: ['completion'] }] }),
    });
    const models = await runtimeFor(server).list();
    expect(models.map(model => model.name)).toEqual(['ok:latest']);
  });
});

describe('OllamaRuntime.inspect', () => {
  it('combines /api/show with the tag size and derives the architecture', async () => {
    const modelInfo = {
      ...gemma4Show.model_info,
      'gemma4.block_count': 30,
      'gemma4.attention.head_count': 16,
      'gemma4.attention.head_count_kv': 8,
      'gemma4.attention.key_length': 256,
    };
    server = await startFakeServer({
      'GET /api/tags': json(tags),
      'POST /api/show': json({ ...gemma4Show, model_info: modelInfo }),
    });
    const result = await runtimeFor(server).inspect(fixtureTags.gemma4.name);

    expect(result.arch).toEqual({
      contextMax: 262144,
      blockCount: 30,
      headCount: 16,
      embeddingLength: 2816,
      full: { layers: 30, kvHeads: 8, keyLength: 256, valueLength: 256 },
      mtpLayers: 0,
    });
    expect(result.tensorStats).toBeNull();
    expect(result.model.sizeBytes).toBe(17987581215);
    expect(result.model.capabilities.vision).toBe(true);
    expect(JSON.parse(server.requests.find(request => request.path === '/api/show')?.body ?? '')).toEqual({
      model: fixtureTags.gemma4.name,
    });
  });

  it('returns arch null when model_info lacks the fields, still with the context limit', async () => {
    server = await startFakeServer({ 'GET /api/tags': json(tags), 'POST /api/show': json(gemma4Show) });
    const result = await runtimeFor(server).inspect(fixtureTags.gemma4.name);
    expect(result.arch).toBeNull();
    expect(result.contextLength).toBe(262144);
  });

  it('reports the template, license and weights blob the model was built from', async () => {
    const blob = 'd'.repeat(64);
    const projector = 'c'.repeat(64);
    const show = {
      ...gemma4Show,
      template: '{{ .Prompt }}',
      license: 'Apache License',
      modelfile: `# Modelfile generated by "ollama show"\nFROM /models/blobs/sha256-${blob}\nFROM /models/blobs/sha256-${projector}\nTEMPLATE x\n`,
    };
    server = await startFakeServer({ 'GET /api/tags': json(tags), 'POST /api/show': json(show) });
    const result = await runtimeFor(server).inspect(fixtureTags.gemma4.name);
    expect(result.contents).toEqual({
      template: '{{ .Prompt }}',
      license: 'Apache License',
      modelBlob: blob,
      projectorBlobs: [projector],
      draftBlobs: [],
    });

    await server.close();
    server = await startFakeServer({ 'GET /api/tags': json(tags), 'POST /api/show': json(gemma4Show) });
    const bare = await runtimeFor(server).inspect(fixtureTags.gemma4.name);
    expect(bare.contents).toEqual({
      template: null,
      license: null,
      modelBlob: null,
      projectorBlobs: [],
      draftBlobs: [],
    });
  });

  it.each([
    ['a Windows profile with a space', 'C:\\Users\\John Smith\\.ollama\\models\\blobs\\sha256-'],
    ['a macOS volume with a space', '/Volumes/External Drive/ollama/blobs/sha256-'],
    ['a bare blob name', 'sha256-'],
  ])('reads the weights blob from a FROM path on %s', async (_label, prefix) => {
    const blob = 'e'.repeat(64);
    const show = { ...gemma4Show, modelfile: `FROM ${prefix}${blob}\r\nTEMPLATE x\n` };
    server = await startFakeServer({ 'GET /api/tags': json(tags), 'POST /api/show': json(show) });
    expect((await runtimeFor(server).inspect(fixtureTags.gemma4.name)).contents?.modelBlob).toBe(blob);
  });

  it('reads no weights blob from a FROM line that names something else', async () => {
    const show = { ...gemma4Show, modelfile: `FROM /models/blobs/not-sha256-${'e'.repeat(64)}\nFROM gemma4:e4b\n` };
    server = await startFakeServer({ 'GET /api/tags': json(tags), 'POST /api/show': json(show) });
    expect((await runtimeFor(server).inspect(fixtureTags.gemma4.name)).contents?.modelBlob).toBeNull();
  });

  it('reads draft and projector blobs only from the generated header, retaining malformed paths', async () => {
    const model = 'a'.repeat(64);
    const draft = 'b'.repeat(64);
    const projector = 'c'.repeat(64);
    const show = {
      ...gemma4Show,
      modelfile:
        `FROM sha256-${model}\nDRAFT /models/sha256-${draft}\nFROM C:\\models\\sha256-${projector}\n` +
        `FROM unreadable\nTEMPLATE """\nFROM sha256-${draft}\nDRAFT sha256-${model}\n"""\n`,
    };
    server = await startFakeServer({ 'POST /api/show': json(show) });
    expect((await runtimeFor(server).inspect(fixtureTags.gemma4.name, { tags: false })).contents).toMatchObject({
      modelBlob: model,
      projectorBlobs: [projector, null],
      draftBlobs: [draft],
    });
  });

  it('skips the installed list when asked', async () => {
    server = await startFakeServer({ 'GET /api/tags': json(tags), 'POST /api/show': json(gemma4Show) });
    const result = await runtimeFor(server).inspect(fixtureTags.gemma4.name, { tags: false });
    expect(server.requests.map(request => request.path)).toEqual(['/api/show']);
    expect(result.model.sizeBytes).toBeNull();
  });

  it('stops a hanging /api/show when the caller aborts', async () => {
    server = await startFakeServer({ 'POST /api/show': hang });
    const reading = runtimeFor(server).inspect(fixtureTags.gemma4.name, {
      tags: false,
      signal: AbortSignal.timeout(50),
    });
    await expect(reading).rejects.toMatchObject({ name: 'TimeoutError' });
  });

  it('waits past the request deadline for a read given its own', async () => {
    server = await startFakeServer({
      'POST /api/show': async (_request, response) => {
        await delay(150);
        sendJson(response, gemma4Show);
      },
    });
    const runtime = new OllamaRuntime({ baseUrl: server.baseUrl, requestTimeoutMs: 50 });
    await expect(runtime.inspect(fixtureTags.gemma4.name, { tags: false })).rejects.toThrow('timed out after 50ms');
    const result = await runtime.inspect(fixtureTags.gemma4.name, { tags: false, timeoutMs: 2_000 });
    expect(result.contents?.template).toBe(gemma4Show.template ?? null);
  });

  it.each([[[]], [null]])('re-reads /api/show verbosely when per-layer arrays come back as %j', async blank => {
    const info = {
      'general.architecture': 'hybrid',
      'hybrid.block_count': 4,
      'hybrid.context_length': 8192,
      'hybrid.attention.head_count': 16,
      'hybrid.attention.key_length': 128,
    };
    server = await startFakeServer({
      'GET /api/tags': json(tags),
      'POST /api/show': (request, response) => {
        const verbose = (JSON.parse(request.body) as { verbose?: boolean }).verbose === true;
        const kv = verbose ? [0, 4, 0, 4] : blank;
        return sendJson(response, { ...gemma4Show, model_info: { ...info, 'hybrid.attention.head_count_kv': kv } });
      },
    });
    const result = await runtimeFor(server).inspect(fixtureTags.gemma4.name);
    expect(result.arch?.full).toEqual({ layers: 2, kvHeads: 4, keyLength: 128, valueLength: 128 });
    expect(server.requests.filter(request => request.path === '/api/show')).toHaveLength(2);
  });

  it('re-reads /api/show verbosely when the GGUF sliding-window pattern comes back blanked', async () => {
    const info = liveModelInfo['gemma3:270m'];
    const pattern = Array.from({ length: 18 }, (_, i) => i % 3 !== 2);
    server = await startFakeServer({
      'GET /api/tags': json(tags),
      'POST /api/show': (request, response) => {
        const verbose = (JSON.parse(request.body) as { verbose?: boolean }).verbose === true;
        const model_info = { ...info, 'gemma3.attention.sliding_window_pattern': verbose ? pattern : [] };
        return sendJson(response, { ...gemma4Show, model_info });
      },
    });
    const result = await runtimeFor(server).inspect(fixtureTags.gemma4.name);
    expect([result.arch?.full.layers, result.arch?.swa?.layers]).toEqual([6, 12]);
  });

  it('reads verbose tensors for MoE models and counts MoE layers from them', async () => {
    const info = { ...liveModelInfo['qwen2.5:0.5b'], 'qwen2.expert_count': 8, 'qwen2.expert_used_count': 2 };
    const tensors = [
      { name: 'token_embd.weight', type: 'F16', shape: [896, 100] },
      { name: 'blk.0.ffn_up_exps.weight', type: 'Q8_0', shape: [896, 64, 8] },
      { name: 'blk.1.ffn_up_exps.weight', type: 'Q8_0', shape: [896, 64, 8] },
    ];
    server = await startFakeServer({
      'GET /api/tags': json(tags),
      'POST /api/show': (request, response) => {
        const verbose = (JSON.parse(request.body) as { verbose?: boolean }).verbose === true;
        return sendJson(response, { ...gemma4Show, model_info: info, ...(verbose ? { tensors } : {}) });
      },
    });
    const result = await runtimeFor(server).inspect(fixtureTags.gemma4.name);
    expect(result.arch?.moe).toEqual({ experts: 8, used: 2, moeLayers: 2 });
    expect(result.tensorStats).toEqual({
      expertBytesPerLayer: (896 * 64 * 8 * 34) / 32,
      nonExpertBytes: 896 * 100 * 2,
    });
  });

  it('keeps the non-verbose answer when the verbose re-read fails', async () => {
    let calls = 0;
    const info = { ...liveModelInfo['qwen3.5:0.8b'], 'qwen35.attention.recurrent_layers': null };
    server = await startFakeServer({
      'GET /api/tags': json(tags),
      'POST /api/show': (_request, response) =>
        calls++ === 0 ? sendJson(response, { ...gemma4Show, model_info: info }) : sendJson(response, 'oops', 500),
    });
    const result = await runtimeFor(server).inspect(fixtureTags.gemma4.name);
    expect(result.arch).toEqual(liveArch['qwen3.5:0.8b']);
  });

  it('matches an untagged ref to its :latest tag', async () => {
    server = await startFakeServer({
      'GET /api/tags': json({ models: [{ ...fixtureTags.gemma4, name: 'gemma4:latest', model: 'gemma4:latest' }] }),
      'POST /api/show': json(gemma4Show),
    });
    const result = await runtimeFor(server).inspect('gemma4');
    expect(result.model.name).toBe('gemma4:latest');
    expect(result.model.sizeBytes).toBe(fixtureTags.gemma4.size);
  });

  it('throws ModelNotFoundError on a 404', async () => {
    server = await startFakeServer({
      'GET /api/tags': json(tags),
      'POST /api/show': json({ error: "model 'nope' not found" }, 404),
    });
    await expect(runtimeFor(server).inspect('nope')).rejects.toBeInstanceOf(ModelNotFoundError);
  });
});

describe('OllamaRuntime.pull', () => {
  const layerA = 'sha256:aaaa';
  const layerB = 'sha256:bbbb';

  it('aggregates bytes across layer digests and resolves on success', async () => {
    server = await startFakeServer({
      'POST /api/pull': async (_request, response) => {
        response.writeHead(200, { 'content-type': 'application/x-ndjson' });
        const body = ndjson([
          { status: 'pulling manifest' },
          { status: `pulling ${layerA}`, digest: layerA, total: 1000 },
          { status: `pulling ${layerA}`, digest: layerA, total: 1000, completed: 400 },
          { status: `pulling ${layerB}`, digest: layerB, total: 500, completed: 100 },
          { status: `pulling ${layerA}`, digest: layerA, total: 1000, completed: 1000 },
          { status: `pulling ${layerB}`, digest: layerB, total: 500, completed: 500 },
          { status: 'verifying sha256 digest' },
          { status: 'writing manifest' },
          { status: 'success' },
        ]);
        // Split mid-line so the reader has to stitch frames across chunks.
        const cut = Math.floor(body.length / 2) + 3;
        response.write(body.slice(0, cut));
        await delay(10);
        response.end(body.slice(cut));
      },
    });
    const progress: PullProgress[] = [];
    await runtimeFor(server).pull('qwen3:8b', { onProgress: update => progress.push(update) });

    expect(progress.map(update => [update.completedBytes, update.totalBytes])).toEqual([
      [0, null],
      [0, 1000],
      [400, 1000],
      [500, 1500],
      [1100, 1500],
      [1500, 1500],
      [1500, 1500],
      [1500, 1500],
      [1500, 1500],
    ]);
    expect(progress.at(-1)?.status).toBe('success');
    expect(JSON.parse(server.requests[0]?.body ?? '')).toEqual({ model: 'qwen3:8b', stream: true });
  });

  it('rethrows an onProgress throw unchanged', async () => {
    server = await startFakeServer({
      'POST /api/pull': (_request, response) =>
        response.end(ndjson([{ status: 'pulling manifest' }, { status: 'success' }])),
    });
    const thrown = new Error('progress sink closed');
    const error: unknown = await runtimeFor(server)
      .pull('qwen3:8b', {
        onProgress: () => {
          throw thrown;
        },
      })
      .catch((caught: unknown) => caught);
    expect(error).toBe(thrown);
  });

  it('passes hf.co refs through unchanged', async () => {
    server = await startFakeServer({
      'POST /api/pull': (_request, response) => response.end(ndjson([{ status: 'success' }])),
    });
    await runtimeFor(server).pull('hf.co/unsloth/Qwen3-8B-GGUF:Q4_K_M');
    expect(JSON.parse(server.requests[0]?.body ?? '').model).toBe('hf.co/unsloth/Qwen3-8B-GGUF:Q4_K_M');
  });

  it('rejects with the daemon message on an error line', async () => {
    const error = 'pull model manifest: realm host "huggingface.co" does not match original host "hf.co"';
    server = await startFakeServer({
      'POST /api/pull': (_request, response) => response.end(ndjson([{ status: 'pulling manifest' }, { error }])),
    });
    const pull = runtimeFor(server).pull('hf.co/nobody/nothing');
    await expect(pull).rejects.toBeInstanceOf(LocalRuntimeError);
    await expect(pull).rejects.not.toBeInstanceOf(ModelNotFoundError);
    await expect(pull).rejects.toThrow(error);
  });

  it('rejects with ModelNotFoundError when the registry has no such model', async () => {
    server = await startFakeServer({
      'POST /api/pull': (_request, response) =>
        response.end(ndjson([{ status: 'pulling manifest' }, { error: 'pull model manifest: file does not exist' }])),
    });
    const pull = runtimeFor(server).pull('nope:latest');
    await expect(pull).rejects.toBeInstanceOf(ModelNotFoundError);
    await expect(pull).rejects.toMatchObject({
      model: 'nope:latest',
      cause: 'pull model manifest: file does not exist',
    });
  });

  it('wraps a connection dropped mid-stream in RuntimeConnectionError', async () => {
    server = await startFakeServer({
      'POST /api/pull': (_request, response) => {
        response.writeHead(200, { 'content-type': 'application/x-ndjson' });
        response.write(ndjson([{ status: 'pulling manifest' }]));
        setTimeout(() => response.destroy(), 20);
      },
    });
    await expect(runtimeFor(server).pull('qwen3:8b')).rejects.toBeInstanceOf(RuntimeConnectionError);
  });

  it('rejects with RuntimeHttpError when the daemon refuses the request', async () => {
    server = await startFakeServer({ 'POST /api/pull': json({ error: 'invalid model name' }, 400) });
    const pull = runtimeFor(server).pull('???');
    await expect(pull).rejects.toBeInstanceOf(RuntimeHttpError);
    await expect(pull).rejects.toThrow('invalid model name');
  });

  it('rejects when the stream ends without success', async () => {
    server = await startFakeServer({
      'POST /api/pull': (_request, response) => response.end(ndjson([{ status: 'pulling manifest' }])),
    });
    await expect(runtimeFor(server).pull('qwen3:8b')).rejects.toBeInstanceOf(RuntimeProtocolError);
  });

  it('stops reading when the signal aborts mid-download', async () => {
    server = await startFakeServer({
      'POST /api/pull': (_request, response) => {
        response.writeHead(200, { 'content-type': 'application/x-ndjson' });
        // Two frames in one chunk: the second must not reach onProgress after the abort.
        response.write(
          ndjson([
            { status: `pulling ${layerA}`, digest: layerA, total: 1000, completed: 10 },
            { status: `pulling ${layerA}`, digest: layerA, total: 1000, completed: 20 },
          ])
        );
      },
    });
    const controller = new AbortController();
    const progress: PullProgress[] = [];
    const pull = runtimeFor(server).pull('qwen3:8b', {
      signal: controller.signal,
      onProgress: update => {
        progress.push(update);
        controller.abort();
      },
    });
    await expect(pull).rejects.toMatchObject({ name: 'AbortError' });
    expect(progress).toHaveLength(1);
  });

  it('fails with LocalRuntimeError when the daemon goes silent past the idle timeout', async () => {
    server = await startFakeServer({
      'POST /api/pull': (_request, response) => {
        response.writeHead(200, { 'content-type': 'application/x-ndjson' });
        response.write(ndjson([{ status: 'pulling manifest' }]));
      },
    });
    const progress: PullProgress[] = [];
    const pull = runtimeFor(server).pull('qwen3:8b', {
      idleTimeoutMs: 50,
      onProgress: update => progress.push(update),
    });
    await expect(pull).rejects.toBeInstanceOf(LocalRuntimeError);
    await expect(pull).rejects.toThrow('sent nothing for 50ms');
    expect(progress).toHaveLength(1);
  });

  it('keeps going while frames arrive inside the idle window', async () => {
    server = await startFakeServer({
      'POST /api/pull': async (_request, response) => {
        response.writeHead(200, { 'content-type': 'application/x-ndjson' });
        for (let index = 0; index < 4; index++) {
          response.write(ndjson([{ status: 'verifying sha256 digest' }]));
          await delay(20);
        }
        response.end(ndjson([{ status: 'success' }]));
      },
    });
    await expect(runtimeFor(server).pull('qwen3:8b', { idleTimeoutMs: 500 })).resolves.toBeUndefined();
  });

  it.each([0, -1, -Infinity, NaN])('rejects idleTimeoutMs %s before contacting the runtime', async idleTimeoutMs => {
    server = await startFakeServer({});
    const runtime = runtimeFor(server);
    const pull = runtime.pull('qwen3:8b', { idleTimeoutMs });
    await expect(pull).rejects.toBeInstanceOf(LocalRuntimeError);
    await expect(pull).rejects.toMatchObject({
      runtimeId: runtime.id,
      message: `idleTimeoutMs must be a positive number or Infinity, got ${idleTimeoutMs}`,
    });
    expect(server.requests).toHaveLength(0);
  });

  it('treats an infinite idle timeout as no watchdog', async () => {
    server = await startFakeServer({
      'POST /api/pull': async (_request, response) => {
        response.writeHead(200, { 'content-type': 'application/x-ndjson' });
        response.write(ndjson([{ status: 'pulling manifest' }]));
        await delay(50);
        response.end(ndjson([{ status: 'success' }]));
      },
    });
    await expect(runtimeFor(server).pull('qwen3:8b', { idleTimeoutMs: Infinity })).resolves.toBeUndefined();
  });

  it('rejects with RuntimeProtocolError on a frame that is not JSON', async () => {
    server = await startFakeServer({
      'POST /api/pull': (_request, response) =>
        response.end(ndjson([{ status: 'pulling manifest' }]) + '<html>\n' + ndjson([{ status: 'success' }])),
    });
    await expect(runtimeFor(server).pull('qwen3:8b')).rejects.toBeInstanceOf(RuntimeProtocolError);
  });

  it('rejects immediately when the signal is already aborted', async () => {
    server = await startFakeServer({ 'POST /api/pull': hang });
    await expect(runtimeFor(server).pull('qwen3:8b', { signal: AbortSignal.abort() })).rejects.toMatchObject({
      name: 'AbortError',
    });
  });
});

describe('OllamaRuntime on an unreachable daemon', () => {
  it.each([
    ['list', (runtime: OllamaRuntime) => runtime.list()],
    ['inspect', (runtime: OllamaRuntime) => runtime.inspect('qwen3:8b')],
    ['pull', (runtime: OllamaRuntime) => runtime.pull('qwen3:8b')],
    ['remove', (runtime: OllamaRuntime) => runtime.remove('qwen3:8b')],
    ['loaded', (runtime: OllamaRuntime) => runtime.loaded()],
  ])('%s rejects with RuntimeConnectionError carrying the socket error', async (_name, call) => {
    const runtime = new OllamaRuntime({ baseUrl: `http://127.0.0.1:${await closedPort()}` });
    const error: unknown = await call(runtime).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(RuntimeConnectionError);
    expect(error).toBeInstanceOf(LocalRuntimeError);
    expect(error).toMatchObject({ runtimeId: runtime.id, message: expect.stringMatching(/connection refused$/) });
    expect((error as Error).cause).toMatchObject({ name: 'TypeError', cause: { code: 'ECONNREFUSED' } });
  });

  it('refuses to follow a redirect', async () => {
    const target = await startFakeServer({ 'GET /api/tags': json({ models: [] }) });
    server = await startFakeServer({
      'GET /api/tags': (_request, response) => {
        response.writeHead(302, { location: `${target.baseUrl}/api/tags` });
        response.end();
      },
    });
    try {
      const runtime = new OllamaRuntime({ baseUrl: server.baseUrl, apiKey: 'sk-test' });
      const error: unknown = await runtime.list().catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(RuntimeConnectionError);
      expect((error as Error).message).toMatch(/^ollama:127\.0\.0\.1:\d+ \/api\/tags failed: /);
      expect(target.requests).toEqual([]);
    } finally {
      await target.close();
    }
  });

  it('wraps a request timeout', async () => {
    server = await startFakeServer({ 'GET /api/tags': hang });
    const runtime = new OllamaRuntime({ baseUrl: server.baseUrl, requestTimeoutMs: 50 });
    const error: unknown = await runtime.list().catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(RuntimeConnectionError);
    expect((error as Error).message).toMatch(/\/api\/tags failed: timed out after 50ms$/);
  });
});

describe('OllamaRuntime.health', () => {
  it('reports the daemon version', async () => {
    server = await startFakeServer({ 'GET /api/version': json({ version: '0.31.1' }) });
    expect(await runtimeFor(server).health()).toEqual({ ok: true, version: '0.31.1', error: null });
  });

  it('reports a refused connection without throwing', async () => {
    const port = await closedPort();
    const health = await new OllamaRuntime({ baseUrl: `http://127.0.0.1:${port}` }).health();
    expect(health).toEqual({ ok: false, version: null, error: 'connection refused' });
  });

  it('reports a timeout without throwing', async () => {
    server = await startFakeServer({ 'GET /api/version': hang });
    const health = await runtimeFor(server, { healthTimeoutMs: 50 }).health();
    expect(health).toEqual({ ok: false, version: null, error: 'timed out after 50ms' });
  });

  it('reports invalid JSON and wrong shapes without throwing', async () => {
    server = await startFakeServer({
      'GET /api/version': (_request, response) => response.end('<html>not ollama</html>'),
    });
    const badJson = await runtimeFor(server).health();
    expect(badJson.ok).toBe(false);
    expect(badJson.error).toContain('invalid JSON');
    await server.close();

    server = await startFakeServer({ 'GET /api/version': json({ status: 'ok' }) });
    const wrongShape = await runtimeFor(server).health();
    expect(wrongShape.ok).toBe(false);
    expect(wrongShape.error).toContain('unexpected shape');
  });

  it('sees a throwing fake handler as HTTP 500', async () => {
    server = await startFakeServer({
      'GET /api/version': () => {
        throw new Error('handler bug');
      },
    });
    const health = await runtimeFor(server).health();
    expect(health.error).toContain('HTTP 500: fake handler threw: Error: handler bug');
  });

  it('reports an HTTP error status', async () => {
    server = await startFakeServer({ 'GET /api/version': json({ error: 'overloaded' }, 503) });
    const health = await runtimeFor(server).health();
    expect(health.ok).toBe(false);
    expect(health.error).toContain('HTTP 503: overloaded');
  });
});

describe('OllamaRuntime.remove and loaded', () => {
  it('deletes by model name', async () => {
    server = await startFakeServer({ 'DELETE /api/delete': (_request, response) => response.end() });
    await runtimeFor(server).remove('qwen3:8b');
    expect(server.requests[0]).toMatchObject({ method: 'DELETE', body: JSON.stringify({ model: 'qwen3:8b' }) });
  });

  it('throws ModelNotFoundError when the model does not exist', async () => {
    server = await startFakeServer({ 'DELETE /api/delete': json({ error: "model 'x' not found" }, 404) });
    await expect(runtimeFor(server).remove('x')).rejects.toBeInstanceOf(ModelNotFoundError);
  });

  it('maps /api/ps entries', async () => {
    server = await startFakeServer({
      'GET /api/ps': json({
        models: [
          {
            name: 'mistral:latest',
            model: 'mistral:latest',
            size: 5137025024,
            digest: '2ae6f6dd7a3dd734790bbbf58b8909a606e0e7e97e94b7604e0aa7ae4490e6d8',
            details: { family: 'llama', parameter_size: '7.2B', quantization_level: 'Q4_0' },
            expires_at: '2024-06-04T14:38:31.83753-07:00',
            size_vram: 5137025024,
            context_length: 4096,
          },
          { name: 'old:latest', size: 100, size_vram: 0, expires_at: '2024-06-04T14:38:31Z' },
        ],
      }),
    });
    expect(await runtimeFor(server).loaded()).toEqual([
      {
        name: 'mistral:latest',
        sizeBytes: 5137025024,
        vramBytes: 5137025024,
        contextLength: 4096,
        expiresAt: '2024-06-04T14:38:31.83753-07:00',
      },
      { name: 'old:latest', sizeBytes: 100, vramBytes: 0, contextLength: null, expiresAt: '2024-06-04T14:38:31Z' },
    ]);
  });
});
