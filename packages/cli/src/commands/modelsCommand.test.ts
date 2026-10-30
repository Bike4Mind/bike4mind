import { readFileSync } from 'fs';
import { join } from 'path';
import { PassThrough } from 'stream';
import { describe, it, expect, vi } from 'vitest';
import {
  HubAccessError,
  ModelNotFoundError,
  curatedListing,
  curatedPicks,
  curatedSource,
  loadCuratedManifest,
  type DetectedRuntime,
  type HardwareProfile,
  type HubGgufBuild,
  type HubModelDetail,
  type InstalledModel,
  type LocalRuntime,
  type PullOptions,
} from '@bike4mind/local-models';
import {
  EXIT_CANCELLED,
  confirmOnTerminal,
  pullModel,
  runModelsCommand,
  type ModelsDeps,
  type ModelsOptions,
} from './modelsCommand.js';
import {
  CancelledError,
  abortable,
  licenseFor,
  parsePullTarget,
  pickBuild,
  resolveRuntimeTarget,
  type HubClient,
  type RuntimeTarget,
} from '../models/localModels.js';
import { machineReader, type MachineReader } from '../models/fit.js';
import type { OllamaManifestInfo } from './ollamaRegistry.js';

const REPO = 'Qwen/Qwen2.5-0.5B-Instruct-GGUF';
const ENDPOINT = 'https://huggingface.co';

function build(quant: string, sizeBytes: number, extra: Partial<HubGgufBuild> = {}): HubGgufBuild {
  const path = `qwen2.5-0.5b-instruct-${quant.toLowerCase()}.gguf`;
  return {
    id: path.replace(/\.gguf$/, ''),
    quant,
    label: quant,
    files: [{ path, sizeBytes, sha256: 'a'.repeat(64), url: `${ENDPOINT}/${REPO}/resolve/main/${path}` }],
    sizeBytes,
    split: false,
    complete: true,
    ollamaRef: `hf.co/${REPO}:${quant}`,
    ollamaRefIssue: null,
    ...extra,
  };
}

function detail(overrides: Partial<HubModelDetail> = {}): HubModelDetail {
  return {
    id: REPO,
    author: 'Qwen',
    downloads: 123456,
    likes: 200,
    updatedAt: null,
    pipelineTag: 'text-generation',
    gated: false,
    private: false,
    licenses: ['apache-2.0'],
    baseModels: ['Qwen/Qwen2.5-0.5B-Instruct'],
    tags: [],
    revision: 'b'.repeat(40),
    licenseName: null,
    licenseLink: null,
    gguf: { architecture: 'qwen2', contextLength: 32768, parameterCount: 494032768 },
    builds: [
      build('Q4_K_M', 491_400_032),
      build('Q8_0', 675_710_816),
      build('F16', 1_200_000_000, { split: true, ollamaRef: null, ollamaRefIssue: 'split' }),
    ],
    projectors: [],
    canDownload: true,
    ollamaNeedsSshKey: false,
    ...overrides,
  };
}

const APACHE = readFileSync(join(__dirname, '__fixtures__', 'apache-2.0.txt'), 'utf-8');
const GEMMA = 'Gemma Terms of Use\n\nLast modified: February 21, 2024\n...Prohibited Use Policy...';

function manifestInfo(sizeBytes: number, licenses: string[], model = 'a'): OllamaManifestInfo {
  return {
    digest: `sha256:${model.repeat(12)}${'0'.repeat(52)}`,
    layers: [`sha256:${model.repeat(64)}`, ...licenses.map((_, index) => `sha256:${String(index).repeat(64)}`)],
    sizeBytes,
    licenses,
  };
}

function installed(name: string, extra: Partial<InstalledModel> = {}): InstalledModel {
  return {
    name,
    sizeBytes: 397_821_319,
    quantization: 'Q4_K_M',
    family: 'qwen2',
    parameterSize: '494M',
    modifiedAt: null,
    capabilities: { tools: true, vision: false, thinking: false, embeddings: false, completion: true },
    ...extra,
  };
}

const GIB = 1024 ** 3;

function cpuMachine(ramGiB: number): HardwareProfile {
  return {
    platform: 'linux',
    arch: 'x64',
    memoryKind: 'cpu',
    totalMemoryBytes: ramGiB * GIB,
    gpuMemoryBytes: null,
    gpuName: null,
    gpuCount: 0,
    chip: null,
    diskFreeBytes: null,
    confidence: 'high',
  };
}

function fakeRuntime(overrides: Partial<LocalRuntime> = {}): LocalRuntime {
  return {
    id: 'ollama:127.0.0.1:11500',
    kind: 'ollama',
    baseUrl: 'http://127.0.0.1:11500',
    capabilities: { canPull: true, canRemove: true, canInspect: true, reportsLoaded: true },
    health: vi.fn().mockResolvedValue({ ok: true, version: '0.40.11', error: null }),
    list: vi.fn().mockResolvedValue([
      installed('qwen2.5:0.5b'),
      installed('smollm2:135m', {
        capabilities: { tools: false, vision: false, thinking: false, embeddings: false, completion: true },
      }),
    ]),
    inspect: vi.fn(),
    pull: vi.fn(async (_ref: string, opts?: PullOptions) => {
      opts?.onProgress?.({ status: 'pulling manifest', completedBytes: 0, totalBytes: null });
      opts?.onProgress?.({ status: 'pulling abc123', completedBytes: 0, totalBytes: 400 });
      opts?.onProgress?.({ status: 'pulling def456', completedBytes: 100, totalBytes: 400 });
      opts?.onProgress?.({ status: 'success', completedBytes: 400, totalBytes: 400 });
    }),
    remove: vi.fn().mockResolvedValue(undefined),
    loaded: vi
      .fn()
      .mockResolvedValue([{ name: 'qwen2.5:0.5b', sizeBytes: 1, vramBytes: 0, contextLength: 4096, expiresAt: null }]),
    ...overrides,
  };
}

function fakeHub(overrides: Partial<HubClient> = {}): HubClient {
  return {
    endpoint: ENDPOINT,
    search: vi.fn().mockResolvedValue({
      models: [
        {
          id: REPO,
          author: 'Qwen',
          downloads: 123456,
          likes: 200,
          updatedAt: null,
          pipelineTag: 'text-generation',
          gated: false,
          private: false,
          licenses: ['apache-2.0', 'mit'],
          baseModels: [],
          tags: [],
        },
        {
          id: 'meta-llama/Llama-3.2-1B-GGUF',
          author: 'meta-llama',
          downloads: 900,
          likes: 3,
          updatedAt: null,
          pipelineTag: null,
          gated: 'manual',
          private: false,
          licenses: ['llama3.2'],
          baseModels: [],
          tags: [],
        },
      ],
      nextCursor: null,
    }),
    getModel: vi.fn().mockResolvedValue(detail()),
    verifyOllamaRef: vi.fn(async (d: Pick<HubModelDetail, 'id'>, b: HubGgufBuild) => `hf.co/${d.id}:${b.quant}`),
    ...overrides,
  };
}

function machine(overrides: Partial<HardwareProfile> = {}): HardwareProfile {
  return {
    platform: 'linux',
    arch: 'x64',
    memoryKind: 'discrete',
    totalMemoryBytes: 64 * GIB,
    gpuMemoryBytes: 24 * GIB,
    gpuName: 'Test GPU',
    gpuCount: 1,
    chip: null,
    diskFreeBytes: null,
    confidence: 'high',
    ...overrides,
  };
}

interface Harness {
  deps: ModelsDeps;
  lines: string[];
  questions: string[];
  progress: string[];
  saved: Array<{ defaultModel?: string; ollamaHost?: string; localDefaultModel?: string }>;
  runtime: LocalRuntime;
  hub: HubClient;
  registry: ReturnType<typeof vi.fn<ModelsDeps['ollamaRegistry']>>;
  controller: AbortController;
}

function harness(
  options: {
    runtime?: LocalRuntime;
    hub?: HubClient;
    registry?: ModelsDeps['ollamaRegistry'];
    resolveRuntime?: ModelsDeps['resolveRuntime'];
    confirm?: ModelsDeps['confirm'];
    curated?: ModelsDeps['curated'];
    hardware?: ModelsDeps['hardware'];
    answers?: boolean[];
    isTTY?: boolean;
    source?: RuntimeTarget['source'];
    config?: { defaultModel?: string; ollamaHost?: string };
    machine?: MachineReader;
    runtimeHost?: string | null;
  } = {}
): Harness {
  const lines: string[] = [];
  const questions: string[] = [];
  const progress: string[] = [];
  const saved: Harness['saved'] = [];
  const runtime = options.runtime ?? fakeRuntime();
  const hub = options.hub ?? fakeHub();
  const answers = [...(options.answers ?? [])];
  const controller = new AbortController();
  const registry = vi.fn<ModelsDeps['ollamaRegistry']>(
    options.registry ?? (async () => manifestInfo(270_800_000, [APACHE]))
  );
  const deps: ModelsDeps = {
    hub: () => hub,
    ollamaRegistry: registry,
    resolveRuntime: options.resolveRuntime ?? (async () => ({ runtime, source: options.source ?? 'config' })),
    config: {
      defaultModel: options.config?.defaultModel,
      ollamaHost: options.config?.ollamaHost,
      save: async patch => {
        saved.push(patch);
      },
    },
    confirm:
      options.confirm ??
      (async question => {
        questions.push(question);
        return answers.shift() ?? false;
      }),
    isTTY: options.isTTY ?? true,
    log: line => lines.push(line),
    progress: { update: line => progress.push(line), end: () => progress.push('<end>') },
    machine: options.machine ?? (async () => ({ hardware: cpuMachine(64) })),
    runtimeHost: () => options.runtimeHost ?? null,
    curated: options.curated ?? (() => loadCuratedManifest(() => {})),
    hardware: options.hardware ?? (async () => machine()),
    signal: controller.signal,
  };
  return { deps, lines, questions, progress, saved, runtime, hub, registry, controller };
}

