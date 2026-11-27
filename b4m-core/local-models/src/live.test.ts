import { execFileSync } from 'node:child_process';
import { tmpdir, totalmem } from 'node:os';
import { describe, expect, it } from 'vitest';
import { detectRuntimes } from './detect';
import { LocalRuntimeError, ModelNotFoundError, RuntimeConnectionError } from './errors';
import { probeHardware } from './hardware';
import { HuggingFaceHub } from './huggingface';
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
const HF = process.env.LOCAL_MODELS_LIVE_HF;
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

describe.runIf(HF)('live Hugging Face Hub', () => {
  // Built per test: the describe body still runs when skipped.
  const hub = () => new HuggingFaceHub({ endpoint: HF });
  const tree = async (repo: string, revision: string) =>
    rawJson<{ type: string; path: string; size: number; lfs?: { oid: string } }[]>(
      `${hub().endpoint}/api/models/${repo}/tree/${revision}?recursive=true`
    );

  it('finds the official Qwen2.5 0.5B GGUF and pages on with the Link cursor', async () => {
    const first = await hub().search({ query: 'qwen2.5 0.5b', limit: 5 });
    expect(first.models.map(model => model.id)).toContain('Qwen/Qwen2.5-0.5B-Instruct-GGUF');
    expect(first.models.find(model => model.id === 'Qwen/Qwen2.5-0.5B-Instruct-GGUF')).toMatchObject({
      author: 'Qwen',
      gated: false,
      licenses: ['apache-2.0'],
      pipelineTag: 'text-generation',
    });
    expect(first.nextCursor).not.toBeNull();
    const second = await hub().search({ query: 'qwen2.5 0.5b', limit: 5, cursor: first.nextCursor ?? '' });
    expect(second.models.length).toBeGreaterThan(0);
    expect(second.models.some(model => first.models.some(seen => seen.id === model.id))).toBe(false);
    for (const sort of ['likes', 'trending', 'updated'] as const)
      expect((await hub().search({ query: 'qwen2.5', sort, limit: 3 })).models.length).toBeGreaterThan(0);
  });

  it('lists Qwen2.5 0.5B q4_k_m with its published size and sha256 at a pinned commit', async () => {
    const detail = await hub().getModel('Qwen/Qwen2.5-0.5B-Instruct-GGUF');
    const build = detail.builds.find(entry => entry.quant === 'Q4_K_M');
    expect(build?.files).toEqual([
      {
        path: 'qwen2.5-0.5b-instruct-q4_k_m.gguf',
        sizeBytes: 491400032,
        sha256: '74a4da8c9fdbcd15bd1f6d01d621410d31c6fc00986f5eb687824e7b93d7a9db',
        url: `${hub().endpoint}/Qwen/Qwen2.5-0.5B-Instruct-GGUF/resolve/${detail.revision}/qwen2.5-0.5b-instruct-q4_k_m.gguf`,
      },
    ]);
    expect(build?.ollamaRef).toBe('hf.co/Qwen/Qwen2.5-0.5B-Instruct-GGUF:Q4_K_M');
    expect(detail).toMatchObject({
      licenses: ['apache-2.0'],
      baseModels: ['Qwen/Qwen2.5-0.5B-Instruct'],
      canDownload: true,
    });
    const head = await fetch(build?.files[0]?.url ?? '', { method: 'HEAD', redirect: 'manual' });
    expect(head.headers.get('x-repo-commit')).toBe(detail.revision);
    expect(head.headers.get('x-linked-etag')).toBe(`"${build?.files[0]?.sha256}"`);
  });

  it('groups split, foldered and projector files of an unsloth vision repo', async () => {
    const repo = 'unsloth/Qwen2.5-VL-72B-Instruct-GGUF';
    const detail = await hub().getModel(repo);
    const ggufPaths = (await tree(repo, detail.revision)).filter(entry => entry.path.endsWith('.gguf'));
    const listed = [...detail.builds.flatMap(build => build.files), ...detail.projectors].map(file => file.path);
    expect(listed.sort()).toEqual(ggufPaths.map(entry => entry.path).sort());
    const bf16 = detail.builds.find(build => build.quant === 'BF16');
    expect(bf16).toMatchObject({ split: true, complete: true, ollamaRefIssue: 'split' });
    expect(bf16?.files.map(file => file.path)).toEqual(
      [1, 2, 3].map(i => `BF16/Qwen2.5-VL-72B-Instruct-BF16-0000${i}-of-00003.gguf`)
    );
    expect(bf16?.sizeBytes).toBe(
      ggufPaths.filter(entry => entry.path.startsWith('BF16/')).reduce((sum, entry) => sum + entry.size, 0)
    );
    expect(detail.projectors.map(projector => projector.quant).sort()).toEqual(['BF16', 'F16', 'F32']);
    expect(detail.builds.find(build => build.quant === 'UD-Q4_K_XL')?.ollamaRef).toBe(`hf.co/${repo}:UD-Q4_K_XL`);
    expect(detail).toMatchObject({ licenses: ['other'], licenseName: 'qwen', pipelineTag: 'image-text-to-text' });
  });

  it('keeps the second license of repos that declare two', async () => {
    expect((await hub().getModel('DevWorld/Gemago-2b-Q4_K_M-GGUF')).licenses).toEqual(['apache-2.0', 'gemma']);
    expect((await hub().getModel('mradermacher/Gemago-2b-GGUF')).licenses).toEqual(['apache-2.0', 'gemma']);
    expect((await hub().getModel('mradermacher/Lune-GGUF')).licenses).toEqual(['apache-2.0', 'llama3']);
    const found = await hub().search({ query: 'Gemago-2b', limit: 20 });
    expect(found.models.find(model => model.id === 'mradermacher/Gemago-2b-GGUF')?.licenses).toEqual([
      'apache-2.0',
      'gemma',
    ]);
  });

  it('reports a gated repo as gated and not downloadable without a token', async () => {
    const repo = 'google/gemma-3-1b-it-qat-q4_0-gguf';
    const detail = await hub().getModel(repo);
    expect(detail).toMatchObject({ gated: 'manual', canDownload: false, licenses: ['gemma'], ollamaNeedsSshKey: true });
    expect(detail.builds[0]?.files[0]?.sha256).toBeNull();
    const head = await fetch(detail.builds[0]?.files[0]?.url ?? '', { method: 'HEAD', redirect: 'manual' });
    expect([head.status, head.headers.get('x-error-code')]).toEqual([401, 'GatedRepo']);
    await expect(hub().getModel('b4m-nobody/no-such-repo-GGUF')).rejects.toBeInstanceOf(ModelNotFoundError);
  });

  it('plans and verifies a tag that reaches F16 past the BF16 file that sorts before it', async () => {
    const repo = 'unsloth/Llama-3.2-1B-Instruct-GGUF';
    const detail = await hub().getModel(repo);
    const f16 = detail.builds.find(build => build.quant === 'F16');
    const bf16 = detail.builds.find(build => build.quant === 'BF16');
    expect(f16?.ollamaRef).toBe(`hf.co/${repo}:Instruct-F16`);
    expect(f16 && (await hub().verifyOllamaRef(detail, f16))).toBe(`hf.co/${repo}:Instruct-F16`);
    expect(bf16 && (await hub().verifyOllamaRef(detail, bf16))).toBe(`hf.co/${repo}:BF16`);
    const bare = await rawJson<{ layers: { mediaType: string; digest: string }[] }>(
      `${hub().endpoint}/v2/${repo}/manifests/F16`,
      { headers: { accept: 'application/vnd.docker.distribution.manifest.v2+json' } }
    );
    expect(bare.layers.find(layer => layer.mediaType.endsWith('.model'))?.digest).toBe(
      `sha256:${bf16?.files[0]?.sha256}`
    );
  });

  it('verifies main builds and refuses files the registry skips or a revision behind main', async () => {
    const repo = 'ggml-org/gpt-oss-20b-GGUF';
    const detail = await hub().getModel(repo);
    const main = detail.builds.find(build => build.quant === 'MXFP4' && !/eagle3/i.test(build.id));
    const eagle = detail.builds.filter(build => /eagle3/i.test(build.id) && build.ollamaRef);
    expect(main && (await hub().verifyOllamaRef(detail, main))).toBe(main?.ollamaRef);
    expect(eagle.length).toBeGreaterThan(0);
    for (const build of eagle) expect(await hub().verifyOllamaRef(detail, build)).toBeNull();

    const old = await hub().getModel(repo, { revision: '4fec29804e3af052b602946deec2d3e62a6015e0' });
    const oldMain = old.builds.find(build => build.quant === 'MXFP4' && !/eagle3/i.test(build.id));
    expect(oldMain).toMatchObject({ ollamaRef: null, ollamaRefIssue: 'pinned-revision' });
    expect(oldMain?.files[0]?.sha256).not.toBe(main?.files[0]?.sha256);
    expect(oldMain && (await hub().verifyOllamaRef(old, oldMain))).toBeNull();

    for (const other of ['ggml-org/Qwen3-8B-GGUF', 'ggml-org/gemma-4-31B-it-GGUF']) {
      const info = await hub().getModel(other);
      const build = info.builds.find(
        entry => entry.ollamaRef && !/^(?:.*\/)?(?:dflash|dspark|mtp|eagle3)/i.test(entry.id)
      );
      expect(build && (await hub().verifyOllamaRef(info, build))).toBe(build?.ollamaRef);
    }
  });
});

