import { execFileSync } from 'node:child_process';
import { tmpdir, totalmem } from 'node:os';
import { describe, expect, it } from 'vitest';
import { detectRuntimes } from './detect';
import { LocalRuntimeError, ModelNotFoundError, RuntimeConnectionError } from './errors';
import { probeHardware } from './hardware';
import { OllamaRuntime } from './ollama';
import { OpenAICompatibleRuntime } from './openaiCompatible';
import type { PullProgress } from './types';
import { closedPort, delay } from './__test__/fakeServer';
import { liveArch } from './__test__/ollamaFixtures';

// Opt-in checks against real runtimes, skipped unless these are set; the package README has the command.
const OLLAMA = process.env.LOCAL_MODELS_LIVE_OLLAMA;
const OPENAI = process.env.LOCAL_MODELS_LIVE_OPENAI;
const OPENAI_KEY = process.env.LOCAL_MODELS_LIVE_OPENAI_KEY || undefined;
const MODELS = (process.env.LOCAL_MODELS_LIVE_OLLAMA_MODELS ?? 'qwen2.5:0.5b').split(',').map(m => m.trim());
const PULL_TIMEOUT_MS = 30 * 60_000;

async function rawJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  expect(response.ok, `${url} returned ${response.status}`).toBe(true);
  return (await response.json()) as T;
}

const withTag = (model: string) => (/:[^/]+$/.test(model) ? model : `${model}:latest`);

function run(command: string, args: string[]): string | null {
  try {
    return execFileSync(command, args, { encoding: 'utf8' });
  } catch {
    return null;
  }
}

describe.runIf(OLLAMA)('live Ollama', () => {
  const runtime = new OllamaRuntime({ baseUrl: OLLAMA });
  const post = (path: string, body: unknown) =>
    fetch(`${runtime.baseUrl}${path}`, { method: 'POST', body: JSON.stringify(body) });

  it('reports the /api/version version and is detected once under every spelling of its host', async () => {
    const { version } = await rawJson<{ version: string }>(`${runtime.baseUrl}/api/version`);
    expect(await runtime.health()).toEqual({ ok: true, version, error: null });
    const spellings = [OLLAMA ?? '', `${runtime.baseUrl}/`, runtime.baseUrl.replace('127.0.0.1', 'localhost')];
    const found = await detectRuntimes({ hosts: spellings, defaultHosts: [] });
    expect(found.map(entry => [entry.runtime.kind, entry.health.version])).toEqual([['ollama', version]]);
  });

  it('rejects an aborted pull with AbortError and reports no progress after the abort', async () => {
    const controller = new AbortController();
    let afterAbort = 0;
    const pull = runtime.pull(MODELS[0] ?? '', {
      signal: controller.signal,
      onProgress: () => (controller.signal.aborted ? afterAbort++ : controller.abort()),
    });
    await expect(pull).rejects.toMatchObject({ name: 'AbortError' });
    await delay(500);
    expect(afterAbort).toBe(0);
  });

  it.each(MODELS)(
    'pulls %s with monotonic progress ending at the /api/tags size',
    async model => {
      const frames: PullProgress[] = [];
      await runtime.pull(model, { onProgress: progress => frames.push(progress) });
      frames.forEach((frame, i) => {
        if (frame.totalBytes !== null) expect(frame.completedBytes).toBeLessThanOrEqual(frame.totalBytes);
        expect(frame.completedBytes).toBeGreaterThanOrEqual(frames[i - 1]?.completedBytes ?? 0);
      });
      const { models } = await rawJson<{ models: { name: string; size: number }[] }>(`${runtime.baseUrl}/api/tags`);
      const size = models.find(entry => entry.name === withTag(model))?.size;
      expect(frames.at(-1)).toMatchObject({ status: 'success', completedBytes: size, totalBytes: size });
      expect((await runtime.list()).find(entry => entry.name === withTag(model))?.sizeBytes).toBe(size);
    },
    PULL_TIMEOUT_MS
  );

  it.each(MODELS)('inspects %s consistently with verbose /api/show', async model => {
    const { model: info, arch, tensorStats } = await runtime.inspect(model);
    const response = await post('/api/show', { model, verbose: true });
    const modelInfo = ((await response.json()) as { model_info: Record<string, unknown> }).model_info;
    const field = (key: string) => modelInfo[`${String(modelInfo['general.architecture'])}.${key}`];
    expect(info.name).toBe(withTag(model));
    expect(arch).toMatchObject({ blockCount: field('block_count'), contextMax: field('context_length') });
    if (field('attention.key_length') !== undefined) expect(arch?.full.keyLength).toBe(field('attention.key_length'));
    if (arch?.swa) expect(arch.swa.window).toBe(field('attention.sliding_window'));
    const kv = field('attention.head_count_kv');
    const kvHeads = Array.isArray(kv) ? Math.max(...(kv as number[])) : kv;
    if (kvHeads !== undefined) expect(Math.max(arch?.full.kvHeads ?? 0, arch?.swa?.kvHeads ?? 0)).toBe(kvHeads);
    const flags = field('attention.recurrent_layers');
    if (Array.isArray(flags)) expect(arch?.recurrent?.layers).toBe(flags.filter(Boolean).length);
    if (Array.isArray(kv) && field('ssm.state_size') !== undefined) {
      expect(arch?.full.layers).toBe(kv.filter(heads => heads !== 0).length);
      expect(arch?.recurrent?.layers).toBe(kv.filter(heads => heads === 0).length);
    }
    const kvLayers = (arch?.full.layers ?? 0) + (arch?.swa?.layers ?? 0) + (arch?.mla?.layers ?? 0);
    expect(kvLayers + (arch?.recurrent?.layers ?? 0)).toBeLessThanOrEqual(arch?.blockCount ?? 0);
    if (!field('expert_count')) expect(tensorStats).toBeNull();
    // Exact layouts read off llama.cpp b11889's cache allocation for the same blobs.
    if (model in liveArch) expect(arch).toEqual(liveArch[model as keyof typeof liveArch]);
  });

  it('resolves an untagged name to :latest, deletes it once, and reports missing models', async () => {
    const alias = 'b4m-local-models-live';
    expect((await post('/api/copy', { source: MODELS[0], destination: alias })).ok).toBe(true);
    expect((await runtime.inspect(alias)).model.name).toBe(`${alias}:latest`);
    await runtime.remove(alias);
    await expect(runtime.remove(alias)).rejects.toBeInstanceOf(ModelNotFoundError);
    await expect(runtime.inspect('b4m-no-such-model:1b')).rejects.toBeInstanceOf(ModelNotFoundError);
    await expect(runtime.pull('b4m-no-such-model:1b')).rejects.toBeInstanceOf(ModelNotFoundError);
  });

  it('rejects every call on a dead host with RuntimeConnectionError', async () => {
    const dead = new OllamaRuntime({ baseUrl: `127.0.0.1:${await closedPort()}` });
    for (const call of [
      () => dead.list(),
      () => dead.inspect(MODELS[0] ?? ''),
      () => dead.pull('x'),
      () => dead.loaded(),
    ]) {
      const error: unknown = await call().catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(RuntimeConnectionError);
      expect(error).toBeInstanceOf(LocalRuntimeError);
      expect((error as Error).cause).toMatchObject({ cause: { code: 'ECONNREFUSED' } });
    }
  });

  it('lists the models /api/ps reports as loaded', async () => {
    const { models } = await rawJson<{ models: { name: string }[] | null }>(`${runtime.baseUrl}/api/ps`);
    expect((await runtime.loaded()).map(entry => entry.name)).toEqual((models ?? []).map(entry => entry.name));
  });
});