const OPTS: ModelsOptions = { json: false, yes: false, force: false, acceptLicense: false, includeAbliterated: false };

describe('parsePullTarget', () => {
  it('reads Hugging Face repos with and without a host or quant', () => {
    expect(parsePullTarget(`hf.co/${REPO}:Q4_K_M`)).toEqual({ kind: 'hub', repo: REPO, tag: 'Q4_K_M' });
    expect(parsePullTarget(`https://huggingface.co/${REPO}`)).toEqual({ kind: 'hub', repo: REPO, tag: null });
    expect(parsePullTarget(`${REPO}:q8_0`)).toEqual({ kind: 'hub', repo: REPO, tag: 'q8_0' });
  });

  it.each([
    `hf.co:443/${REPO}:Q8_0`,
    `https://hf.co:443/${REPO}:Q8_0`,
    `www.huggingface.co/${REPO}:Q8_0`,
    `https://www.huggingface.co/${REPO}:Q8_0`,
    `huggingface.co:443/${REPO}:Q8_0`,
    `hf.co./${REPO}:Q8_0`,
    `HF.CO/${REPO}:Q8_0`,
  ])('reads %s as the Hugging Face repo', ref => {
    expect(parsePullTarget(ref)).toEqual({ kind: 'hub', repo: REPO, tag: 'Q8_0' });
  });

  it('treats single names and Ollama registry names as Ollama names', () => {
    expect(parsePullTarget('qwen2.5:0.5b')).toEqual({ kind: 'ollama', name: 'qwen2.5:0.5b' });
    expect(parsePullTarget('registry.ollama.ai/library/smollm2:135m')).toEqual({
      kind: 'ollama',
      name: 'smollm2:135m',
    });
    expect(parsePullTarget('https://ollama.com/library/gemma3:270m')).toEqual({
      kind: 'ollama',
      name: 'gemma3:270m',
    });
    expect(parsePullTarget('ollama.com/someone/model')).toEqual({
      kind: 'ollama',
      name: 'someone/model',
    });
  });

  it('refuses other registries, credentials and schemes instead of passing them to Ollama', () => {
    expect(() => parsePullTarget('example.com/owner/model:Q4_K_M')).toThrow(/Unsupported registry example\.com/);
    expect(() => parsePullTarget('https://example.com/owner/model')).toThrow(/Unsupported registry/);
    expect(() => parsePullTarget(`user@hf.co/${REPO}`)).toThrow(/Unsupported model ref/);
    expect(() => parsePullTarget(`ftp://hf.co/${REPO}`)).toThrow(/Unsupported model ref/);
    expect(() => parsePullTarget('localhost:5000/model')).toThrow(/Unsupported registry localhost/);
  });

  it('rejects malformed repo ids', () => {
    expect(() => parsePullTarget('hf.co/not a repo')).toThrow(/Not a Hugging Face repo/);
    expect(() => parsePullTarget(`${REPO}:`)).toThrow(/Not a Hugging Face repo/);
    expect(() => parsePullTarget('a/b/c')).toThrow(/Not a Hugging Face repo/);
    expect(() => parsePullTarget('https://hf.co')).toThrow(/Not a Hugging Face repo/);
  });
});

describe('pickBuild', () => {
  it('defaults to Q4_K_M and matches tags case-insensitively', () => {
    const builds = detail().builds;
    expect(pickBuild(builds, null)?.quant).toBe('Q4_K_M');
    expect(pickBuild(builds, 'q8_0')?.quant).toBe('Q8_0');
    expect(pickBuild(builds, 'F16')?.split).toBe(true);
    expect(pickBuild(builds, 'IQ2_XS')).toBeUndefined();
  });

  it('reads latest, the tag Ollama gives an untagged hf.co pull, as the default build', () => {
    expect(pickBuild(detail().builds, 'latest')?.quant).toBe('Q4_K_M');
    expect(pickBuild(detail().builds, 'LATEST')?.quant).toBe('Q4_K_M');
  });
});

describe('licenseFor', () => {
  it('treats permissive OSI licenses as unrestricted', () => {
    expect(licenseFor(detail(), ENDPOINT)).toEqual({
      label: 'apache-2.0',
      link: `${ENDPOINT}/${REPO}`,
      restricted: false,
      plural: false,
    });
  });

  it('names a custom license and resolves a relative link against the repo', () => {
    const info = licenseFor(
      detail({ licenses: ['other'], licenseName: 'qwen-research', licenseLink: 'LICENSE' }),
      ENDPOINT
    );
    expect(info).toEqual({
      label: 'qwen-research',
      link: `${ENDPOINT}/${REPO}/blob/main/LICENSE`,
      restricted: true,
      plural: false,
    });
  });

  it('treats a missing license as restricted', () => {
    expect(licenseFor(detail({ licenses: [] }), ENDPOINT)).toMatchObject({ label: 'none declared', restricted: true });
  });

  it('treats a card that only names its license, or passes the cap, as restricted', () => {
    expect(licenseFor(detail({ licenses: ['other'], licenseName: 'my-terms' }), ENDPOINT)).toMatchObject({
      label: 'my-terms',
      restricted: true,
    });
    expect(licenseFor(detail({ licenses: ['mit', 'other'] }), ENDPOINT)).toMatchObject({
      label: 'mit, other',
      restricted: true,
    });
  });

  it('is permissive only when every declared license is', () => {
    expect(licenseFor(detail({ licenses: ['apache-2.0', 'mit'] }), ENDPOINT)).toMatchObject({
      label: 'apache-2.0, mit',
      restricted: false,
    });
    expect(licenseFor(detail({ licenses: ['apache-2.0', 'gemma'] }), ENDPOINT)).toMatchObject({
      label: 'apache-2.0, gemma',
      restricted: true,
    });
  });
});

describe('models ls', () => {
  it('lists installed models with size, quant, capabilities and markers', async () => {
    const h = harness({ config: { defaultModel: 'smollm2:135m' } });
    expect(await runModelsCommand('ls', { _: [] }, h.deps)).toBe(0);
    expect(h.lines[0]).toBe('Ollama at http://127.0.0.1:11500');
    expect(h.lines[1]).toMatch(/^NAME\s+SIZE\s+QUANT\s+CAPABILITIES$/);
    expect(h.lines[2]).toMatch(/^qwen2\.5:0\.5b\s+398 MB\s+Q4_K_M\s+tools, completion\s+loaded$/);
    expect(h.lines[3]).toMatch(/^smollm2:135m\s+398 MB\s+Q4_K_M\s+completion\s+default$/);
  });

  it('prints JSON with --output-format json', async () => {
    const h = harness({ source: 'detected' });
    await runModelsCommand('ls', { _: [], 'output-format': 'json' }, h.deps);
    const parsed = JSON.parse(h.lines.join('\n'));
    expect(parsed.runtime).toEqual({ kind: 'ollama', baseUrl: 'http://127.0.0.1:11500', source: 'detected' });
    expect(parsed.models[0]).toMatchObject({ name: 'qwen2.5:0.5b', loaded: true, default: false });
  });

  it('points at search when nothing is installed', async () => {
    const h = harness({ runtime: fakeRuntime({ list: vi.fn().mockResolvedValue([]) }) });
    await runModelsCommand('list', { _: [] }, h.deps);
    expect(h.lines[1]).toMatch(/No models installed/);
  });

  it('reports a loaded-model lookup failure instead of marking every model unloaded', async () => {
    const runtime = fakeRuntime({ loaded: vi.fn().mockRejectedValue(new Error('Ollama /api/ps returned 503')) });
    const h = harness({ runtime });
    await expect(runModelsCommand('ls', { _: [], 'output-format': 'json' }, h.deps)).rejects.toThrow(
      'Ollama /api/ps returned 503'
    );
    expect(h.lines).toEqual([]);
  });
});