describe.runIf(HF && OLLAMA)('live Hugging Face pull through Ollama', () => {
  const repo = 'bartowski/SmolLM2-135M-Instruct-GGUF';
  const runtime = new OllamaRuntime({ baseUrl: OLLAMA });
  const post = (path: string, body: unknown) =>
    fetch(`${runtime.baseUrl}${path}`, { method: 'POST', body: JSON.stringify(body) });
  const installed = async (ref: string) =>
    (await runtime.list()).filter(entry => entry.name.toLowerCase() === ref.toLowerCase()).map(entry => entry.name);

  it(
    'pulls a build by its ref, stores the listed sha256, and resolves the tag case-insensitively',
    async () => {
      const build = (await new HuggingFaceHub({ endpoint: HF }).getModel(repo)).builds.find(
        entry => entry.quant === 'Q4_K_M'
      );
      const ref = build?.ollamaRef ?? '';
      expect(ref).toBe(`hf.co/${repo}:Q4_K_M`);
      expect(await installed(ref)).toEqual([]);
      try {
        await runtime.pull(ref);
        expect(await installed(ref)).toEqual([ref]);
        const show = await post('/api/show', { model: ref });
        const { modelfile } = (await show.json()) as { modelfile: string };
        expect(modelfile).toContain(`sha256-${build?.files[0]?.sha256}`);
        await runtime.pull(ref.replace(/:[^:]+$/, tag => tag.toLowerCase()));
        expect(await installed(ref)).toEqual([ref]);
      } finally {
        await runtime.remove(ref).catch(() => undefined);
      }
      expect(await installed(ref)).toEqual([]);
    },
    PULL_TIMEOUT_MS
  );
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
      const memoryTotals = run('nvidia-smi', ['--query-gpu=memory.total', '--format=csv,noheader,nounits']);
      expect(memoryTotals).not.toBeNull();
      const hasSharedMemory = memoryTotals?.split(/\r?\n/).some(line => /^\[?N\/A\]?$/i.test(line.trim()));
      expect(profile).toMatchObject({
        memoryKind: hasSharedMemory ? 'unified' : 'discrete',
        gpuCount: nvidiaGpus,
        confidence: 'high',
      });
      if (hasSharedMemory) expect(profile.gpuMemoryBytes).toBeNull();
      else expect(profile.gpuMemoryBytes).toBeGreaterThan(0);
    } else if (profile.memoryKind === 'cpu') {
      expect(profile).toMatchObject({ gpuCount: 0, gpuMemoryBytes: null, gpuName: null });
    } else {
      expect(profile.memoryKind).toBe('discrete');
      expect(profile.gpuCount).toBeGreaterThan(0);
      expect(profile.confidence).toBe(profile.gpuMemoryBytes === null ? 'low' : 'high');
    }
  });
});