describe.runIf(OPENAI)('live OpenAI-compatible server', () => {
  const url = OPENAI ?? '';
  // Built per test: the describe body still runs when skipped, and the constructor rejects an empty URL.
  const runtimeWith = (apiKey?: string) => new OpenAICompatibleRuntime({ baseUrl: url, apiKey });

  it('is detected, healthy, and lists the /v1/models ids', async () => {
    const found = await detectRuntimes({ hosts: [{ url, apiKey: OPENAI_KEY }], defaultHosts: [] });
    expect(found.map(entry => [entry.runtime.kind, entry.health.ok])).toEqual([['openai-compatible', true]]);
    const runtime = runtimeWith(OPENAI_KEY);
    expect(await runtime.health()).toEqual({ ok: true, version: null, error: null });
    const headers = OPENAI_KEY ? { authorization: `Bearer ${OPENAI_KEY}` } : undefined;
    const { data } = await rawJson<{ data: { id: string }[] }>(`${runtime.baseUrl}/v1/models`, { headers });
    expect((await runtime.list()).map(entry => entry.name)).toEqual(data.map(entry => entry.id));
  });

  it.runIf(OPENAI_KEY)('asks for a key when none is sent and reports a wrong one as rejected', async () => {
    const [missing] = await detectRuntimes({ hosts: [url], defaultHosts: [] });
    expect(missing?.health).toEqual({ ok: false, version: null, error: 'Requires an API key' });
    const [wrong] = await detectRuntimes({ hosts: [{ url, apiKey: `${OPENAI_KEY}-wrong` }], defaultHosts: [] });
    expect(wrong?.health.error).toBe('API key was rejected');
    expect((await runtimeWith().health()).error).toBe('Requires an API key');
  });
});

describe.runIf(OLLAMA || OPENAI)('live host', () => {
  it('detects nothing on a closed port', async () => {
    expect(await detectRuntimes({ hosts: [`127.0.0.1:${await closedPort()}`], defaultHosts: [] })).toEqual([]);
  });

  it('probes memory, disk and GPUs consistently with the OS tools', async () => {
    const modelDir = process.env.LOCAL_MODELS_LIVE_MODEL_DIR || tmpdir();
    const profile = await probeHardware({ modelDir });
    expect(profile.totalMemoryBytes).toBe(totalmem());
    const dfAvailKb = Number(run('df', ['-Pk', modelDir])?.trim().split('\n').at(-1)?.split(/\s+/)[3]);
    expect(Math.abs((profile.diskFreeBytes ?? 0) - dfAvailKb * 1024)).toBeLessThan(dfAvailKb * 1024 * 0.01 + 1e6);

    const nvidiaGpus =
      run('nvidia-smi', ['-L'])
        ?.split('\n')
        .filter(line => line.startsWith('GPU ')).length ?? 0;
    if (profile.platform === 'darwin' && profile.arch === 'arm64') {
      expect(profile).toMatchObject({ memoryKind: 'unified', gpuCount: 1, confidence: 'high' });
      expect(profile.chip).toMatch(/^Apple /);
    } else if (nvidiaGpus > 0) {
      expect(profile).toMatchObject({ memoryKind: 'discrete', gpuCount: nvidiaGpus, confidence: 'high' });
      expect(profile.gpuMemoryBytes).toBeGreaterThan(0);
    } else {
      expect(profile).toMatchObject({ memoryKind: 'cpu', gpuCount: 0, gpuMemoryBytes: null, confidence: 'low' });
    }
  });
});