describe('models search', () => {
  it('shows downloads, likes, license and gated status', async () => {
    const h = harness();
    await runModelsCommand('search', { _: [], query: ['qwen2.5', '0.5b'] }, h.deps);
    expect(h.hub.search).toHaveBeenCalledWith(expect.objectContaining({ query: 'qwen2.5 0.5b', limit: 20 }));
    expect(h.lines[0]).toMatch(/^REPO\s+DOWNLOADS\s+LIKES\s+LICENSE\s+GATED$/);
    expect(h.lines[1]).toMatch(/^Qwen\/Qwen2\.5-0\.5B-Instruct-GGUF\s+123\.5k\s+200\s+apache-2\.0, mit\s+no$/);
    expect(h.lines[2]).toMatch(/llama3\.2\s+yes \(manual approval\)$/);
  });

  it('prints the page as JSON', async () => {
    const h = harness();
    await runModelsCommand('search', { _: [], query: 'qwen', 'output-format': 'json' }, h.deps);
    const { models } = JSON.parse(h.lines.join('\n'));
    expect(models).toHaveLength(2);
    expect(models[0].licenses).toEqual(['apache-2.0', 'mit']);
  });

  it('requires a query', async () => {
    await expect(runModelsCommand('search', { _: [], query: [] }, harness().deps)).rejects.toThrow(/Usage/);
  });

  describe('abliterated builds', () => {
    const hit = (id: string, tags: string[] = []) => ({
      id,
      author: null,
      downloads: 10,
      likes: 1,
      updatedAt: null,
      pipelineTag: null,
      gated: false as const,
      private: false,
      licenses: ['apache-2.0'],
      baseModels: [],
      tags,
    });
    const hubWith = () =>
      harness({
        hub: fakeHub({
          search: vi.fn().mockResolvedValue({
            models: [
              hit('someone/Qwen3-8B-heretic-GGUF'),
              hit('Qwen/Qwen3-8B-GGUF'),
              hit('someone/Plain-GGUF', ['abliterated']),
              hit('meta/Llama-3-8B-GGUF'),
            ],
            nextCursor: null,
          }),
        }),
      });

    it('hides them by default and prints how many were left out', async () => {
      const h = hubWith();
      await runModelsCommand('search', { _: [], query: 'qwen' }, h.deps);
      const text = h.lines.join('\n');
      expect(text).not.toMatch(/heretic|Plain-GGUF/);
      expect(h.lines.filter(line => /^(Qwen|meta)\//.test(line))).toHaveLength(2);
      expect(text).toContain('2 abliterated or uncensored builds were left out. Show them with --include-abliterated.');
    });

    it('lists them last and labelled with --include-abliterated', async () => {
      const h = hubWith();
      await runModelsCommand('search', { _: [], query: 'qwen', 'include-abliterated': true }, h.deps);
      const repos = h.lines.filter(line => /GGUF/.test(line)).map(line => line.split(/\s+/)[0]);
      expect(repos).toEqual([
        'Qwen/Qwen3-8B-GGUF',
        'meta/Llama-3-8B-GGUF',
        'someone/Qwen3-8B-heretic-GGUF',
        'someone/Plain-GGUF',
      ]);
      expect(h.lines.filter(line => /not recommended: abliterated or uncensored build$/.test(line))).toHaveLength(2);
      expect(h.lines.join('\n')).not.toMatch(/left out/);
    });

    it('marks them in JSON and reports the hidden count', async () => {
      const hidden = hubWith();
      await runModelsCommand('search', { _: [], query: 'qwen', 'output-format': 'json' }, hidden.deps);
      const page = JSON.parse(hidden.lines.join('\n'));
      expect(page.models.map((model: { id: string }) => model.id)).toEqual([
        'Qwen/Qwen3-8B-GGUF',
        'meta/Llama-3-8B-GGUF',
      ]);
      expect(page.hidden).toBe('2 abliterated or uncensored builds were left out.');

      const shown = hubWith();
      await runModelsCommand(
        'search',
        { _: [], query: 'qwen', 'output-format': 'json', 'include-abliterated': true },
        shown.deps
      );
      const all = JSON.parse(shown.lines.join('\n'));
      expect(all.models.map((model: { notRecommended?: string }) => model.notRecommended)).toEqual([
        undefined,
        undefined,
        'abliterated or uncensored build',
        'abliterated or uncensored build',
      ]);
      expect(all.hidden).toBeUndefined();
    });

    it('still says so when every match is hidden', async () => {
      const h = harness({
        hub: fakeHub({
          search: vi.fn().mockResolvedValue({ models: [hit('someone/X-Uncensored-GGUF')], nextCursor: null }),
        }),
      });
      await runModelsCommand('search', { _: [], query: 'x' }, h.deps);
      expect(h.lines[0]).toMatch(/No GGUF models on Hugging Face match "x"/);
      expect(h.lines.join('\n')).toContain('1 abliterated or uncensored build was left out.');
    });

    it('cautions on a flagged repo in show', async () => {
      const h = harness({
        hub: fakeHub({ getModel: vi.fn().mockResolvedValue(detail({ id: 'someone/Qwen-abliterated-GGUF' })) }),
      });
      await runModelsCommand('show', { _: [], repo: 'someone/Qwen-abliterated-GGUF' }, h.deps);
      expect(h.lines.join('\n')).toContain('Caution:   not recommended: abliterated or uncensored build');
    });
  });
});

describe('models show', () => {
  it('suggests a pullable build when the default quant is split into shards', async () => {
    const model = detail({
      builds: [
        build('Q4_K_M', 491_400_032, { split: true, ollamaRef: null, ollamaRefIssue: 'split' }),
        build('Q8_0', 675_710_816),
      ],
    });
    const h = harness({ hub: fakeHub({ getModel: vi.fn().mockResolvedValue(model) }) });
    await runModelsCommand('show', { _: [], repo: REPO }, h.deps);
    expect(h.lines).toContain(`Pull one with: b4m models pull ${REPO}:Q8_0`);
    expect(h.lines).not.toContain(`Pull one with: b4m models pull ${REPO}:Q4_K_M`);
  });

  it('omits the pull suggestion when every build is unsupported', async () => {
    const model = detail({
      builds: [build('Q4_K_M', 491_400_032, { split: true, ollamaRef: null, ollamaRefIssue: 'split' })],
    });
    const h = harness({ hub: fakeHub({ getModel: vi.fn().mockResolvedValue(model) }) });
    await runModelsCommand('show', { _: [], repo: REPO }, h.deps);
    expect(h.lines.some(line => line.startsWith('Pull one with:'))).toBe(false);
  });

  it('lists builds with refs or the reason there is none', async () => {
    const h = harness();
    await runModelsCommand('show', { _: [], repo: REPO }, h.deps);
    const text = h.lines.join('\n');
    expect(text).toMatch(/License: {3}apache-2\.0\n/);
    expect(text).toMatch(/Gated: {5}no/);
    expect(text).toMatch(/Q4_K_M\s+491 MB\s+fits\s+hf\.co\/Qwen\/Qwen2\.5-0\.5B-Instruct-GGUF:Q4_K_M/);
    expect(text).toMatch(/F16\s+1\.2 GB\s+fits\s+none: split into shards/);
    expect(text).toMatch(/Pull one with: b4m models pull Qwen\/Qwen2\.5-0\.5B-Instruct-GGUF:Q4_K_M/);
  });

  it('shows builds that share a quant under their own labels, and pulls each by its label', async () => {
    const qad = build('Q4_0', 219_312_832, {
      id: 'LFM2.5-350M-QAD-Q4_0',
      label: 'QAD-Q4_0',
      ollamaRef: `hf.co/${REPO}:QAD-Q4_0`,
    });
    const builds = [build('Q4_0', 219_309_792), qad, build('Q4_K_M', 229_312_224)];
    const h = harness({ hub: fakeHub({ getModel: vi.fn().mockResolvedValue(detail({ builds })) }) });
    await runModelsCommand('show', { _: [], repo: REPO }, h.deps);
    const text = h.lines.join('\n');
    expect(text).toMatch(/\n {2}Q4_0 {6}219 MB\s+\S+\s+hf\.co\/\S+:Q4_0\n/);
    expect(text).toMatch(/\n {2}BUILD\s+SIZE\s+FIT\s+OLLAMA REF\n/);
    expect(text).toMatch(/\n {2}QAD-Q4_0 {2}219 MB\s+\S+\s+hf\.co\/\S+:QAD-Q4_0\n/);
    expect(pickBuild(builds, 'qad-q4_0')).toBe(qad);
    expect(pickBuild(builds, 'Q4_0')).toBe(builds[0]);
    expect(pickBuild([{ ...qad, ollamaRef: null, ollamaRefIssue: 'ambiguous' }], 'QAD-Q4_0')?.id).toBe(qad.id);
  });

  it('lists a build with an unsupported quant as not pullable with the reason', async () => {
    const hub = fakeHub({
      getModel: vi.fn().mockResolvedValue(
        detail({
          builds: [build('Q4_K_L', 500_000_000, { ollamaRef: null, ollamaRefIssue: 'unsupported-quant' })],
        })
      ),
    });
    const h = harness({ hub });
    await runModelsCommand('show', { _: [], repo: REPO }, h.deps);
    expect(h.lines.join('\n')).toMatch(
      /Q4_K_L\s+500 MB\s+fits\s+none: Ollama cannot pull this quant from Hugging Face/
    );
  });

  describe('fit', () => {
    const sized = detail({
      gguf: { architecture: 'qwen2', contextLength: 131072, parameterCount: 72_000_000_000 },
      builds: [build('Q4_K_M', 20_000_000_000), build('Q6_K', 47_000_000_000), build('Q8_0', 77_000_000_000)],
    });

    it('rates each build for this machine at the context the CLI requests', async () => {
      const h = harness({
        hub: fakeHub({ getModel: vi.fn().mockResolvedValue(sized) }),
        machine: async () => ({ hardware: cpuMachine(64) }),
      });
      await runModelsCommand('show', { _: [], repo: REPO }, h.deps);
      const text = h.lines.join('\n');
      expect(text).toMatch(/BUILD\s+SIZE\s+FIT\s+OLLAMA REF/);
      expect(text).toMatch(/Q4_K_M\s+20\.0 GB\s+fits\s/);
      expect(text).toMatch(/Q6_K\s+47\.0 GB\s+tight\s/);
      expect(text).toMatch(/Q8_0\s+77\.0 GB\s+too large\s/);
      expect(text).toContain("Fit is a rough estimate from each file's size for this machine (no GPU, 68.7 GB RAM)");
    });

    it('adds the fit to each build in JSON', async () => {
      const h = harness({ hub: fakeHub({ getModel: vi.fn().mockResolvedValue(sized) }) });
      await runModelsCommand('show', { _: [], repo: REPO, 'output-format': 'json' }, h.deps);
      const builds = JSON.parse(h.lines.join('\n')).builds as Array<{ quant: string; fit: { verdict: string } }>;
      expect(builds.map(entry => [entry.quant, entry.fit.verdict])).toEqual([
        ['Q4_K_M', 'fits'],
        ['Q6_K', 'tight'],
        ['Q8_0', 'too-large'],
      ]);
    });

    it('says the fit is unknown for an Ollama on another machine', async () => {
      const h = harness({
        hub: fakeHub({ getModel: vi.fn().mockResolvedValue(sized) }),
        machine: machineReader(async () => cpuMachine(64)),
        runtimeHost: 'http://gpu-box:11434',
      });
      await runModelsCommand('show', { _: [], repo: REPO }, h.deps);
      const text = h.lines.join('\n');
      expect(text).toMatch(/Q8_0\s+77\.0 GB\s+unknown\s/);
      expect(text).toContain('Fit is unknown. Ollama at http://gpu-box:11434 runs on another machine');
    });

    it.each(['weights', 'projector', 'shard'] as const)(
      'keeps an unknown %s size unknown in show and pull',
      async missing => {
        const weights = build('Q4_K_M', missing === 'weights' ? 0 : 491_400_032);
        if (missing === 'shard') weights.files.push({ ...weights.files[0], path: 'other.gguf', sizeBytes: 0 });
        const model = detail({
          builds: [weights],
          projectors: [
            {
              ...weights.files[0],
              path: 'mmproj.gguf',
              sizeBytes: missing === 'projector' ? 0 : 500_000_000,
              quant: 'F16',
            },
          ],
        });
        const h = harness({ hub: fakeHub({ getModel: vi.fn().mockResolvedValue(model) }), answers: [true] });
        await runModelsCommand('show', { _: [], repo: REPO, 'output-format': 'json' }, h.deps);
        expect(JSON.parse(h.lines[0]).builds[0].fit.verdict).toBe('unknown');
        await runModelsCommand('pull', { _: [], ref: REPO }, h.deps);
        expect(h.lines).toContain('Fit:      unknown. The download size is unknown.');
        expect(h.runtime.pull).toHaveBeenCalled();
      }
    );
  });

  it('explains how to get access to a gated repo', async () => {
    const hub = fakeHub({ getModel: vi.fn().mockResolvedValue(detail({ gated: 'manual', canDownload: false })) });
    const h = harness({ hub });
    await runModelsCommand('show', { _: [], repo: REPO }, h.deps);
    const text = h.lines.join('\n');
    expect(text).toMatch(/is gated/);
    expect(text).toMatch(/Request access at https:\/\/huggingface\.co\/Qwen/);
    expect(text).toMatch(/HF_TOKEN/);
  });

  it('shows the license link for a restricted license', async () => {
    const hub = fakeHub({
      getModel: vi
        .fn()
        .mockResolvedValue(detail({ licenses: ['llama3.2'], licenseLink: 'https://example.com/license' })),
    });
    const h = harness({ hub });
    await runModelsCommand('show', { _: [], repo: REPO }, h.deps);
    expect(h.lines).toContain('  License:   llama3.2 (https://example.com/license)');
  });
});

describe('models curated', () => {
  const bundled = () => structuredClone(loadCuratedManifest(() => {}));
  const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const offline = () => {
    const resolveRuntime = vi.fn<ModelsDeps['resolveRuntime']>().mockRejectedValue(new Error('no runtime'));
    const getModel = vi.fn();
    return { resolveRuntime, getModel, h: harness({ resolveRuntime, hub: fakeHub({ getModel }) }) };
  };

  it("lists this computer's picks in slot order, then every build, without contacting a runtime", async () => {
    const { resolveRuntime, getModel, h } = offline();
    expect(await runModelsCommand('curated', { _: [] }, h.deps)).toBe(0);
    expect(resolveRuntime).not.toHaveBeenCalled();
    expect(getModel).not.toHaveBeenCalled();
    expect(h.registry).not.toHaveBeenCalled();

    const manifest = bundled();
    const { tier, picks } = curatedPicks(manifest, machine());
    expect(tier).not.toBeNull();
    expect(h.lines[0]).toBe(
      `Curated list from ${manifest.updatedAt.slice(0, 10)}. This computer has 64 GiB of RAM and 24 GiB of GPU ` +
        'memory (Test GPU).'
    );
    expect(h.lines).toContain(`For this computer (${tier?.minGiB} GiB+ GPU memory):`);
    const pickStart = h.lines.findIndex(line => line.startsWith('  SLOT'));
    expect(h.lines[pickStart]).toMatch(/^ {2}SLOT\s+MODEL\s+REF\s+SIZE\s+LICENSE\s+TAGS$/);
    picks.forEach(({ pick, entry, build }, index) => {
      const ref = escape(curatedSource(build).ollamaRef);
      const slot = { best: 'Best', fast: 'Fast', 'long-context': 'Long context', light: 'Light' }[pick.slot];
      expect(h.lines[pickStart + 1 + index]).toMatch(
        new RegExp(
          `^ {2}${escape(slot)}\\s+${escape(entry.name)}\\s+${ref}\\s+[\\d.]+ (GB|MB)\\s+${escape(entry.license.id)}\\s+`
        )
      );
    });

    const allStart = h.lines.indexOf('All curated models, smallest first:');
    expect(h.lines[allStart + 1]).toMatch(/^ {2}MODEL\s+PARAMS\s+REF\s+SIZE\s+LICENSE\s+TAGS$/);
    const rows = curatedListing(manifest).flatMap(({ builds }) =>
      builds.map(build => curatedSource(build)).sort((a, b) => a.sizeBytes - b.sizeBytes)
    );
    expect(rows.length).toBeGreaterThan(0);
    rows.forEach(({ ollamaRef }, index) => expect(h.lines[allStart + 2 + index]).toContain(ollamaRef));
    expect(h.lines[h.lines.length - 1]).toBe(
      `Pull one with: b4m models pull ${curatedSource(picks[0].build).ollamaRef} ` +
        '(pull does not check the build against the reviewed one)'
    );
  });

  it('lists the builds of one entry smallest first, with the Ollama each needs', async () => {
    const manifest = bundled();
    const { entry, builds } = curatedListing(manifest).find(listed => listed.builds.length > 1) ?? {};
    if (!entry || !builds) throw new Error('expected an entry with several builds');
    builds[0].runtimeMin = { ollama: '9.8.7' };
    const { h } = offline();
    await runModelsCommand('curated', { _: [] }, { ...h.deps, curated: () => manifest });
    const allStart = h.lines.indexOf('All curated models, smallest first:');
    const rows = h.lines.slice(allStart).filter(line => line.startsWith(`  ${entry.name} `));
    const expected = [...builds].sort((a, b) => curatedSource(a).sizeBytes - curatedSource(b).sizeBytes);
    expect(rows.map(row => expected.findIndex(build => row.includes(curatedSource(build).ollamaRef)))).toEqual(
      expected.map((_, index) => index)
    );
    const row = rows.find(line => line.includes(curatedSource(builds[0]).ollamaRef));
    expect(row).toMatch(/, needs Ollama >= 9\.8\.7$/);
  });

  it('notes that the picks are for this computer when the saved Ollama host is elsewhere', async () => {
    const remote = harness({ config: { ollamaHost: 'http://192.0.2.10:11434' } });
    await runModelsCommand('curated', { _: [] }, remote.deps);
    expect(remote.lines).toContain('The picks are for this computer, not the Ollama host at http://192.0.2.10:11434.');
    for (const host of ['http://127.0.0.1:11434', 'localhost:11434', 'http://[::1]:11434']) {
      const local = harness({ config: { ollamaHost: host } });
      await runModelsCommand('curated', { _: [] }, local.deps);
      expect(local.lines.some(line => line.startsWith('The picks are for this computer'))).toBe(false);
    }
  });

  it('flags a restricted base model license in the listing and the JSON', async () => {
    const manifest = bundled();
    const [entry] = manifest.entries;
    entry.license.base.class = 'restricted-commercial';
    entry.license.base.id = 'llama3.1';
    const { h } = offline();
    await runModelsCommand('curated', { _: [] }, { ...h.deps, curated: () => manifest });
    expect(h.lines.join('\n')).toMatch(
      new RegExp(`${escape(entry.name)}.*restricted: ${escape(entry.license.id)} \\(base: llama3\\.1\\)`)
    );
    expect(h.lines).toContain(
      'A restricted license is not a permissive open-source license; pull asks you to accept it first.'
    );

    const json = harness();
    await runModelsCommand('curated', { _: [], 'output-format': 'json' }, { ...json.deps, curated: () => manifest });
    const listed = JSON.parse(json.lines.join('\n')).entries.find((item: { id: string }) => item.id === entry.id);
    expect(listed.license).toMatchObject({
      id: entry.license.id,
      kind: 'restricted',
      base: { id: 'llama3.1', permissive: false },
    });
  });

  it('asks to accept the license before pulling a curated ref whose base license is restricted', async () => {
    const manifest = bundled();
    const [entry] = manifest.entries;
    const ref = curatedSource(entry.builds[0]).ollamaRef;
    entry.license.base.class = 'restricted-commercial';
    entry.license.base.id = 'llama3.1';

    const scripted = harness({ isTTY: false, curated: () => manifest });
    await expect(runModelsCommand('pull', { _: [], ref, yes: true }, scripted.deps)).rejects.toThrow(
      /--accept-license/
    );
    expect(scripted.lines).toContain('License:  Apache-2.0 (base: llama3.1)');
    expect(scripted.runtime.pull).not.toHaveBeenCalled();

    const asked = harness({ answers: [true, true], curated: () => manifest });
    expect(await runModelsCommand('pull', { _: [], ref }, asked.deps)).toBe(0);
    expect(asked.questions[0]).toBe('Do you accept the Apache-2.0 and base model llama3.1 licenses? [y/N] ');
    expect(asked.runtime.pull).toHaveBeenCalledWith(ref, expect.anything());

    const permissive = harness({ answers: [true] });
    expect(await runModelsCommand('pull', { _: [], ref }, permissive.deps)).toBe(0);
    expect(permissive.questions).toEqual([expect.stringMatching(/^Download .*\? \[y\/N\] $/)]);
  });

  it("names the list's license when it is restricted but the registry's text reads permissive", async () => {
    const manifest = bundled();
    const [entry] = manifest.entries;
    const ref = curatedSource(entry.builds[0]).ollamaRef;
    entry.license.class = 'restricted-commercial';
    entry.license.id = 'gemma';

    const asked = harness({ answers: [true, true], curated: () => manifest });
    expect(await runModelsCommand('pull', { _: [], ref }, asked.deps)).toBe(0);
    expect(asked.lines).toContain('License:  Apache-2.0');
    expect(asked.lines).toContain(
      'This model is under the gemma license, which is not a permissive open-source license.'
    );
    expect(asked.questions[0]).toBe('Do you accept the gemma license? [y/N] ');
  });

  it('tags tool support from the catalog', async () => {
    const manifest = bundled();
    const [first, second] = manifest.entries;
    first.toolUse = { rating: 'strong' };
    second.capabilities.tools = false;
    second.toolUse = { rating: 'unrated' };
    const { h } = offline();
    await runModelsCommand('curated', { _: [] }, { ...h.deps, curated: () => manifest });
    const rowOf = (name: string) => h.lines.filter(line => line.includes(name)).pop();
    expect(rowOf(first.name)).toMatch(/tools: strong, needs Ollama >= \d+\.\d+\.\d+$/);
    expect(rowOf(second.name)).toMatch(/no tools, needs Ollama >= \d+\.\d+\.\d+$/);
  });

  it('flags a restricted license and never lists an abliterated entry', async () => {
    const manifest = bundled();
    const [restricted, abliterated] = manifest.entries;
    restricted.license.class = 'restricted-commercial';
    abliterated.flags.abliterated = true;
    const { h } = offline();
    await runModelsCommand('curated', { _: [] }, { ...h.deps, curated: () => manifest });
    const text = h.lines.join('\n');
    expect(text).toMatch(new RegExp(`${escape(restricted.name)}.*restricted: ${escape(restricted.license.id)}`));
    expect(text).toContain('pull asks you to accept it first');
    expect(text).not.toContain(abliterated.name);
    for (const build of abliterated.builds) expect(text).not.toContain(curatedSource(build).ollamaRef);
  });

  it('says so when the list has no picks for this computer', async () => {
    const manifest = bundled();
    manifest.tiers = [];
    const { h } = offline();
    await runModelsCommand('curated', { _: [] }, { ...h.deps, curated: () => manifest });
    expect(h.lines).toContain("For this computer: the list has no picks for this computer's memory yet.");
    expect(h.lines).toContain('All curated models, smallest first:');
    const [smallest] = curatedListing(manifest)[0]
      .builds.map(curatedSource)
      .sort((a, b) => a.sizeBytes - b.sizeBytes);
    expect(h.lines[h.lines.length - 1]).toBe(
      `Pull one with: b4m models pull ${smallest.ollamaRef} (pull does not check the build against the reviewed one)`
    );
  });

  it('describes a CPU-only machine', async () => {
    const h = harness({ hardware: async () => machine({ gpuMemoryBytes: null, gpuName: null }) });
    await runModelsCommand('curated', { _: [] }, h.deps);
    expect(h.lines[0]).toMatch(/64 GiB of RAM and no GPU memory was detected, so its picks assume the CPU\.$/);
    expect(h.lines).toContain('For this computer (CPU only):');
  });

  it('prints the picks and entries as JSON', async () => {
    const { h } = offline();
    await runModelsCommand('curated', { _: [], 'output-format': 'json' }, h.deps);
    const out = JSON.parse(h.lines.join('\n'));
    const manifest = bundled();
    const { picks } = curatedPicks(manifest, machine());
    expect(out.updatedAt).toBe(manifest.updatedAt);
    expect(out.machine).toEqual({
      memoryKind: 'discrete',
      totalMemoryBytes: 64 * GIB,
      gpuMemoryBytes: 24 * GIB,
      gpuName: 'Test GPU',
    });
    expect(out.tier).toEqual({ memoryKind: 'discrete', minGiB: 24 });
    expect(out.picks.map((pick: { slot: string; build: { ref: string } }) => [pick.slot, pick.build.ref])).toEqual(
      picks.map(({ pick, build }) => [pick.slot, curatedSource(build).ollamaRef])
    );
    expect(out.entries).toHaveLength(curatedListing(manifest).length);
    const [entry] = out.entries;
    expect(entry).toMatchObject({ license: { kind: 'permissive' }, toolUse: { rating: expect.any(String) } });
    expect(entry.builds[0]).toMatchObject({
      ref: expect.any(String),
      sizeBytes: expect.any(Number),
      ollamaMin: expect.stringMatching(/^\d+\.\d+\.\d+$/),
    });
  });
});

describe('models pull (Hugging Face)', () => {
  it('shows size and license, asks, verifies the ref, then pulls with progress', async () => {
    const h = harness({ answers: [true] });
    expect(await runModelsCommand('pull', { _: [], ref: REPO }, h.deps)).toBe(0);
    expect(h.lines).toContain('Size:     491 MB');
    expect(h.lines).toContain('License:  apache-2.0');
    expect(h.questions).toEqual(['Download 491 MB? [y/N] ']);
    expect(h.hub.verifyOllamaRef).toHaveBeenCalledTimes(1);
    expect(h.runtime.pull).toHaveBeenCalledWith(
      `hf.co/${REPO}:Q4_K_M`,
      expect.objectContaining({ signal: h.deps.signal })
    );
    const verifyOrder = vi.mocked(h.hub.verifyOllamaRef).mock.invocationCallOrder[0];
    const pullOrder = vi.mocked(h.runtime.pull).mock.invocationCallOrder[0];
    expect(verifyOrder).toBeLessThan(pullOrder);
    expect(h.progress).toEqual([
      'pulling manifest',
      'pulling abc123  0%  0 B / 400 B',
      'pulling def456  25%  100 B / 400 B',
      'success',
      '<end>',
    ]);
    expect(h.lines.some(line => line.startsWith('Already downloaded'))).toBe(false);
    expect(h.lines[h.lines.length - 1]).toMatch(/^Pulled hf\.co\/Qwen\/Qwen2\.5-0\.5B-Instruct-GGUF:Q4_K_M\./);
  });

  it('re-reads the licenses after the prompt and refuses when they changed', async () => {
    const getModel = vi
      .fn()
      .mockResolvedValueOnce(detail())
      .mockResolvedValueOnce(detail({ licenses: ['gemma'] }));
    const h = harness({ hub: fakeHub({ getModel }), answers: [true] });
    await expect(pullModel(REPO, h.deps, OPTS)).rejects.toThrow(
      /changed since you reviewed it \(its license is now gemma\), so nothing was downloaded/
    );
    expect(getModel).toHaveBeenCalledTimes(2);
    expect(h.questions).toEqual(['Download 491 MB? [y/N] ']);
    expect(h.hub.verifyOllamaRef).not.toHaveBeenCalled();
    expect(h.runtime.pull).not.toHaveBeenCalled();

    const same = harness({ answers: [true] });
    expect(await pullModel(REPO, same.deps, OPTS)).toBe('pulled');
    expect(same.hub.getModel).toHaveBeenCalledTimes(2);
  });

  it('pulls when the Hub lists the same license IDs in another order after the prompt', async () => {
    const getModel = vi
      .fn()
      .mockResolvedValueOnce(detail({ licenses: ['apache-2.0', 'mit'] }))
      .mockResolvedValueOnce(detail({ licenses: ['mit', 'apache-2.0'] }));
    const h = harness({ hub: fakeHub({ getModel }), answers: [true] });
    expect(await pullModel(REPO, h.deps, OPTS)).toBe('pulled');
    expect(h.runtime.pull).toHaveBeenCalled();
  });

  it.each([
    ['added', ['apache-2.0', 'mit'], ['apache-2.0', 'mit', 'gemma']],
    ['removed', ['apache-2.0', 'mit'], ['mit']],
    ['duplicated', ['mit'], ['mit', 'mit']],
    ['duplicated in place of another', ['apache-2.0', 'apache-2.0', 'mit'], ['apache-2.0', 'mit', 'mit']],
  ])('refuses when a license ID was %s after the prompt', async (_label, before, licenses) => {
    const getModel = vi
      .fn()
      .mockResolvedValueOnce(detail({ licenses: before }))
      .mockResolvedValueOnce(detail({ licenses }));
    const h = harness({ hub: fakeHub({ getModel }), answers: [true] });
    await expect(pullModel(REPO, h.deps, OPTS)).rejects.toThrow(/changed since you reviewed it/);
    expect(h.runtime.pull).not.toHaveBeenCalled();
  });

  it('refuses changed license IDs even when their display is unchanged', async () => {
    const original = detail({ licenses: ['mit'] });
    const current = detail({ licenses: ['other'], licenseName: 'mit' });
    expect(licenseFor(current, ENDPOINT).label).toBe(licenseFor(original, ENDPOINT).label);
    const getModel = vi.fn().mockResolvedValueOnce(original).mockResolvedValueOnce(current);
    const h = harness({ hub: fakeHub({ getModel }), answers: [true] });
    await expect(pullModel(REPO, h.deps, OPTS)).rejects.toThrow(/changed since you reviewed it/);
    expect(h.hub.verifyOllamaRef).not.toHaveBeenCalled();
    expect(h.runtime.pull).not.toHaveBeenCalled();
  });

  it('downloads nothing when the confirmation is declined', async () => {
    const h = harness({ answers: [false] });
    expect(await runModelsCommand('pull', { _: [], ref: `${REPO}:Q8_0` }, h.deps)).toBe(0);
    expect(h.questions).toEqual(['Download 676 MB? [y/N] ']);
    expect(h.hub.verifyOllamaRef).not.toHaveBeenCalled();
    expect(h.runtime.pull).not.toHaveBeenCalled();
    expect(h.lines[h.lines.length - 1]).toBe('Aborted');
  });

  it('skips the prompt with --yes and refuses to guess without a terminal', async () => {
    const yes = harness({ isTTY: false });
    await runModelsCommand('pull', { _: [], ref: REPO, yes: true }, yes.deps);
    expect(yes.questions).toEqual([]);
    expect(yes.runtime.pull).toHaveBeenCalled();

    const noTty = harness({ isTTY: false });
    await expect(runModelsCommand('pull', { _: [], ref: REPO }, noTty.deps)).rejects.toThrow(/--yes/);
    expect(noTty.runtime.pull).not.toHaveBeenCalled();
  });

  it('requires acknowledging a restricted license, even with --yes', async () => {
    const restricted = detail({ licenses: ['other'], licenseName: 'qwen-research', licenseLink: 'LICENSE' });
    const declined = harness({ hub: fakeHub({ getModel: vi.fn().mockResolvedValue(restricted) }), answers: [false] });
    expect(await pullModel(REPO, declined.deps, { ...OPTS, yes: true })).toBe('declined');
    expect(declined.lines).toContain(`Read it before downloading: ${ENDPOINT}/${REPO}/blob/main/LICENSE`);
    expect(declined.questions).toEqual(['Do you accept the qwen-research license? [y/N] ']);
    expect(declined.runtime.pull).not.toHaveBeenCalled();

    const accepted = harness({
      hub: fakeHub({ getModel: vi.fn().mockResolvedValue(restricted) }),
      answers: [true, true],
    });
    expect(await pullModel(REPO, accepted.deps, OPTS)).toBe('pulled');
    expect(accepted.questions).toEqual(['Do you accept the qwen-research license? [y/N] ', 'Download 491 MB? [y/N] ']);

    const flagged = harness({ hub: fakeHub({ getModel: vi.fn().mockResolvedValue(restricted) }), isTTY: false });
    await expect(pullModel(REPO, flagged.deps, { ...OPTS, yes: true })).rejects.toThrow(/--accept-license/);
    expect(await pullModel(REPO, flagged.deps, { ...OPTS, yes: true, acceptLicense: true })).toBe('pulled');
  });

  it('explains gating before asking anything', async () => {
    const hub = fakeHub({ getModel: vi.fn().mockResolvedValue(detail({ gated: 'auto', canDownload: false })) });
    const h = harness({ hub, answers: [true] });
    await expect(runModelsCommand('pull', { _: [], ref: REPO }, h.deps)).rejects.toThrow(
      /is gated[\s\S]*Request access/
    );
    expect(h.questions).toEqual([]);
    expect(h.runtime.pull).not.toHaveBeenCalled();
  });

  it('maps a gated refusal from the Hub to the same explanation', async () => {
    const hub = fakeHub({
      verifyOllamaRef: vi.fn().mockRejectedValue(new HubAccessError('gated', 'huggingface', 403, REPO, 'gated')),
    });
    const h = harness({ hub, answers: [true] });
    await expect(runModelsCommand('pull', { _: [], ref: REPO }, h.deps)).rejects.toThrow(/is gated/);
    expect(h.runtime.pull).not.toHaveBeenCalled();
  });

  it('stops when the registry does not serve the exact file', async () => {
    const h = harness({ hub: fakeHub({ verifyOllamaRef: vi.fn().mockResolvedValue(null) }), answers: [true] });
    await expect(runModelsCommand('pull', { _: [], ref: REPO }, h.deps)).rejects.toThrow(
      /does not serve this exact Q4_K_M file[\s\S]*nothing was downloaded/
    );
    expect(h.runtime.pull).not.toHaveBeenCalled();
  });

  it('refuses builds Ollama cannot pull before asking', async () => {
    const h = harness({ answers: [true] });
    await expect(runModelsCommand('pull', { _: [], ref: `${REPO}:F16` }, h.deps)).rejects.toThrow(/split into shards/);
    expect(h.questions).toEqual([]);
  });

  it('refuses a build with an unsupported quant tag before asking', async () => {
    const hub = fakeHub({
      getModel: vi.fn().mockResolvedValue(
        detail({
          builds: [build('Q4_K_L', 500_000_000, { ollamaRef: null, ollamaRefIssue: 'unsupported-quant' })],
        })
      ),
    });
    const h = harness({ hub, answers: [true] });
    await expect(runModelsCommand('pull', { _: [], ref: `${REPO}:Q4_K_L` }, h.deps)).rejects.toThrow(
      /Ollama cannot pull this quant from Hugging Face/
    );
    expect(h.questions).toEqual([]);
    expect(h.runtime.pull).not.toHaveBeenCalled();
  });

  it('lists the available quants when the requested one is missing', async () => {
    const h = harness();
    await expect(runModelsCommand('pull', { _: [], ref: `${REPO}:IQ2_XS` }, h.deps)).rejects.toThrow(
      /no IQ2_XS build\. Pick one of: Q4_K_M, Q8_0, F16/
    );
  });

  it('aborts cleanly when Ctrl-C arrives mid-pull', async () => {
    const runtime = fakeRuntime({
      pull: vi.fn(
        (_ref: string, opts?: PullOptions) =>
          new Promise<void>((_resolve, reject) => {
            opts?.onProgress?.({ status: 'pulling abc123', completedBytes: 0, totalBytes: 400 });
            opts?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
            h.controller.abort();
          })
      ),
    });
    const h = harness({ runtime, answers: [true] });
    expect(await runModelsCommand('pull', { _: [], ref: REPO }, h.deps)).toBe(EXIT_CANCELLED);
    expect(h.progress).toEqual(['pulling abc123  0%  0 B / 400 B', '<end>']);
    expect(h.lines[h.lines.length - 1]).toMatch(/^Pull cancelled\. Nothing was installed/);
  });

  it('asks when any declared license is restricted and names every one', async () => {
    const mixed = detail({ licenses: ['apache-2.0', 'gemma'] });
    const noTty = harness({ hub: fakeHub({ getModel: vi.fn().mockResolvedValue(mixed) }), isTTY: false });
    await expect(pullModel(REPO, noTty.deps, { ...OPTS, yes: true })).rejects.toThrow(/--accept-license/);
    expect(noTty.lines).toContain(
      'This model is under the apache-2.0, gemma licenses, which are not all permissive open-source licenses.'
    );
    expect(noTty.runtime.pull).not.toHaveBeenCalled();

    const tty = harness({ hub: fakeHub({ getModel: vi.fn().mockResolvedValue(mixed) }), answers: [false] });
    expect(await pullModel(REPO, tty.deps, { ...OPTS, yes: true })).toBe('declined');
    expect(tty.questions).toEqual(['Do you accept the apache-2.0, gemma licenses? [y/N] ']);
  });

  it('does not ask about the license when every declared one is permissive', async () => {
    const both = detail({ licenses: ['apache-2.0', 'mit'] });
    const h = harness({ hub: fakeHub({ getModel: vi.fn().mockResolvedValue(both) }), isTTY: false });
    expect(await pullModel(REPO, h.deps, { ...OPTS, yes: true })).toBe('pulled');
    expect(h.questions).toEqual([]);
  });

  it('asks when no license is declared', async () => {
    const none = detail({ licenses: [] });
    const h = harness({ hub: fakeHub({ getModel: vi.fn().mockResolvedValue(none) }), isTTY: false });
    await expect(pullModel(REPO, h.deps, { ...OPTS, yes: true })).rejects.toThrow(/--accept-license/);
    expect(h.lines).toContain('This model does not declare a license.');
  });

  it('checks the license of a repo spelled with another Hugging Face host form', async () => {
    const gemma = detail({ licenses: ['gemma'] });
    const h = harness({ hub: fakeHub({ getModel: vi.fn().mockResolvedValue(gemma) }), isTTY: false });
    await expect(pullModel(`hf.co:443/${REPO}:Q8_0`, h.deps, { ...OPTS, yes: true })).rejects.toThrow(
      /--accept-license/
    );
    expect(h.runtime.pull).not.toHaveBeenCalled();
    expect(h.hub.getModel).toHaveBeenCalledWith(REPO, expect.anything());
  });

  it('pulls the default build for hf.co/<repo>:latest', async () => {
    const h = harness({ isTTY: false });
    expect(await pullModel(`hf.co/${REPO}:latest`, h.deps, { ...OPTS, yes: true })).toBe('pulled');
    expect(h.runtime.pull).toHaveBeenCalledWith(`hf.co/${REPO}:Q4_K_M`, expect.anything());
  });

  it('reminds that Ollama needs its SSH key on Hugging Face for a gated repo with access', async () => {
    const gated = detail({ gated: 'auto', canDownload: true, ollamaNeedsSshKey: true });
    const h = harness({ hub: fakeHub({ getModel: vi.fn().mockResolvedValue(gated) }), answers: [true] });
    expect(await pullModel(REPO, h.deps, OPTS)).toBe('pulled');
    expect(h.lines.join('\n')).toMatch(/gated repos with its own key[\s\S]*https:\/\/huggingface\.co\/settings\/keys/);
  });

  it('points a gated repo without access at the SSH key settings page', async () => {
    const gated = detail({ gated: 'manual', canDownload: false, ollamaNeedsSshKey: true });
    const h = harness({ hub: fakeHub({ getModel: vi.fn().mockResolvedValue(gated) }) });
    await expect(pullModel(REPO, h.deps, OPTS)).rejects.toThrow(/https:\/\/huggingface\.co\/settings\/keys/);
  });
});

describe('cancelling', () => {
  it('exits 130 when Ctrl-C answers a prompt', async () => {
    const h = harness({
      confirm: async () => {
        throw new CancelledError();
      },
    });
    expect(await runModelsCommand('pull', { _: [], ref: REPO }, h.deps)).toBe(EXIT_CANCELLED);
    expect(h.lines[h.lines.length - 1]).toBe('Cancelled.');
    expect(h.runtime.pull).not.toHaveBeenCalled();
  });

  it('stops waiting on the runtime as soon as Ctrl-C arrives', async () => {
    const h = harness({ resolveRuntime: () => new Promise(() => undefined) });
    const run = runModelsCommand('ls', { _: [] }, h.deps);
    h.controller.abort();
    expect(await run).toBe(EXIT_CANCELLED);
    expect(h.lines).toEqual(['Cancelled.']);
  });

  it('stops waiting on a removal as soon as Ctrl-C arrives', async () => {
    const runtime = fakeRuntime({ remove: vi.fn(() => new Promise<void>(() => undefined)) });
    const h = harness({ runtime });
    const run = runModelsCommand('rm', { _: [], name: 'qwen2.5:0.5b', yes: true }, h.deps);
    await vi.waitFor(() => expect(runtime.remove).toHaveBeenCalled());
    h.controller.abort();
    expect(await run).toBe(EXIT_CANCELLED);
  });

  it('abortable passes values and errors through until the signal aborts', async () => {
    const controller = new AbortController();
    await expect(abortable(Promise.resolve(1), controller.signal)).resolves.toBe(1);
    await expect(abortable(Promise.reject(new Error('boom')), controller.signal)).rejects.toThrow('boom');
    controller.abort();
    await expect(abortable(Promise.resolve(1), controller.signal)).rejects.toBeInstanceOf(CancelledError);
  });
});

describe('confirmOnTerminal', () => {
  const streams = () => ({ input: new PassThrough(), output: new PassThrough() });

  it('reads yes and no', async () => {
    const yes = streams();
    const answer = confirmOnTerminal('Go? ', new AbortController().signal, yes);
    yes.input.write('y\n');
    expect(await answer).toBe(true);

    const no = streams();
    const declined = confirmOnTerminal('Go? ', new AbortController().signal, no);
    no.input.write('\n');
    expect(await declined).toBe(false);
  });

  it('rejects with CancelledError when the run is aborted at the prompt', async () => {
    const controller = new AbortController();
    const answer = confirmOnTerminal('Go? ', controller.signal, streams());
    controller.abort();
    await expect(answer).rejects.toBeInstanceOf(CancelledError);
  });
});

describe('models pull fit check', () => {
  const big = detail({ builds: [build('Q4_K_M', 90_000_000_000)] });

  it('prints the verdict at the context the CLI requests before asking', async () => {
    const h = harness({ answers: [true] });
    expect(await runModelsCommand('pull', { _: [], ref: `${REPO}:Q4_K_M` }, h.deps)).toBe(0);
    const fit = h.lines.find(line => line.startsWith('Fit:'));
    expect(fit).toMatch(/^Fit: {6}fits\. Rough estimate from the file size: about \d+ MB before context memory/);
    expect(fit).toContain('at the 32K context the CLI requests, of the 51.5 GB a model can use in RAM here.');
  });

  it('refuses a too-large build before asking anything unless --force', async () => {
    const h = harness({ hub: fakeHub({ getModel: vi.fn().mockResolvedValue(big) }), answers: [true] });
    await expect(runModelsCommand('pull', { _: [], ref: `${REPO}:Q4_K_M` }, h.deps)).rejects.toThrow(
      `Nothing was downloaded: this build is rated too large for this machine. Pick a smaller quant from: b4m models show ${REPO}, or re-run with --force to download it anyway.`
    );
    expect(h.lines.find(line => line.startsWith('Fit:'))).toMatch(/^Fit: {6}too large\. .*exceeds the 51\.5 GB/);
    expect(h.questions).toEqual([]);
    expect(h.runtime.pull).not.toHaveBeenCalled();
  });

  it('says a refusal counts RAM only when the GPU could not be read', async () => {
    const h = harness({
      hub: fakeHub({ getModel: vi.fn().mockResolvedValue(big) }),
      machine: async () => ({ hardware: { ...cpuMachine(64), confidence: 'low' } }),
      answers: [true],
    });
    await expect(runModelsCommand('pull', { _: [], ref: `${REPO}:Q4_K_M` }, h.deps)).rejects.toThrow(
      'Nothing was downloaded: this build is rated too large from system RAM alone, since the GPU could not be read. If this machine has a GPU that can hold it, re-run with --force to download it anyway.'
    );
    expect(h.runtime.pull).not.toHaveBeenCalled();
  });

  it('pulls a too-large build with --force after the usual prompt', async () => {
    const h = harness({ hub: fakeHub({ getModel: vi.fn().mockResolvedValue(big) }), answers: [true] });
    expect(await runModelsCommand('pull', { _: [], ref: `${REPO}:Q4_K_M`, force: true }, h.deps)).toBe(0);
    expect(h.questions).toEqual(['Download 90.0 GB? [y/N] ']);
    expect(h.runtime.pull).toHaveBeenCalledWith(`hf.co/${REPO}:Q4_K_M`, expect.anything());
  });

  it('never blocks on an unknown fit', async () => {
    const h = harness({
      hub: fakeHub({ getModel: vi.fn().mockResolvedValue(big) }),
      machine: async () => ({ unknown: "This machine's memory could not be read" }),
      answers: [true],
    });
    expect(await runModelsCommand('pull', { _: [], ref: `${REPO}:Q4_K_M` }, h.deps)).toBe(0);
    expect(h.lines).toContain("Fit:      unknown. This machine's memory could not be read.");
    expect(h.runtime.pull).toHaveBeenCalled();
  });

  it('rates an Ollama registry model at up to the cap, since its trained length is unread', async () => {
    const h = harness({ registry: async () => manifestInfo(200_000_000_000, [APACHE]) });
    await expect(runModelsCommand('pull', { _: [], ref: 'huge:latest', yes: true }, h.deps)).rejects.toThrow(
      'Pick a smaller tag, or re-run with --force'
    );
    expect(h.lines.find(line => line.startsWith('Fit:'))).toContain('at up to the 32K context the CLI requests');
    expect(h.runtime.pull).not.toHaveBeenCalled();
  });
});

describe('models pull (Ollama library)', () => {
  it('shows the registry size and license, asks, then pulls the name as given', async () => {
    const h = harness({ answers: [true] });
    expect(await runModelsCommand('pull', { _: [], ref: 'smollm2:135m' }, h.deps)).toBe(0);
    expect(h.registry).toHaveBeenCalledWith('smollm2:135m', h.deps.signal);
    expect(h.lines).toEqual(
      expect.arrayContaining([
        'Size:     271 MB',
        'License:  Apache-2.0',
        'Model:    smollm2:135m (Ollama registry)',
        'Digest:   aaaaaaaaaaaa',
      ])
    );
    expect(h.questions).toEqual(['Download 271 MB? [y/N] ']);
    expect(h.hub.getModel).not.toHaveBeenCalled();
    expect(h.registry).toHaveBeenCalledTimes(2);
    expect(h.registry.mock.invocationCallOrder[1]).toBeLessThan(vi.mocked(h.runtime.pull).mock.invocationCallOrder[0]);
    expect(h.runtime.pull).toHaveBeenCalledWith('smollm2:135m', expect.anything());
  });

  it('refuses when the tag serves other layers or license texts after the prompt', async () => {
    const moved = vi
      .fn<ModelsDeps['ollamaRegistry']>()
      .mockResolvedValueOnce(manifestInfo(270_800_000, [APACHE]))
      .mockResolvedValueOnce(manifestInfo(270_800_000, [APACHE], 'b'));
    const h = harness({ registry: moved, answers: [true] });
    await expect(pullModel('smollm2:135m', h.deps, OPTS)).rejects.toThrow(
      /smollm2:135m changed since you reviewed it \(the registry now serves bbbbbbbbbbbb\), so nothing was downloaded/
    );
    expect(h.runtime.pull).not.toHaveBeenCalled();

    const relicensed = vi
      .fn<ModelsDeps['ollamaRegistry']>()
      .mockResolvedValueOnce(manifestInfo(270_800_000, [APACHE]))
      .mockResolvedValueOnce(manifestInfo(270_800_000, [GEMMA]));
    const r = harness({ registry: relicensed, isTTY: false });
    await expect(pullModel('smollm2:135m', r.deps, { ...OPTS, yes: true })).rejects.toThrow(
      /changed since you reviewed it \(its license text changed\)/
    );
    expect(r.runtime.pull).not.toHaveBeenCalled();
  });

  it('requires accepting a restricted license, even with --yes', async () => {
    const registry = async () => manifestInfo(291_500_000, [GEMMA]);
    const noTty = harness({ registry, isTTY: false });
    await expect(pullModel('gemma3:270m', noTty.deps, { ...OPTS, yes: true })).rejects.toThrow(/--accept-license/);
    expect(noTty.lines).toEqual(
      expect.arrayContaining([
        'License:  Gemma Terms of Use',
        'Read it before downloading: https://ollama.com/library/gemma3',
      ])
    );
    expect(noTty.runtime.pull).not.toHaveBeenCalled();
    expect(await pullModel('gemma3:270m', noTty.deps, { ...OPTS, yes: true, acceptLicense: true })).toBe('pulled');

    const tty = harness({ registry, answers: [false] });
    expect(await pullModel('gemma3:270m', tty.deps, OPTS)).toBe('declined');
    expect(tty.questions).toEqual(['Do you accept the Gemma Terms of Use license? [y/N] ']);
  });

  it('requires accepting Apache-2.0 text with added terms, even with --yes', async () => {
    const addendum = 'ACME ADDENDUM\nCommercial use requires a separate paid agreement with ACME.';
    const licenses = [`${APACHE}\n${addendum}`];
    const h = harness({ registry: async () => manifestInfo(1000, licenses), isTTY: false });
    await expect(pullModel('ollama.com/acme/model:1b', h.deps, { ...OPTS, yes: true })).rejects.toThrow(
      /--accept-license/
    );
    expect(h.runtime.pull).not.toHaveBeenCalled();
  });

  it('suggests a name `use` finds after pulling through a registry host', async () => {
    const onRuntime: InstalledModel[] = [];
    const runtime = fakeRuntime({
      list: vi.fn(async () => onRuntime),
      pull: vi.fn(async (ref: string) => void onRuntime.push(installed(ref))),
    });
    const h = harness({ runtime, isTTY: false, config: { ollamaHost: 'http://127.0.0.1:11500' } });
    expect(await pullModel('registry.ollama.ai/library/smollm2:135m', h.deps, { ...OPTS, yes: true })).toBe('pulled');
    expect(runtime.pull).toHaveBeenCalledWith('smollm2:135m', expect.anything());
    const hint = h.lines.find(line => line.includes('b4m models use '));
    expect(hint).toMatch(/b4m models use smollm2:135m$/);
    expect(await runModelsCommand('use', { _: [], name: 'library/smollm2:135m' }, h.deps)).toBe(0);
    expect(h.saved).toEqual([{ defaultModel: 'smollm2:135m', localDefaultModel: 'smollm2:135m' }]);
  });

  it('treats a model without a license layer as restricted', async () => {
    const h = harness({ registry: async () => manifestInfo(1000, []), answers: [false] });
    expect(await pullModel('ollama.com/someone/model', h.deps, OPTS)).toBe('declined');
    expect(h.lines).toContain('This model does not declare a license.');
    expect(h.lines).toContain('Read its page before downloading: https://ollama.com/someone/model');
    expect(h.questions).toEqual(['Download it anyway? [y/N] ']);
    expect(h.registry).toHaveBeenCalledTimes(1);
  });

  it('downloads nothing when the registry cannot be read', async () => {
    const h = harness({
      registry: async () => {
        throw new Error('The Ollama registry has no model named nope:1b.');
      },
      answers: [true],
    });
    await expect(runModelsCommand('pull', { _: [], ref: 'nope:1b' }, h.deps)).rejects.toThrow(
      /Could not read nope:1b from the Ollama registry, so nothing was downloaded: .*no model named/
    );
    expect(h.questions).toEqual([]);
    expect(h.runtime.pull).not.toHaveBeenCalled();
  });

  it('logs status changes instead of a progress line without a terminal', async () => {
    const h = harness({ isTTY: false });
    await runModelsCommand('pull', { _: [], ref: 'smollm2:135m', yes: true }, h.deps);
    expect(h.progress).toEqual([]);
    expect(h.lines).toEqual(expect.arrayContaining(['pulling manifest', 'pulling abc123', 'success']));
  });

  it('refuses a runtime that cannot pull', async () => {
    const runtime = fakeRuntime({
      kind: 'openai-compatible',
      capabilities: { canPull: false, canRemove: false, canInspect: false, reportsLoaded: false },
    });
    await expect(runModelsCommand('pull', { _: [], ref: 'smollm2:135m' }, harness({ runtime }).deps)).rejects.toThrow(
      /cannot download models/
    );
  });
});

describe('models rm', () => {
  it.each([
    ['qwen2.5', 'qwen2.5:latest', true],
    ['library/qwen2.5', 'qwen2.5:latest', true],
    ['library/qwen2.5:latest', 'qwen2.5:latest', true],
    ['someone/qwen2.5', 'someone/qwen2.5:latest', true],
    ['qwen2.5:0.5b', 'qwen2.5:latest', false],
    ['someone/qwen2.5', 'qwen2.5:latest', false],
    ['qwen2.5', undefined, false],
  ])('warns only when removing the default alias %s (%s)', async (name, defaultModel, warns) => {
    const h = harness({ config: { defaultModel } });
    await runModelsCommand('rm', { _: [], name, yes: true }, h.deps);
    expect(h.runtime.remove).toHaveBeenCalledWith(name);
    expect(h.lines.some(line => line.includes('It was your default model'))).toBe(warns);
  });

  it('removes only after confirmation', async () => {
    const declined = harness({ answers: [false] });
    await runModelsCommand('rm', { _: [], name: 'qwen2.5:0.5b' }, declined.deps);
    expect(declined.questions).toEqual(['Remove qwen2.5:0.5b from Ollama at http://127.0.0.1:11500? [y/N] ']);
    expect(declined.runtime.remove).not.toHaveBeenCalled();
    expect(declined.lines).toEqual(['Aborted']);

    const confirmed = harness({ answers: [true], config: { defaultModel: 'qwen2.5:0.5b' } });
    await runModelsCommand('remove', { _: [], name: 'qwen2.5:0.5b' }, confirmed.deps);
    expect(confirmed.runtime.remove).toHaveBeenCalledWith('qwen2.5:0.5b');
    expect(confirmed.lines).toEqual(['Removed qwen2.5:0.5b.', expect.stringMatching(/It was your default model/)]);
  });

  it.each([
    ['hf.co/acme/m-GGUF:Q4_K_M', 'huggingface.co/acme/m-GGUF:Q4_K_M'],
    ['huggingface.co/acme/m-GGUF:Q4_K_M', 'hf.co/acme/m-GGUF:Q4_K_M'],
  ])('removes %s when it is installed as %s', async (name, listedAs) => {
    const runtime = fakeRuntime({ list: vi.fn().mockResolvedValue([installed(listedAs)]) });
    const h = harness({ runtime, config: { defaultModel: listedAs } });
    await runModelsCommand('rm', { _: [], name, yes: true }, h.deps);
    expect(runtime.remove).toHaveBeenCalledWith(listedAs);
    expect(h.lines.some(line => line.includes('It was your default model'))).toBe(true);
  });

  it('reports a missing model', async () => {
    const runtime = fakeRuntime({ remove: vi.fn().mockRejectedValue(new ModelNotFoundError('ollama', 'nope')) });
    await expect(runModelsCommand('rm', { _: [], name: 'nope', yes: true }, harness({ runtime }).deps)).rejects.toThrow(
      /No model named nope/
    );
  });
});

describe('models use', () => {
  it('saves the model and the host it lives on', async () => {
    const h = harness({ source: 'detected' });
    expect(await runModelsCommand('use', { _: [], name: 'qwen2.5:0.5b' }, h.deps)).toBe(0);
    expect(h.saved).toEqual([
      { defaultModel: 'qwen2.5:0.5b', localDefaultModel: 'qwen2.5:0.5b', ollamaHost: 'http://127.0.0.1:11500' },
    ]);
    expect(h.lines[0]).toBe('Default model: qwen2.5:0.5b on Ollama at http://127.0.0.1:11500');
  });

  it('keeps an already saved host and accepts a name without :latest', async () => {
    const runtime = fakeRuntime({ list: vi.fn().mockResolvedValue([installed('llama3:latest')]) });
    const h = harness({ runtime, config: { ollamaHost: 'http://127.0.0.1:11500' } });
    await runModelsCommand('use', { _: [], name: 'llama3' }, h.deps);
    expect(h.saved).toEqual([{ defaultModel: 'llama3:latest', localDefaultModel: 'llama3:latest' }]);
  });

  it('finds a Hugging Face model installed under the other host name', async () => {
    const runtime = fakeRuntime({ list: vi.fn().mockResolvedValue([installed('huggingface.co/acme/m-GGUF:Q4_K_M')]) });
    const h = harness({ runtime });
    await runModelsCommand('use', { _: [], name: 'hf.co/acme/m-GGUF:Q4_K_M' }, h.deps);
    expect(h.saved[0]).toMatchObject({ defaultModel: 'huggingface.co/acme/m-GGUF:Q4_K_M' });
  });

  it('rejects unknown models and non-Ollama runtimes', async () => {
    await expect(runModelsCommand('use', { _: [], name: 'nope' }, harness().deps)).rejects.toThrow(
      /No model named nope/
    );
    const runtime = fakeRuntime({ kind: 'openai-compatible' });
    await expect(runModelsCommand('use', { _: [], name: 'qwen2.5:0.5b' }, harness({ runtime }).deps)).rejects.toThrow(
      /is not Ollama/
    );
  });
});

describe('resolveRuntimeTarget', () => {
  const detected = (runtime: LocalRuntime, ok = true): DetectedRuntime => ({
    runtime,
    health: { ok, version: null, error: ok ? null : 'unauthorized' },
    product: null,
    configured: false,
  });

  it('uses the flag, then the environment, then the saved host', async () => {
    const create = vi.fn((baseUrl: string) => fakeRuntime({ baseUrl }));
    const detect = vi.fn();
    const all = { flag: 'http://flag:3', env: 'http://env:1', config: 'http://saved:2' };
    expect((await resolveRuntimeTarget(all, detect, create)).source).toBe('flag');
    expect(create).toHaveBeenLastCalledWith('http://flag:3');
    const target = await resolveRuntimeTarget({ env: 'http://env:1', config: 'http://saved:2' }, detect, create);
    expect(target.source).toBe('env');
    expect(create).toHaveBeenLastCalledWith('http://env:1');
    expect((await resolveRuntimeTarget({ config: 'http://saved:2' }, detect, create)).source).toBe('config');
    expect(detect).not.toHaveBeenCalled();
  });

  it("gives a bare host Ollama's default port", async () => {
    const create = vi.fn((baseUrl: string) => fakeRuntime({ baseUrl }));
    await resolveRuntimeTarget({ flag: 'gpu-box' }, vi.fn(), create);
    expect(create).toHaveBeenCalledWith('http://gpu-box:11434');
  });

  it('fails when the configured host is down', async () => {
    const create = () =>
      fakeRuntime({ health: vi.fn().mockResolvedValue({ ok: false, version: null, error: 'refused' }) });
    await expect(resolveRuntimeTarget({ config: 'http://saved:2' }, vi.fn(), create)).rejects.toThrow(
      /unreachable: refused/
    );
  });

  it('falls back to detected runtimes, preferring a healthy Ollama', async () => {
    const lmStudio = fakeRuntime({ kind: 'openai-compatible', baseUrl: 'http://127.0.0.1:1234' });
    const ollama = fakeRuntime();
    const target = await resolveRuntimeTarget({}, async () => [detected(lmStudio), detected(ollama)]);
    expect(target).toEqual({ runtime: ollama, source: 'detected' });
    await expect(resolveRuntimeTarget({}, async () => [detected(ollama, false)])).rejects.toThrow(
      /No local model runtime/
    );
  });
});
