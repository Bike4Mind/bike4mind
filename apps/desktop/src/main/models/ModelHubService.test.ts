import { createHash } from 'node:crypto';
import {
  HubAccessError,
  HubRateLimitError,
  HuggingFaceHub,
  LocalRuntimeError,
  ModelNotFoundError,
  RuntimeConnectionError,
  installedReviewed,
  loadCuratedManifest,
  type HardwareProfile,
  ollamaPullRef,
  type HubGgufBuild,
  type HubModelDetail,
  type HubSearchPage,
  type InspectOptions,
  type InstalledModel,
  type LoadedModel,
  type ModelArch,
  type ModelInspection,
  type OllamaRegistryLayers,
  type PullOptions,
} from '@bike4mind/local-models';
import type { HubBuild, HubManifest } from '@bike4mind/common';
import { AUTO_LOCAL_CONTEXT, type LocalContextSetting } from '@shared/localContextSetting';
import { pullKey, type ModelPull } from '@shared/models';
import type { ModelServerSpecs } from '@shared/modelServers';
import { describe, expect, it, vi } from 'vitest';
import { LOCAL_CONTEXT_TARGET_TOKENS } from '../chat/localContext';
import { ServerUnreachableError } from '../modelServers/errors';
import { HuggingFaceTokenStore } from './HuggingFaceTokenStore';
import {
  ModelHubService,
  toModelHubError,
  type HubTokenPort,
  type ModelHubPort,
  type ModelRuntimePort,
} from './ModelHubService';

const REPO = 'Qwen/Qwen2.5-0.5B-Instruct-GGUF';
const SHA = 'a'.repeat(64);

function build(overrides: Partial<HubGgufBuild> = {}): HubGgufBuild {
  return {
    id: 'qwen2.5-0.5b-instruct-q4_k_m',
    quant: 'Q4_K_M',
    label: 'Q4_K_M',
    files: [{ path: 'qwen2.5-0.5b-instruct-q4_k_m.gguf', sizeBytes: 491_400_032, sha256: SHA, url: 'https://x' }],
    sizeBytes: 491_400_032,
    split: false,
    complete: true,
    ollamaRef: `hf.co/${REPO}:Q4_K_M`,
    ollamaRefIssue: null,
    ...overrides,
  };
}

function detail(overrides: Partial<HubModelDetail> = {}): HubModelDetail {
  return {
    id: REPO,
    author: 'Qwen',
    downloads: 100,
    likes: 10,
    updatedAt: null,
    pipelineTag: 'text-generation',
    gated: false,
    private: false,
    licenses: ['apache-2.0'],
    baseModels: [],
    tags: ['gguf'],
    revision: 'b'.repeat(40),
    licenseName: null,
    licenseLink: null,
    gguf: null,
    builds: [build()],
    projectors: [],
    canDownload: true,
    ollamaNeedsSshKey: false,
    ...overrides,
  };
}

interface Deferred {
  resolve: () => void;
  reject: (error: unknown) => void;
  options: PullOptions | undefined;
}

type Health = { ok: boolean; version: string | null; error: string | null };

const GIB = 1024 ** 3;
const machine = (memoryKind: HardwareProfile['memoryKind'], totalGiB: number, gpuGiB: number | null = null) =>
  ({
    platform: 'linux',
    arch: 'x64',
    memoryKind,
    totalMemoryBytes: totalGiB * GIB,
    gpuMemoryBytes: gpuGiB === null ? null : gpuGiB * GIB,
    gpuName: gpuGiB === null ? null : 'Test GPU',
    gpuCount: gpuGiB === null ? 0 : 1,
    chip: null,
    diskFreeBytes: null,
    confidence: 'high',
  }) satisfies HardwareProfile;
const CPU_16 = machine('cpu', 16);

const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');
const libraryOf = (build: HubBuild) => (build.ollama?.kind === 'library' ? build.ollama : null);
const pinsOf = (build: HubBuild) =>
  build.ollama?.kind === 'library' || build.ollama?.kind === 'hf-pull' ? build.ollama.layers : undefined;
/** The name Ollama lists a curated build under. */
const refOf = (build: HubBuild) => libraryOf(build)?.ref ?? `hf.co/${build.hf?.repo}:${build.quant.label}`;
const templateText = (ref: string) => `template of ${ref}`;
const licenseText = (ref: string) => `license of ${ref}`;

// The bundled list with its template and license pins swapped for digests of known text, so a stubbed Ollama can
// report installed contents that match them.
const CURATED: HubManifest = structuredClone(loadCuratedManifest(() => {}));
for (const entry of CURATED.entries)
  for (const reviewed of entry.builds) {
    const pins = pinsOf(reviewed);
    if (!pins) continue;
    const template = sha256(templateText(refOf(reviewed)));
    if (pins.installedTemplate) pins.installedTemplate = template;
    else if (pins.template) pins.template = template;
    if (pins.license) pins.license = sha256(licenseText(refOf(reviewed)));
  }
const curatedBuilds = () => CURATED.entries.flatMap(entry => entry.builds);

/** What Ollama reports for a curated build it installed as reviewed; nothing for any other name. */
function installedAsReviewed(ref: string): Pick<ModelInspection, 'contents' | 'parameters'> | null {
  const reviewed = curatedBuilds().find(candidate => refOf(candidate) === ref);
  const pins = reviewed && pinsOf(reviewed);
  if (!reviewed || !pins) return null;
  return {
    contents: {
      template: templateText(ref),
      license: pins.license ? licenseText(ref) : null,
      modelBlob: libraryOf(reviewed)?.digest ?? reviewed.weights[0].sha256,
      projectorBlobs: pins.projector ? [pins.projector] : [],
      draftBlobs: pins.draft ? [pins.draft] : [],
    },
    parameters: pins.numCtx ? `num_ctx ${pins.numCtx}` : null,
  };
}

/** The registry layers Ollama would pull for a curated build, as reviewed. */
function reviewedLayers(reviewed: HubBuild | undefined): OllamaRegistryLayers | null {
  const pins = reviewed && pinsOf(reviewed);
  if (!reviewed || !pins) return null;
  return {
    model: libraryOf(reviewed)?.digest ?? reviewed.weights[0].sha256,
    others: (['template', 'params', 'license', 'projector', 'draft'] as const).flatMap(kind => {
      const digest = pins[kind];
      return digest ? [{ mediaType: `application/vnd.ollama.image.${kind}`, digest }] : [];
    }),
  };
}

// A small dense model's header, as Ollama's /api/show reports it through archFromModelInfo.
const SMALL_ARCH: ModelArch = {
  contextMax: 32768,
  blockCount: 24,
  headCount: 14,
  full: { layers: 24, kvHeads: 2, keyLength: 64, valueLength: 64 },
  mtpLayers: 0,
};

function memoryTokens(initial: string | null = null, persisted = true) {
  let token = initial;
  return {
    persisted: vi.fn(() => persisted),
    get: vi.fn(async () => token),
    set: vi.fn(async (next: string) => {
      token = next;
    }),
    clear: vi.fn(async () => {
      token = null;
    }),
  } satisfies HubTokenPort;
}

function harness(
  options: {
    detail?: HubModelDetail;
    verified?: string | null;
    healthy?: boolean;
    /** null: Ollama answers but reports no version. */
    version?: string | null;
    curated?: HubManifest | (() => HubManifest);
    hardware?: HardwareProfile;
    setting?: LocalContextSetting;
    checkBackoffMs?: number[];
    token?: string | null;
  } = {}
) {
  const pulls: Deferred[] = [];
  const runtime = {
    baseUrl: 'http://127.0.0.1:11434',
    health: vi.fn(async (): Promise<Health> =>
      options.healthy === false
        ? { ok: false, version: null, error: 'connection refused' }
        : { ok: true, version: options.version === undefined ? '0.40.11' : options.version, error: null }
    ),
    list: vi.fn(async (): Promise<InstalledModel[]> => []),
    inspect: vi.fn(async (name: string, _options?: InspectOptions): Promise<ModelInspection> => ({
      model: {
        name,
        sizeBytes: null,
        quantization: null,
        family: null,
        parameterSize: null,
        modifiedAt: null,
        capabilities: { tools: false, vision: false, thinking: false, embeddings: false, completion: true },
      },
      arch: SMALL_ARCH,
      tensorStats: null,
      parameters: null,
      ...installedAsReviewed(name),
    })),
    loaded: vi.fn(async (): Promise<LoadedModel[]> => []),
    pull: vi.fn(
      (_ref: string, opts?: PullOptions) =>
        new Promise<void>((resolve, reject) => {
          pulls.push({ resolve, reject, options: opts });
          opts?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
        })
    ),
    remove: vi.fn(async () => undefined),
  } satisfies ModelRuntimePort;
  const hub = {
    endpoint: 'https://huggingface.co',
    search: vi.fn(async (): Promise<HubSearchPage> => ({ models: [], nextCursor: null })),
    getModel: vi.fn(async (_repo: string) => options.detail ?? detail()),
    verifyOllamaRef: vi.fn(async (found: Pick<HubModelDetail, 'ollamaNeedsSshKey'>): Promise<string | null> =>
      options.verified === undefined ? ollamaPullRef(`hf.co/${REPO}:Q4_K_M`, found.ollamaNeedsSshKey) : options.verified
    ),
    ollamaLayers: vi.fn(async (repo: string, tag: string) =>
      reviewedLayers(curatedBuilds().find(candidate => candidate.hf?.repo === repo && candidate.quant.label === tag))
    ),
    checkToken: vi.fn(async () => true),
  } satisfies ModelHubPort;
  const libraryLayers = vi.fn(async (ref: string, _options?: { signal?: AbortSignal }) =>
    reviewedLayers(curatedBuilds().find(candidate => libraryOf(candidate)?.ref === ref))
  );
  const pushed: ModelPull[][] = [];
  const installedChanged = vi.fn();
  const tokens = memoryTokens(options.token ?? null);
  const createHub = vi.fn((_token: string | null) => hub);
  const hardware = vi.fn(async () => options.hardware ?? CPU_16);
  const warn = vi.fn();
  const service = new ModelHubService({
    runtime,
    createHub,
    tokens,
    libraryLayers,
    hardware,
    localContext: async () => options.setting ?? AUTO_LOCAL_CONTEXT,
    curated:
      typeof options.curated === 'function' ? options.curated : () => (options.curated as HubManifest) ?? CURATED,
    onPullsChanged: next => pushed.push(next),
    onInstalledChanged: installedChanged,
    warn,
    progressIntervalMs: 0,
    checkBackoffMs: options.checkBackoffMs ?? [0, 0],
  });
  return { service, runtime, hub, libraryLayers, pulls, pushed, installedChanged, hardware, warn, tokens, createHub };
}

const request = {
  repo: REPO,
  buildId: 'qwen2.5-0.5b-instruct-q4_k_m',
  revision: 'b'.repeat(40),
  sizeBytes: 491_400_032,
  acceptLicense: false,
  confirmAccess: false,
};

describe('curated draft integrity', () => {
  it('rejects every adapter while accepting absent or empty adapter lists', async () => {
    const reviewed = curatedBuilds()[0];
    const inspection = await harness().runtime.inspect(refOf(reviewed));
    for (const adapterBlobs of [undefined, [], [SHA], [null], [SHA, SHA]]) {
      expect(
        installedReviewed(
          { ...inspection, contents: inspection.contents && { ...inspection.contents, adapterBlobs } },
          reviewed
        )
      ).toBe(!adapterBlobs?.length);
    }
  });

  it('requires exactly the reviewed draft and rejects missing, changed, unreadable or duplicate drafts', async () => {
    const reviewed = curatedBuilds().find(build => pinsOf(build)?.draft);
    if (!reviewed) throw new Error('the bundled list lost its draft build');
    const inspection = await harness().runtime.inspect(refOf(reviewed));
    expect(installedReviewed(inspection, reviewed)).toBe(true);
    for (const draftBlobs of [[], [SHA], [null], [...(inspection.contents?.draftBlobs ?? []), SHA]]) {
      expect(
        installedReviewed(
          { ...inspection, contents: inspection.contents && { ...inspection.contents, draftBlobs } },
          reviewed
        )
      ).toBe(false);
    }
  });
});

describe('ModelHubService pulls', () => {
  it('verifies the ref, then pulls it with progress, and reports the model installed', async () => {
    const { service, runtime, hub, pulls, pushed, installedChanged } = harness();
    const result = service.pull(request);
    await vi.waitFor(() => expect(pulls).toHaveLength(1));

    expect(hub.verifyOllamaRef).toHaveBeenCalledTimes(1);
    expect(runtime.pull).toHaveBeenCalledWith(`hf.co/${REPO}:Q4_K_M`, expect.anything());
    expect(pulls[0].options?.runner).toBeUndefined();
    pulls[0].options?.onProgress?.({ status: 'pulling abc', completedBytes: 100, totalBytes: 491_400_032 });
    expect(service.pulls()[0]).toMatchObject({ phase: 'downloading', completedBytes: 100, label: 'Q4_K_M' });

    pulls[0].resolve();
    await expect(result).resolves.toEqual({ ok: true, ref: `hf.co/${REPO}:Q4_K_M` });
    expect(service.pulls()).toEqual([]);
    expect(pushed.at(-1)).toEqual([]);
    expect(installedChanged).toHaveBeenCalledTimes(1);
  });

  it('does not pull when the registry cannot confirm the file', async () => {
    const { service, runtime } = harness({ verified: null });
    const result = await service.pull(request);

    expect(result).toMatchObject({ ok: false, error: { kind: 'unverified' } });
    expect(runtime.pull).not.toHaveBeenCalled();
    expect(service.pulls()[0]).toMatchObject({ phase: 'failed', error: { kind: 'unverified' } });
  });

  it('cancels a running pull and leaves nothing behind', async () => {
    const { service, pulls, installedChanged } = harness();
    const result = service.pull(request);
    await vi.waitFor(() => expect(pulls).toHaveLength(1));

    service.cancel(pullKey(request.repo, request.buildId));
    await expect(result).resolves.toMatchObject({ ok: false, error: { kind: 'cancelled' } });
    expect(service.pulls()).toEqual([]);
    expect(installedChanged).not.toHaveBeenCalled();
  });

  it('reports a cancel during the Ollama check as a cancel, not as Ollama being down', async () => {
    const { service, runtime, pulls } = harness();
    let release: (health: Health) => void = () => undefined;
    runtime.health.mockImplementationOnce(() => new Promise<Health>(resolve => (release = resolve)));
    const result = service.pull(request);
    await vi.waitFor(() => expect(runtime.health).toHaveBeenCalledTimes(1));

    service.cancel(pullKey(request.repo, request.buildId));
    release({ ok: false, version: null, error: 'timed out' });

    await expect(result).resolves.toMatchObject({ ok: false, error: { kind: 'cancelled' } });
    expect(service.pulls()).toEqual([]);
    expect(pulls).toHaveLength(0);
  });

  it('refuses a second pull of the same build while one runs', async () => {
    const { service, runtime, pulls } = harness();
    const first = service.pull(request);
    const second = await service.pull(request);

    expect(second).toMatchObject({ ok: false, error: { kind: 'already-pulling' } });
    await vi.waitFor(() => expect(pulls).toHaveLength(1));
    expect(runtime.pull).toHaveBeenCalledTimes(1);
    pulls[0].resolve();
    await expect(first).resolves.toMatchObject({ ok: true });
  });

  it('retries a failed pull of the same build', async () => {
    const { service, hub, pulls } = harness();
    hub.verifyOllamaRef.mockResolvedValueOnce(null);
    await service.pull(request);
    expect(service.pulls()[0].phase).toBe('failed');

    const retry = service.pull(request);
    await vi.waitFor(() => expect(pulls).toHaveLength(1));
    pulls[0].resolve();
    await expect(retry).resolves.toMatchObject({ ok: true });
  });

  it.each([[['llama3.2']], [['apache-2.0', 'gemma']], [[]]])(
    'needs the license accepted unless every declared one is permissive: %j',
    async licenses => {
      const { service, hub, runtime, pulls } = harness({ detail: detail({ licenses }) });

      const refused = await service.pull(request);
      expect(refused).toMatchObject({ ok: false, error: { kind: 'license-required' }, listed: false });
      expect(hub.verifyOllamaRef).not.toHaveBeenCalled();
      expect(service.pulls()).toEqual([]);

      const accepted = service.pull({ ...request, acceptLicense: true });
      await vi.waitFor(() => expect(pulls).toHaveLength(1));
      pulls[0].resolve();
      await expect(accepted).resolves.toMatchObject({ ok: true });
      expect(runtime.pull).toHaveBeenCalledTimes(1);
    }
  );

  it('classifies a card that lists two licenses by both, end to end through the Hub client', async () => {
    const repo = 'someone/Gemma-Remix-GGUF';
    const sha = 'c'.repeat(40);
    const oid = 'd'.repeat(64);
    const json = (body: unknown) => Response.json(body);
    const fetchStub = vi.fn(async (input: string | URL | Request) => {
      const path = new URL(String(input)).pathname;
      if (path === `/api/models/${repo}/revision/main`)
        return json({
          id: repo,
          sha,
          gated: false,
          private: false,
          tags: ['gguf'],
          cardData: { license: ['apache-2.0', 'gemma'] },
        });
      if (path === `/api/models/${repo}/tree/${sha}`)
        return json([{ type: 'file', path: 'Gemma-Remix-Q4_K_M.gguf', size: 4e8, lfs: { oid, size: 4e8 } }]);
      return new Response('{"error":"not found"}', { status: 404 });
    });
    const { runtime } = harness();
    const service = new ModelHubService({
      runtime,
      createHub: () => new HuggingFaceHub({ fetch: fetchStub as unknown as typeof fetch }),
      tokens: memoryTokens(),
      libraryLayers: async () => null,
      hardware: async () => CPU_16,
      localContext: async () => AUTO_LOCAL_CONTEXT,
      curated: () => CURATED,
      onPullsChanged: () => {},
      onInstalledChanged: () => {},
      warn: () => {},
    });

    const view = await service.detail(repo);
    if (!view.ok) throw new Error(view.error.message);
    expect(view.model).toMatchObject({ licenses: ['apache-2.0', 'gemma'], licenseKind: 'restricted' });
    const build0 = view.model.builds[0];
    const refused = await service.pull({
      ...request,
      repo,
      buildId: build0.id,
      revision: view.model.revision,
      sizeBytes: build0.sizeBytes,
    });
    expect(refused).toMatchObject({ ok: false, error: { kind: 'license-required' } });
    expect(runtime.pull).not.toHaveBeenCalled();
  });

  it('refuses a pull when the repo moved on from the commit or size the user reviewed', async () => {
    const { service, hub, runtime } = harness();
    const moved = await service.pull({ ...request, revision: 'e'.repeat(40) });
    expect(moved).toMatchObject({ ok: false, error: { kind: 'changed' }, listed: false });
    const resized = await service.pull({ ...request, sizeBytes: 9_000_000_000 });
    expect(resized).toMatchObject({ ok: false, error: { kind: 'changed' } });
    expect(hub.verifyOllamaRef).not.toHaveBeenCalled();
    expect(runtime.pull).not.toHaveBeenCalled();
    expect(service.pulls()).toEqual([]);
  });

  it('explains how to clear a download Ollama cannot resume', async () => {
    const { service, pulls } = harness();
    const result = service.pull(request);
    await vi.waitFor(() => expect(pulls).toHaveLength(1));
    pulls[0].reject(new LocalRuntimeError(`ollama could not pull hf.co/${REPO}:Q4_K_M: EOF`, 'ollama'));

    await expect(result).resolves.toMatchObject({ ok: false, error: { kind: 'interrupted' }, listed: true });
    const message = service.pulls()[0].error?.message ?? '';
    expect(message).toContain('-partial in their names');
    expect(message).not.toContain(SHA);
    expect(message).toContain('restarting Ollama does not clear it');
  });

  // What Ollama 0.40.11 answers when the registry closes the socket on the manifest or a blob request.
  it.each([
    `pull model manifest: Get "https://hf.co/v2/${REPO}/manifests/Q4_K_M": EOF`,
    `Head "https://huggingface.co/v2/${REPO}/blobs/sha256:${SHA}": EOF`,
  ])('reports a registry connection that closed as a connection failure: %s', async cause => {
    const { service, pulls } = harness();
    const result = service.pull(request);
    await vi.waitFor(() => expect(pulls).toHaveLength(1));
    pulls[0].reject(new LocalRuntimeError(`ollama could not pull hf.co/${REPO}:Q4_K_M: ${cause}`, 'ollama'));

    await expect(result).resolves.toMatchObject({
      ok: false,
      error: { kind: 'hub-unreachable', message: expect.stringContaining('lost its connection') },
    });
    expect(service.pulls()[0].error?.message).not.toContain('-partial');
  });

  it('checks the current revision at pull time, so a license change after review is refused', async () => {
    let current = detail();
    const fetch = vi.fn(async (input: string) => {
      const path = new URL(input).pathname;
      if (path === `/api/models/${REPO}/revision/main`)
        return Response.json({ ...current, sha: current.revision, cardData: { license: current.licenses } });
      if (path === `/api/models/${REPO}/tree/${current.revision}`)
        return Response.json(
          current.builds.flatMap(build =>
            build.files.map(file => ({
              type: 'file',
              path: file.path,
              size: file.sizeBytes,
              lfs: { oid: file.sha256, size: file.sizeBytes },
            }))
          )
        );
      return new Response('', { status: 404 });
    });
    const { runtime } = harness();
    const service = new ModelHubService({
      runtime,
      createHub: () => new HuggingFaceHub({ endpoint: 'https://license-refresh.test', fetch }),
      tokens: memoryTokens(),
      libraryLayers: async () => null,
      hardware: async () => CPU_16,
      localContext: async () => AUTO_LOCAL_CONTEXT,
      curated: () => CURATED,
      onPullsChanged: () => {},
      onInstalledChanged: () => {},
      warn: () => {},
    });
    const shown = await service.detail(REPO);
    if (!shown.ok) throw new Error(shown.error.message);
    current = detail({ licenses: ['cc-by-nc-4.0'], revision: 'c'.repeat(40) });

    const result = await service.pull({ ...request, revision: shown.model.revision });
    expect(result).toMatchObject({ ok: false, error: { kind: 'changed' }, listed: false });
    expect(runtime.pull).not.toHaveBeenCalled();
  });

  it('blocks a gated build whose file Hugging Face hides', async () => {
    const hidden = build({ files: [{ ...build().files[0], sha256: null }] });
    const { service, hub } = harness({
      detail: detail({ gated: 'manual', ollamaNeedsSshKey: true, builds: [hidden], canDownload: false }),
    });

    const result = await service.pull({ ...request, confirmAccess: true });
    expect(result).toMatchObject({ ok: false, error: { kind: 'cannot-pull' } });
    expect(hub.verifyOllamaRef).not.toHaveBeenCalled();

    const view = await service.detail(REPO);
    expect(view).toMatchObject({ ok: true, model: { needsAccess: true, gated: 'manual' } });
    expect(view.ok && view.model.builds[0].blockedReason).toMatch(/Needs access/);
  });

  it('needs the access steps confirmed for a gated repo, then reports a refusal as gated', async () => {
    const { service, hub, runtime } = harness({ detail: detail({ gated: 'auto', ollamaNeedsSshKey: true }) });

    expect(await service.pull(request)).toMatchObject({ ok: false, error: { kind: 'access-required' } });

    hub.verifyOllamaRef.mockRejectedValueOnce(new HubAccessError('denied', 'huggingface', 403, REPO, 'gated'));
    const result = await service.pull({ ...request, confirmAccess: true });
    expect(result).toMatchObject({ ok: false, error: { kind: 'gated' } });
    expect(runtime.pull).not.toHaveBeenCalled();
  });

  it('pulls a gated repo by its huggingface.co name, which Ollama can sign for', async () => {
    const { service, runtime, pulls } = harness({ detail: detail({ gated: 'auto', ollamaNeedsSshKey: true }) });
    const view = await service.detail(REPO);
    expect(view.ok && view.model.builds[0].ollamaRef).toBe(`huggingface.co/${REPO}:Q4_K_M`);

    const result = service.pull({ ...request, confirmAccess: true });
    await vi.waitFor(() => expect(pulls).toHaveLength(1));
    expect(runtime.pull).toHaveBeenCalledWith(`huggingface.co/${REPO}:Q4_K_M`, expect.anything());
    pulls[0].resolve();
    await expect(result).resolves.toEqual({ ok: true, ref: `huggingface.co/${REPO}:Q4_K_M` });
  });

  it('names the computer that ran out of disk space', async () => {
    const { service, pulls } = harness();
    const result = service.pull(request);
    await vi.waitFor(() => expect(pulls).toHaveLength(1));
    pulls[0].reject(new LocalRuntimeError('ollama could not pull x: write blob: no space left on device', 'ollama'));
    await expect(result).resolves.toMatchObject({
      ok: false,
      error: { kind: 'failed', message: expect.stringContaining('This computer ran out of disk space') },
    });
  });

  it('does not start when Ollama is not running, and keeps the failure in the list', async () => {
    const { service, hub, runtime } = harness({ healthy: false });
    const result = await service.pull(request);

    expect(result).toMatchObject({ ok: false, error: { kind: 'runtime-unavailable' }, listed: true });
    expect(service.pulls()).toEqual([
      expect.objectContaining({ phase: 'failed', error: expect.objectContaining({ kind: 'runtime-unavailable' }) }),
    ]);
    expect(hub.verifyOllamaRef).not.toHaveBeenCalled();
    expect(runtime.pull).not.toHaveBeenCalled();
  });

  it('refuses a build that cannot be pulled, with the reason', async () => {
    const { service } = harness({
      detail: detail({ builds: [build({ split: true, ollamaRef: null, ollamaRefIssue: 'split' })] }),
    });
    const result = await service.pull(request);
    expect(result).toMatchObject({
      ok: false,
      error: { kind: 'cannot-pull', message: expect.stringMatching(/Split/) },
    });
  });

  it('passes each build its own label when two share a quant', async () => {
    const builds = [
      build({ id: 'LFM2.5-350M-Q4_0', quant: 'Q4_0', label: 'Q4_0' }),
      build({ id: 'LFM2.5-350M-QAD-Q4_0', quant: 'Q4_0', label: 'QAD-Q4_0' }),
    ];
    const { service } = harness({ detail: detail({ builds }) });
    const view = await service.detail(REPO);
    expect(view.ok && view.model.builds.map(entry => entry.label)).toEqual(['Q4_0', 'QAD-Q4_0']);
  });

  it('blocks a build with an unsupported quant in the detail and on pull', async () => {
    const unsupported = build({ quant: 'Q4_K_L', ollamaRef: null, ollamaRefIssue: 'unsupported-quant' });
    const { service, hub, runtime } = harness({ detail: detail({ builds: [unsupported] }) });

    const view = await service.detail(REPO);
    expect(view.ok && view.model.builds[0].blockedReason).toMatch(/cannot pull this quant/);

    const result = await service.pull(request);
    expect(result).toMatchObject({
      ok: false,
      error: { kind: 'cannot-pull', message: expect.stringMatching(/cannot pull this quant/) },
    });
    expect(hub.verifyOllamaRef).not.toHaveBeenCalled();
    expect(runtime.pull).not.toHaveBeenCalled();
  });

  it('keeps an ambiguous build pullable through the verified ref', async () => {
    const ambiguous = build({ ollamaRef: null, ollamaRefIssue: 'ambiguous' });
    const { service, hub, runtime, pulls } = harness({ detail: detail({ builds: [ambiguous] }) });

    const view = await service.detail(REPO);
    expect(view.ok && view.model.builds[0].blockedReason).toBeNull();

    const result = service.pull(request);
    await vi.waitFor(() => expect(pulls).toHaveLength(1));
    expect(hub.verifyOllamaRef).toHaveBeenCalledTimes(1);
    expect(runtime.pull).toHaveBeenCalledWith(`hf.co/${REPO}:Q4_K_M`, expect.anything());
    pulls[0].resolve();
    await expect(result).resolves.toEqual({ ok: true, ref: `hf.co/${REPO}:Q4_K_M` });
  });

  it('aborts every pull on dispose', async () => {
    const { service, pulls } = harness();
    const result = service.pull(request);
    await vi.waitFor(() => expect(pulls).toHaveLength(1));
    service.dispose();
    await expect(result).resolves.toMatchObject({ ok: false, error: { kind: 'cancelled' } });
  });
});

describe('ModelHubService reads', () => {
  it('marks loaded models', async () => {
    const { service, runtime } = harness();
    const capabilities = { tools: true, vision: false, thinking: false, embeddings: false, completion: true };
    const model = {
      sizeBytes: 1,
      quantization: 'Q4_K_M',
      family: 'qwen2',
      parameterSize: '494M',
      modifiedAt: null,
      capabilities,
    };
    runtime.list.mockResolvedValueOnce([
      { ...model, name: 'qwen2.5:0.5b' },
      { ...model, name: 'gemma3:270m' },
    ]);
    runtime.loaded.mockResolvedValueOnce([
      { name: 'qwen2.5:0.5b', sizeBytes: 1, vramBytes: 0, contextLength: null, expiresAt: null },
    ]);

    const result = await service.installed();
    expect(result.ok && result.models.map(entry => [entry.name, entry.loaded])).toEqual([
      ['gemma3:270m', false],
      ['qwen2.5:0.5b', true],
    ]);
  });

  it('reports Ollama unreachable', async () => {
    const { service, runtime } = harness();
    runtime.list.mockRejectedValueOnce(new RuntimeConnectionError('refused', 'ollama', { cause: new Error('x') }));
    expect(await service.installed()).toMatchObject({ ok: false, error: { kind: 'runtime-unavailable' } });
  });

  it('names ollama.com when the registry is unreachable', () => {
    const error = new RuntimeConnectionError('offline', 'ollama-registry', { cause: new Error('x') });
    expect(toModelHubError(error)).toEqual({ kind: 'runtime-unavailable', message: 'Could not reach ollama.com.' });
  });

  it('labels abliterated results and maps rate limits and outages', async () => {
    const { service, hub } = harness();
    const summary = { ...detail(), tags: [] };
    hub.search.mockResolvedValueOnce({
      models: [
        summary,
        { ...summary, id: 'someone/Qwen2.5-7B-Instruct-abliterated-GGUF' },
        { ...summary, id: 'mudler/gemma-4-26B-A4B-it-heretic-APEX-GGUF' },
        { ...summary, id: 'someone/Plain-GGUF', baseModels: ['someone/qwen-2.5-3b-decensored'] },
      ],
      nextCursor: 'next',
    });
    const found = await service.search({ query: 'qwen' });
    expect(found.ok && found.models.map(model => model.abliterated)).toEqual([false, true, true, true]);
    expect(found).toMatchObject({ nextCursor: 'next' });

    hub.search.mockRejectedValueOnce(new HubRateLimitError('slow down', 'huggingface', 30_000));
    expect(await service.search({ query: 'qwen' })).toMatchObject({
      ok: false,
      error: { kind: 'rate-limited', retryAfterMs: 30_000 },
    });

    hub.search.mockRejectedValueOnce(new RuntimeConnectionError('offline', 'huggingface', { cause: new Error('x') }));
    expect(await service.search({ query: 'qwen' })).toMatchObject({ ok: false, error: { kind: 'hub-unreachable' } });
  });

  it('links the license from the card, or the repo page when the card has none', async () => {
    const { service, hub } = harness();
    hub.getModel.mockResolvedValueOnce(
      detail({ licenses: ['other'], licenseName: 'qwen-research', licenseLink: 'LICENSE' })
    );
    const relative = await service.detail(REPO);
    expect(relative).toMatchObject({
      ok: true,
      model: {
        licenseNames: ['qwen-research'],
        licenseKind: 'restricted',
        licenseUrl: `https://huggingface.co/${REPO}/blob/main/LICENSE`,
        licenseHost: 'huggingface.co',
      },
    });

    const plain = await service.detail(REPO);
    expect(plain).toMatchObject({
      ok: true,
      model: {
        licenseNames: ['apache-2.0'],
        licenseKind: 'permissive',
        licenseUrl: `https://huggingface.co/${REPO}`,
      },
    });
  });

  it.each([
    ['javascript:alert(1)', `https://huggingface.co/${REPO}`, 'huggingface.co'],
    ['JaVaScRiPt:alert(1)', `https://huggingface.co/${REPO}`, 'huggingface.co'],
    ['file:///etc/passwd', `https://huggingface.co/${REPO}`, 'huggingface.co'],
    ['//elsewhere.example/x', `https://huggingface.co/${REPO}`, 'huggingface.co'],
    ['https://llama.meta.com/llama3/license/', 'https://llama.meta.com/llama3/license/', 'llama.meta.com'],
    ['https://', `https://huggingface.co/${REPO}`, 'huggingface.co'],
    ['https://[x', `https://huggingface.co/${REPO}`, 'huggingface.co'],
    ['https:// a b', `https://huggingface.co/${REPO}`, 'huggingface.co'],
  ])('keeps the license link https and names its host: %s', async (licenseLink, licenseUrl, licenseHost) => {
    const { service, hub } = harness();
    hub.getModel.mockResolvedValueOnce(detail({ licenses: ['llama3'], licenseLink }));
    expect(await service.detail(REPO)).toMatchObject({ ok: true, model: { licenseUrl, licenseHost } });
  });

  it('removes a model and announces it', async () => {
    const { service, runtime, installedChanged } = harness();
    expect(await service.remove('qwen2.5:0.5b')).toEqual({ ok: true });
    expect(runtime.remove).toHaveBeenCalledWith('qwen2.5:0.5b');
    expect(installedChanged).toHaveBeenCalledTimes(1);
  });
});

/**
 * Servers `a` and `b`, each set to Chat and manage and backed by its own deferred runtime; `remote` holds each
 * one's harness, so a test can settle its pulls. The service's own Hugging Face client and list come from `local`.
 */
function servers(options: Parameters<typeof harness>[0] = {}) {
  const local = harness(options);
  const remote = { a: harness(options), b: harness(options) };
  const runtimes = { a: remote.a.runtime, b: remote.b.runtime };
  const saved = new Set(['a', 'b']);
  const chatOnly = new Set<string>();
  for (const [id, runtime] of Object.entries(runtimes)) {
    runtime.health.mockImplementation(async () =>
      saved.has(id)
        ? { ok: true, version: options.version === undefined ? '0.40.11' : options.version, error: null }
        : { ok: false, version: null, error: `${id} did not answer.` }
    );
  }
  const keepAwake = vi.fn();
  const installedChanged = vi.fn();
  const service = new ModelHubService({
    runtime: local.runtime,
    server: id =>
      saved.has(id) && (id === 'a' || id === 'b')
        ? { name: `box ${id}`, management: chatOnly.has(id) ? 'chat-only' : 'allowed', runtime: runtimes[id] }
        : null,
    createHub: local.createHub,
    tokens: local.tokens,
    libraryLayers: local.libraryLayers,
    hardware: local.hardware,
    localContext: async () => AUTO_LOCAL_CONTEXT,
    curated: () => CURATED,
    onPullsChanged: () => {},
    onInstalledChanged: installedChanged,
    keepAwake,
    warn: local.warn,
    progressIntervalMs: 0,
    checkBackoffMs: [0, 0],
  });
  return { service, runtimes, remote, saved, chatOnly, keepAwake, installedChanged, local, hub: local.hub };
}

describe('ModelHubService saved servers', () => {
  it('does not wake the computer again while dispose stops several server pulls', async () => {
    const { service, runtimes, keepAwake } = servers();
    const first = service.pull({ ...request, serverId: 'a' });
    const second = service.pull({ ...request, serverId: 'b' });
    await vi.waitFor(() => expect(runtimes.b.pull).toHaveBeenCalled());
    await vi.waitFor(() => expect(runtimes.a.pull).toHaveBeenCalled());

    service.dispose();
    await Promise.all([first, second]);

    expect(keepAwake.mock.calls).toEqual([[true], [false]]);
  });

  it.each([
    ['removed', 'not-found'],
    ['set to Chat only', 'not-allowed'],
    ['cancelled', 'cancelled'],
  ] as const)(
    'stops without contacting the server when the pull is %s while the repo is still being read',
    async (cause, kind) => {
      const { service, saved, chatOnly, runtimes, hub } = servers();
      let release = () => {};
      hub.getModel.mockImplementationOnce(() => new Promise(resolve => (release = () => resolve(detail()))));
      const result = service.pull({ ...request, serverId: 'a' });
      await vi.waitFor(() => expect(hub.getModel).toHaveBeenCalled());
      expect(service.pulls()).toHaveLength(1);
      runtimes.a.health.mockClear();

      if (cause === 'removed') saved.delete('a');
      if (cause === 'set to Chat only') chatOnly.add('a');
      if (cause === 'cancelled') service.cancel(service.pulls()[0].key);
      else service.serverChanged('a');
      release();

      expect(await result).toMatchObject({ ok: false, error: { kind }, listed: false });
      expect(service.pulls()).toEqual([]);
      expect(runtimes.a.health).not.toHaveBeenCalled();
      expect(hub.verifyOllamaRef).not.toHaveBeenCalled();
    }
  );
});

describe('ModelHubService entered hardware', () => {
  const GPU_16: ModelServerSpecs = { ramGiB: 32, gpuMemoryGiB: 16, bandwidthGBps: 448, unified: false };
  const installedModel: InstalledModel = {
    name: 'small:latest',
    sizeBytes: 397_821_319,
    quantization: 'Q4_K_M',
    family: 'llama',
    parameterSize: '494M',
    modifiedAt: '2026-10-01T00:00:00Z',
    capabilities: { tools: true, vision: false, thinking: false, embeddings: false, completion: true },
  };

  /** This computer is a 62 GB CPU-only box with chat fixed at 32K; server `a` has whatever `specs.a` says. */
  function rated(specs: Record<string, ModelServerSpecs | null>) {
    const local = harness({ hardware: machine('cpu', 62) });
    const remote = harness();
    const service = new ModelHubService({
      runtime: local.runtime,
      server: id => (id === 'a' ? { name: 'box a', management: 'allowed', runtime: remote.runtime } : null),
      createHub: local.createHub,
      tokens: local.tokens,
      libraryLayers: local.libraryLayers,
      hardware: local.hardware,
      specs: id => specs[id] ?? null,
      localContext: async () => ({ mode: 'fixed', tokens: 32768 }),
      curated: () => CURATED,
      onPullsChanged: () => {},
      onInstalledChanged: () => {},
      warn: local.warn,
      progressIntervalMs: 0,
      checkBackoffMs: [0, 0],
    });
    return { service, local, remote };
  }
  const picksOf = (list: { picks: { slot: string; entryId: string; buildId: string }[] }) =>
    list.picks.map(pick => `${pick.slot}:${pick.entryId}/${pick.buildId}`);

  it('picks and rates a saved server from its entered hardware, not this computer', async () => {
    const { service } = rated({ a: GPU_16 });
    const list = await service.curated('a');
    expect(list.rating).toBe('entered');
    expect(list.machine).toMatchObject({
      memoryKind: 'discrete',
      totalMemoryBytes: 32 * GIB,
      gpuMemoryBytes: 16 * GIB,
      gpuName: null,
    });
    expect(picksOf(list)).toEqual([
      'best:qwen3-8-27b-gsq/iq3-s',
      'fast:gemma-4-12b/qat-q4-0',
      'long-context:qwen3-8-27b-gsq/iq2-xs',
    ]);
    // Chat sends a saved server the Auto floor, not this computer's fixed 32K.
    const contexts = new Set(list.entries.flatMap(entry => entry.builds.map(build => build.fit.context)));
    expect(contexts.has(32768)).toBe(false);
  });

  it('keeps a saved server without entered RAM unrated everywhere', async () => {
    const { service, remote } = rated({ a: null });
    remote.runtime.list.mockResolvedValue([installedModel]);

    const list = await service.curated('a');
    expect(list.rating).toBeNull();
    expect(list.machine.totalMemoryBytes).toBe(62 * GIB);
    const installed = await service.installed('a');
    expect(installed.ok && installed.models[0].fit).toBeNull();
    expect(remote.runtime.inspect).not.toHaveBeenCalled();
    const detailed = await service.detail(REPO, 'a');
    expect(detailed.ok && detailed.model.builds.every(candidate => candidate.fit === null)).toBe(true);
  });

  it("rates a saved server's installed models and Explore builds through its own runtime", async () => {
    const { service, local, remote } = rated({ a: GPU_16 });
    remote.runtime.list.mockResolvedValue([installedModel]);

    const installed = await service.installed('a');
    expect(installed.ok && installed.models[0].fit).toMatchObject({
      level: 'fits',
      basis: 'arch',
      context: LOCAL_CONTEXT_TARGET_TOKENS,
    });
    expect(remote.runtime.inspect).toHaveBeenCalledWith('small:latest', { tags: false });
    expect(local.runtime.inspect).not.toHaveBeenCalled();
    const detailed = await service.detail(REPO, 'a');
    expect(detailed.ok && detailed.model.builds[0].fit?.detail).toContain('16 GiB');
  });

  it("puts this computer's entered memory in place of its probe", async () => {
    const { service } = rated({ local: { ramGiB: 64, gpuMemoryGiB: 32, bandwidthGBps: null, unified: false } });
    const list = await service.curated();
    expect(list.rating).toBe('entered');
    expect(list.machine).toMatchObject({
      memoryKind: 'discrete',
      totalMemoryBytes: 64 * GIB,
      gpuMemoryBytes: 32 * GIB,
    });
    expect(picksOf(list)).toEqual([
      'best:qwen3-8-27b/q4-k-m',
      'fast:gemma-4-26b/qat-q4-0',
      'long-context:qwen3-8-27b-gsq/iq3-s',
    ]);
  });

  it('keeps the probe when only bandwidth is entered for this computer', async () => {
    const { service } = rated({ local: { ramGiB: null, gpuMemoryGiB: null, bandwidthGBps: 256, unified: false } });
    const list = await service.curated();
    expect(list.rating).toBe('probe');
    expect(list.machine).toMatchObject({ memoryKind: 'cpu', totalMemoryBytes: 62 * GIB });
  });
});

const GSQ_REPO = 'ISTA-DASLab/Qwen3.8-27B-GSQ-RCO-GGUF';
const GSQ = CURATED.entries.find(entry => entry.id === 'qwen3-8-27b-gsq');
const IQ3 = GSQ?.builds.find(candidate => candidate.id === 'iq3-s');
if (!GSQ || !IQ3) throw new Error('the bundled list lost its GSQ pick');
const IQ3_FILE = IQ3.weights[0];
const IQ3_REF = `hf.co/${GSQ_REPO}:IQ3_S`;

/** The live Hugging Face view of the GSQ repo, serving the reviewed IQ3_S file unless told otherwise. */
function gsqDetail(file: Partial<HubGgufBuild['files'][number]> = {}, overrides: Partial<HubModelDetail> = {}) {
  return detail({
    id: GSQ_REPO,
    author: 'ISTA-DASLab',
    builds: [
      build({
        id: IQ3_FILE.path.replace(/\.gguf$/i, ''),
        quant: 'IQ3_S',
        sizeBytes: IQ3_FILE.sizeBytes,
        files: [
          { path: IQ3_FILE.path, sizeBytes: IQ3_FILE.sizeBytes, sha256: IQ3_FILE.sha256, url: 'https://x', ...file },
        ],
        ollamaRef: IQ3_REF,
      }),
    ],
    projectors: [
      { path: 'mmproj-BF16.gguf', quant: 'BF16', sizeBytes: 931_146_528, sha256: 'c'.repeat(64), url: 'https://x' },
    ],
    ...overrides,
  });
}

describe('ModelHubService fit', () => {
  const installed = (overrides: Partial<InstalledModel> = {}): InstalledModel => ({
    name: 'small:latest',
    sizeBytes: 397_821_319,
    quantization: 'Q4_K_M',
    family: 'llama',
    parameterSize: '494M',
    modifiedAt: '2026-10-01T00:00:00Z',
    capabilities: { tools: true, vision: false, thinking: false, embeddings: false, completion: true },
    ...overrides,
  });

  it('rates installed models from the layer shapes Ollama reports, reading each tag once', async () => {
    const { service, runtime, hardware } = harness();
    runtime.list.mockResolvedValue([installed()]);

    const first = await service.installed();
    expect(first.ok && first.models[0].fit).toMatchObject({ level: 'fits', basis: 'arch' });
    await service.installed();
    expect(runtime.inspect).toHaveBeenCalledTimes(1);
    expect(runtime.inspect).toHaveBeenCalledWith('small:latest', { tags: false });
    expect(hardware).toHaveBeenCalledTimes(1);

    runtime.list.mockResolvedValue([installed({ modifiedAt: '2026-10-02T00:00:00Z' })]);
    await service.installed();
    expect(runtime.inspect).toHaveBeenCalledTimes(2);
  });

  it('reads only a few installed models from Ollama at once', async () => {
    const { service, runtime } = harness();
    runtime.list.mockResolvedValue(Array.from({ length: 10 }, (_, index) => installed({ name: `m${index}:latest` })));
    let active = 0;
    let peak = 0;
    runtime.inspect.mockImplementation(async () => {
      active++;
      peak = Math.max(peak, active);
      await new Promise(resolve => setTimeout(resolve, 1));
      active--;
      throw new LocalRuntimeError('show timed out', 'ollama');
    });

    const result = await service.installed();
    expect(result.ok && result.models).toHaveLength(10);
    expect(runtime.inspect).toHaveBeenCalledTimes(10);
    expect(peak).toBeLessThanOrEqual(4);
  });

  it('falls back to the file size when Ollama cannot describe a model, and reads it again next time', async () => {
    const { service, runtime } = harness();
    runtime.list.mockResolvedValue([installed(), installed({ name: 'mystery:latest', sizeBytes: null })]);
    runtime.inspect.mockRejectedValueOnce(new LocalRuntimeError('show timed out', 'ollama'));

    const first = await service.installed();
    expect(first.ok && first.models.map(model => [model.name, model.fit?.basis ?? null])).toEqual([
      ['mystery:latest', null],
      ['small:latest', 'size'],
    ]);
    const second = await service.installed();
    expect(second.ok && second.models[1].fit?.basis).toBe('arch');
  });

  it('plans an installed model for the context chat sizes it with under the Settings choice', async () => {
    const contexts = async (setting: LocalContextSetting) => {
      const { service, runtime } = harness({ setting });
      runtime.list.mockResolvedValue([
        installed(),
        installed({ name: 'long:latest' }),
        installed({ name: 'huge:latest' }),
      ]);
      const parameters: Record<string, string> = { 'long:latest': 'num_ctx 24576', 'huge:latest': 'num_ctx 131072' };
      const base = await runtime.inspect('x');
      runtime.inspect.mockImplementation(async (name: string) => ({ ...base, parameters: parameters[name] ?? null }));
      const result = await service.installed();
      return result.ok ? result.models.map(model => [model.name, model.fit?.context]) : [];
    };

    // Auto runs a model that stays resident at its trained length, past any smaller num_ctx.
    expect(await contexts(AUTO_LOCAL_CONTEXT)).toEqual([
      ['huge:latest', 32768],
      ['long:latest', 32768],
      ['small:latest', 32768],
    ]);
    expect(await contexts({ mode: 'fixed', tokens: 16384 })).toEqual([
      ['huge:latest', 16384],
      ['long:latest', 16384],
      ['small:latest', 16384],
    ]);
  });

  it('caps a size-rated installed model at the context limit Ollama reports, and says when none is known', async () => {
    const fitsUnder = async (setting: LocalContextSetting) => {
      const { service, runtime } = harness({ setting });
      runtime.list.mockResolvedValue([installed({ name: 'known:latest' }), installed({ name: 'unknown:latest' })]);
      const base = await runtime.inspect('x');
      runtime.inspect.mockImplementation(async (name: string) => ({
        ...base,
        arch: null,
        parameters: 'num_ctx 32768',
        contextLength: name === 'known:latest' ? 8192 : null,
      }));
      const result = await service.installed();
      return Object.fromEntries(result.ok ? result.models.map(model => [model.name, model.fit]) : []);
    };

    const auto = await fitsUnder(AUTO_LOCAL_CONTEXT);
    expect(auto['known:latest']).toMatchObject({ basis: 'size', context: 8192 });
    expect(auto['known:latest']?.detail).toContain('the 8K context chat will use');
    // Without layer shapes Auto cannot measure the model, so chat starts it at 16K whatever num_ctx says.
    expect(auto['unknown:latest']).toMatchObject({ basis: 'size', context: 16384 });
    expect(auto['unknown:latest']?.detail).toContain('the context chat will use (up to 16K)');

    const fixed = await fitsUnder({ mode: 'fixed', tokens: 65536 });
    expect(fixed['known:latest']).toMatchObject({ basis: 'size', context: 8192 });
    expect(fixed['unknown:latest']?.detail).toContain('the context chat will use (up to 64K)');
  });

  it('caps an Explore build at the context its GGUF header declares', async () => {
    const { service, hub } = harness();
    const gguf = { architecture: 'llama', contextLength: 8192, parameterCount: null };
    hub.getModel.mockResolvedValueOnce(detail({ id: 'someone/Other-GGUF', gguf }));
    const capped = await service.detail('someone/Other-GGUF');
    expect(capped.ok && capped.model.builds[0].fit).toMatchObject({ basis: 'size', context: 8192 });

    hub.getModel.mockResolvedValueOnce(detail({ id: 'someone/Bare-GGUF' }));
    const bare = await service.detail('someone/Bare-GGUF');
    expect(bare.ok && bare.model.builds[0].fit?.detail).toContain('(up to 16K)');
  });

  it('uses a size estimate when a same-sized curated file has different weights', async () => {
    const { service } = harness({ detail: gsqDetail({ sha256: SHA }) });
    const view = await service.detail(GSQ_REPO);
    expect(view.ok && view.model.builds[0].fit?.basis).toBe('size');
  });

  it('rates the reviewed file of a curated repo from the manifest, and any other file by size', async () => {
    const other = build({ id: 'other-q4_k_m', files: [{ ...build().files[0], path: 'other-q4_k_m.gguf' }] });
    const { service } = harness({ detail: gsqDetail({}, { builds: [...gsqDetail().builds, other] }) });
    const view = await service.detail(GSQ_REPO);
    expect(view.ok && view.model.builds.map(entry => entry.fit?.basis)).toEqual(['arch', 'size']);
  });
});

describe('ModelHubService curated list', () => {
  const pickNames = async (hardware: HardwareProfile, version?: string) => {
    const list = await harness({ hardware, version }).service.curated();
    return list.picks.map(pick => `${pick.slot}:${pick.entryId}/${pick.buildId}${pick.recommended ? ' *' : ''}`);
  };

  it('rates every build at the fixed context Settings gives local chat', async () => {
    const list = await harness({ setting: { mode: 'fixed', tokens: 32768 } }).service.curated();
    const contexts = list.entries.flatMap(entry => entry.builds.map(build => build.fit.context));
    expect(contexts.length).toBeGreaterThan(0);
    expect(new Set(contexts)).toEqual(new Set([32768]));
  });

  it('lists every pick, smallest download first, with its fit, and downloads nothing', async () => {
    const { service, runtime, libraryLayers, hub, hardware } = harness();
    const list = await service.curated();

    expect(list.updatedAt).toBe(CURATED.updatedAt);
    expect(list.entries.map(entry => entry.id)).toEqual([
      'qwen3-5-0-8b',
      'qwen3-5-4b',
      'gemma-4-e4b',
      'gemma-4-12b',
      'qwen3-8-27b-gsq',
      'gemma-4-26b',
      'qwen3-8-27b',
    ]);
    expect(list.machine).toEqual({
      memoryKind: 'cpu',
      totalMemoryBytes: 16 * GIB,
      gpuMemoryBytes: null,
      gpuName: null,
    });
    expect(list.entries.every(entry => entry.vision && entry.thinking && entry.tools)).toBe(true);
    expect(list.entries.find(entry => entry.id === 'gemma-4-26b')).toMatchObject({
      params: '25.2B, 3.8B active',
      licenseName: 'apache-2.0',
      licenseKind: 'permissive',
      sourceName: 'Ollama',
      sourceUrl: 'https://ollama.com/library/gemma4',
      builds: [
        {
          id: 'qat-q4-0',
          repo: 'gemma4:26b-a4b-it-qat',
          pullBuildId: 'qat-q4-0',
          ollamaRef: 'gemma4:26b-a4b-it-qat',
          fit: { basis: 'arch' },
          blockedReason: null,
        },
      ],
    });
    expect(list.entries.find(entry => entry.id === 'qwen3-8-27b-gsq')).toMatchObject({
      sourceName: 'Hugging Face',
      sourceUrl: `https://huggingface.co/${GSQ_REPO}`,
      builds: [
        {
          id: 'iq3-s',
          repo: GSQ_REPO,
          pullBuildId: 'Qwen3.8-27B-GSQ-RCO-IQ3_S',
          ollamaRef: IQ3_REF,
          sizeBytes: IQ3_FILE.sizeBytes + 931_146_528,
        },
        { id: 'iq2-xs' },
      ],
    });
    await service.curated();
    expect(hardware).toHaveBeenCalledTimes(1);
    expect(runtime.pull).not.toHaveBeenCalled();
    expect(libraryLayers).not.toHaveBeenCalled();
    expect(hub.getModel).not.toHaveBeenCalled();
  });

  it.each([
    [
      'a CPU-only computer',
      machine('cpu', 62),
      ['best:gemma-4-26b/qat-q4-0 *', 'fast:qwen3-5-4b/q4-k-m', 'light:qwen3-5-0-8b/q8-0'],
    ],
    ['a 6 GB GPU', machine('discrete', 32, 6), ['best:qwen3-5-0-8b/q8-0 *']],
    [
      'an 8 GB GPU',
      machine('discrete', 32, 7.6),
      ['best:qwen3-5-4b/q4-k-m *', 'fast:qwen3-5-0-8b/q8-0', 'long-context:gemma-4-e4b/qat-q4-0'],
    ],
    [
      'a 16 GB GPU',
      machine('discrete', 32, 15.9),
      ['best:qwen3-8-27b-gsq/iq3-s *', 'fast:gemma-4-12b/qat-q4-0', 'long-context:qwen3-8-27b-gsq/iq2-xs'],
    ],
    [
      'a 32 GB GPU',
      machine('discrete', 64, 31.8),
      ['best:qwen3-8-27b/q4-k-m *', 'fast:gemma-4-26b/qat-q4-0', 'long-context:qwen3-8-27b-gsq/iq3-s'],
    ],
    [
      'a 64 GB Mac',
      machine('unified', 64),
      ['best:qwen3-8-27b/q8-0 *', 'fast:gemma-4-26b/qat-q4-0', 'long-context:qwen3-8-27b/q4-k-m'],
    ],
    ['an 8 GB Mac, which the list has no picks for', machine('unified', 8), []],
  ])('picks for %s, Best recommended', async (_label, hardware, expected) => {
    expect(await pickNames(hardware)).toEqual(expected);
  });

  it('moves Recommended to the next pick that fits when Best does not', async () => {
    const picks = await harness({ hardware: machine('cpu', 8) }).service.curated();
    const best = picks.entries.find(entry => entry.id === 'gemma-4-26b')?.builds[0];
    expect(best?.fit.level).toBe('too-large');
    expect(picks.picks.map(pick => [pick.slot, pick.recommended])).toEqual([
      ['best', false],
      ['fast', true],
      ['light', false],
    ]);
  });

  it('keeps a pick that needs a newer Ollama, with Download off, and recommends the next one', async () => {
    const { service } = harness({ hardware: machine('cpu', 62), version: '0.30.0' });
    const list = await service.curated();
    const blocked = Object.fromEntries(
      list.entries.flatMap(entry => entry.builds.map(build => [`${entry.id}/${build.id}`, build.blockedReason]))
    );
    expect(blocked).toMatchObject({
      'qwen3-5-0-8b/q8-0': null,
      'gemma-4-26b/qat-q4-0': 'Needs Ollama 0.30.6 or newer',
      'qwen3-8-27b/q4-k-m': 'Needs Ollama 0.32.12 or newer',
      'qwen3-8-27b-gsq/iq3-s': 'Needs Ollama 0.32.12 or newer',
    });
    expect(list.picks.find(pick => pick.recommended)).toMatchObject({ slot: 'fast', entryId: 'qwen3-5-4b' });
  });

  it('never lists an abliterated pick, even when the policy would show it', async () => {
    const manifest: HubManifest = structuredClone(CURATED);
    manifest.policy.abliterated = 'curated-opt-in';
    manifest.entries[0].flags.abliterated = true;
    manifest.entries[1].lineage.variantType = 'abliterated';
    const library = libraryOf(manifest.entries[2].builds[0]);
    if (library) library.ref = 'gemma4:e4b-abliterated';
    const { service } = harness({ curated: manifest, hardware: machine('discrete', 32, 7.6) });

    const list = await service.curated();
    expect(list.entries.map(entry => entry.id)).not.toEqual(expect.arrayContaining(['qwen3-5-0-8b']));
    expect(list.entries.map(entry => entry.id).slice(0, 2)).toEqual(['gemma-4-12b', 'qwen3-8-27b-gsq']);
    expect(list.picks).toEqual([]);
    expect(await service.curatedPull('qwen3-5-0-8b', 'q8-0')).toMatchObject({
      ok: false,
      error: { kind: 'not-found' },
    });
  });

  it('labels a pick restricted when its own or its base license is not permissive, or hides it by policy', async () => {
    const manifest: HubManifest = structuredClone(CURATED);
    manifest.entries[0].license.class = 'non-commercial';
    manifest.entries[1].license.base.class = 'restricted-commercial';
    const kinds = Object.fromEntries(
      (await harness({ curated: manifest }).service.curated()).entries.map(entry => [entry.id, entry.licenseKind])
    );
    expect(kinds).toMatchObject({
      'qwen3-5-0-8b': 'restricted',
      'qwen3-5-4b': 'restricted',
      'gemma-4-e4b': 'permissive',
    });

    manifest.policy.restrictedLicense = 'hidden';
    const ids = (await harness({ curated: manifest }).service.curated()).entries.map(entry => entry.id);
    expect(ids).not.toContain('qwen3-5-0-8b');
    expect(ids).not.toContain('qwen3-5-4b');
  });

  it('never offers an hf.co build whose template is not pinned, and leaves its slot empty', async () => {
    const manifest: HubManifest = structuredClone(CURATED);
    const gsq = manifest.entries.find(entry => entry.id === 'qwen3-8-27b-gsq');
    const pins = pinsOf(gsq?.builds.find(candidate => candidate.id === 'iq3-s') as HubBuild);
    if (!pins) throw new Error('no pins');
    delete pins.installedTemplate;
    const { service, hub } = harness({ curated: manifest, hardware: machine('discrete', 32, 15.9) });

    const list = await service.curated();
    expect(list.entries.find(entry => entry.id === 'qwen3-8-27b-gsq')?.builds.map(build => build.id)).toEqual([
      'iq2-xs',
    ]);
    expect(list.picks.map(pick => pick.slot)).toEqual(['fast', 'long-context']);
    expect(await service.curatedPull('qwen3-8-27b-gsq', 'iq3-s')).toMatchObject({
      ok: false,
      error: { kind: 'not-found' },
    });
    expect(hub.getModel).not.toHaveBeenCalled();
  });

  it('keeps a pick listed with Download off while Ollama reports no version, and refuses its download', async () => {
    const { service, runtime, libraryLayers } = harness({ hardware: machine('cpu', 62), version: null });
    const list = await service.curated();
    const best = list.entries.find(entry => entry.id === 'gemma-4-26b')?.builds[0];
    expect(best?.blockedReason).toBe('Needs Ollama 0.30.6 or newer, and Ollama did not report its version');
    expect(list.picks.map(pick => pick.slot)).toEqual(['best', 'fast', 'light']);
    expect(list.picks.find(pick => pick.recommended)?.slot).not.toBe('best');

    const refusal = { ok: false, error: { kind: 'cannot-pull', message: expect.stringContaining('did not report') } };
    expect(await service.curatedPull('gemma-4-26b', 'qat-q4-0')).toMatchObject(refusal);
    const reviewed = CURATED.entries.find(entry => entry.id === 'gemma-4-26b')?.builds[0];
    const library = reviewed && libraryOf(reviewed);
    if (!reviewed || !library) throw new Error('the bundled list lost its Gemma 4 26B pick');
    const pull = await service.pull({
      repo: library.ref,
      buildId: reviewed.id,
      revision: library.digest,
      sizeBytes: library.sizeBytes,
      acceptLicense: false,
      confirmAccess: false,
      curated: { entryId: 'gemma-4-26b', buildId: reviewed.id },
    });
    expect(pull).toMatchObject(refusal);
    expect(libraryLayers).not.toHaveBeenCalled();
    expect(runtime.pull).not.toHaveBeenCalled();
  });

  it.each<[string, (manifest: HubManifest) => void]>([
    ['its name', manifest => (manifest.entries[0].name = 'Qwen3.5 0.8B Uncensored')],
    ['its id', manifest => (manifest.entries[0].id = 'qwen3-5-0-8b-abliterated')],
    ['its base model', manifest => (manifest.entries[0].lineage.base = 'huihui-ai/Qwen3.5-0.8B-abliterated')],
  ])('never lists an entry whose %s marks it abliterated', async (_label, edit) => {
    const manifest: HubManifest = structuredClone(CURATED);
    const id = manifest.entries[0].id;
    edit(manifest);
    const { service } = harness({ curated: manifest, hardware: machine('cpu', 62) });
    const list = await service.curated();
    expect(list.entries.map(entry => entry.id)).not.toContain(manifest.entries[0].id);
    expect(list.entries).toHaveLength(CURATED.entries.length - 1);
    expect(list.picks.map(pick => pick.entryId)).not.toContain(id);
  });

  it('never lists a chat entry trained on less than a 16K context', async () => {
    const manifest: HubManifest = structuredClone(CURATED);
    manifest.entries[0].arch.contextMax = 8192;
    const { service } = harness({ curated: manifest });
    expect((await service.curated()).entries.map(entry => entry.id)).not.toContain(manifest.entries[0].id);
    expect(await service.curatedPull(manifest.entries[0].id, manifest.entries[0].builds[0].id)).toMatchObject({
      ok: false,
      error: { kind: 'not-found' },
    });
  });
});

describe('ModelHubService curated library pulls', () => {
  const LIBRARY = CURATED.entries.find(entry => entry.id === 'gemma-4-e4b');
  const E4B = LIBRARY?.builds[0];
  const E4B_LIBRARY = E4B && libraryOf(E4B);
  if (!LIBRARY || !E4B || !E4B_LIBRARY) throw new Error('the bundled list lost its Gemma 4 E4B pick');
  const REF = E4B_LIBRARY.ref;
  const libraryRequest = {
    repo: REF,
    buildId: E4B.id,
    revision: E4B_LIBRARY.digest,
    sizeBytes: E4B_LIBRARY.sizeBytes,
    acceptLicense: false,
    confirmAccess: false,
    curated: { entryId: LIBRARY.id, buildId: E4B.id },
  };
  const reviewed = () => {
    const layers = reviewedLayers(E4B);
    if (!layers) throw new Error('no reviewed layers');
    return layers;
  };
  const layer = (kind: string, digest = 'f'.repeat(64)) => ({
    mediaType: `application/vnd.ollama.image.${kind}`,
    digest,
  });

  it('shows the library build in the dialog without asking Hugging Face, with the fit of its row', async () => {
    const { service, hub, libraryLayers } = harness();
    const row = (await service.curated()).entries.find(entry => entry.id === LIBRARY.id)?.builds[0];
    const dialog = await service.curatedPull(LIBRARY.id, E4B.id);

    expect(dialog).toMatchObject({
      ok: true,
      model: {
        id: REF,
        revision: E4B_LIBRARY.digest,
        url: `https://ollama.com/library/${REF}`,
        licenseNames: ['apache-2.0'],
        licenseHost: 'ollama.com',
        licenseKind: 'permissive',
        projectorBytes: null,
        needsAccess: false,
      },
      build: { id: E4B.id, sizeBytes: E4B_LIBRARY.sizeBytes, ollamaRef: REF },
    });
    expect(dialog.ok && dialog.build.fit).toEqual(row?.fit);
    expect(libraryLayers).toHaveBeenCalledWith(REF, expect.anything());
    expect(hub.getModel).not.toHaveBeenCalled();
  });

  it.each([
    ['a different template', () => ({ ...reviewed(), others: [...reviewed().others, layer('template')] })],
    [
      'a different license',
      () => ({
        ...reviewed(),
        others: reviewed().others.map(l => (l.mediaType.endsWith('license') ? layer('license') : l)),
      }),
    ],
    [
      'a different projector',
      () => ({
        ...reviewed(),
        others: reviewed().others.map(l => (l.mediaType.endsWith('projector') ? layer('projector') : l)),
      }),
    ],
    ['no params', () => ({ ...reviewed(), others: reviewed().others.filter(l => !l.mediaType.endsWith('params')) })],
    ['an extra layer', () => ({ ...reviewed(), others: [...reviewed().others, layer('system')] })],
    ['different weights', () => ({ ...reviewed(), model: 'f'.repeat(64) })],
  ])('refuses the dialog and the pull once the library serves %s', async (_label, live) => {
    const { service, libraryLayers, runtime } = harness();
    libraryLayers.mockResolvedValue(live());
    const expected = {
      ok: false,
      error: { kind: 'upstream-changed', message: expect.stringContaining('changed at its source') },
    };

    expect(await service.curatedPull(LIBRARY.id, E4B.id)).toMatchObject(expected);
    expect(await service.pull(libraryRequest)).toMatchObject(expected);
    expect(runtime.pull).not.toHaveBeenCalled();
    expect(service.pulls()).toEqual([]);
  });

  it('says the build is gone when the library has no such tag', async () => {
    const { service, libraryLayers } = harness();
    libraryLayers.mockResolvedValueOnce(null);
    expect(await service.curatedPull(LIBRARY.id, E4B.id)).toMatchObject({
      ok: false,
      error: {
        kind: 'upstream-changed',
        message: `The Ollama library no longer serves ${REF}, so Curated cannot offer it.`,
      },
    });
  });

  it('checks the layers, pulls the library ref, and keeps what Ollama installed as reviewed', async () => {
    const { service, runtime, libraryLayers, pulls, installedChanged, hub } = harness();
    const result = service.pull(libraryRequest);
    await vi.waitFor(() => expect(pulls).toHaveLength(1));
    expect(runtime.pull).toHaveBeenCalledWith(REF, expect.objectContaining({ runner: 'llamacpp' }));
    expect(libraryLayers).toHaveBeenCalledWith(REF, expect.anything());
    pulls[0].resolve();

    await expect(result).resolves.toEqual({ ok: true, ref: REF });
    expect(runtime.remove).not.toHaveBeenCalled();
    expect(installedChanged).toHaveBeenCalled();
    expect(service.pulls()).toEqual([]);
    expect(hub.getModel).not.toHaveBeenCalled();
    expect(hub.verifyOllamaRef).not.toHaveBeenCalled();
  });

  it('keeps a renderer-backed library build whatever placeholder template Ollama shows for it', async () => {
    const { service, runtime, pulls } = harness();
    const base = await runtime.inspect(REF);
    runtime.inspect.mockResolvedValueOnce({ ...base, contents: base.contents && { ...base.contents, template: 'x' } });
    const result = service.pull(libraryRequest);
    await vi.waitFor(() => expect(pulls).toHaveLength(1));
    pulls[0].resolve();

    await expect(result).resolves.toEqual({ ok: true, ref: REF });
    expect(runtime.remove).not.toHaveBeenCalled();
  });

  it('checks a pull against the list it started with when the list changes mid-download', async () => {
    const updated = structuredClone(CURATED);
    const moved = updated.entries.find(entry => entry.id === LIBRARY.id)?.builds[0].ollama;
    if (moved?.kind !== 'library') throw new Error('no library build');
    moved.digest = 'e'.repeat(64);
    let list = CURATED;
    const { service, runtime, pulls } = harness({ curated: () => list });
    const result = service.pull(libraryRequest);
    await vi.waitFor(() => expect(pulls).toHaveLength(1));
    list = updated;
    pulls[0].resolve();

    await expect(result).resolves.toEqual({ ok: true, ref: REF });
    expect(runtime.remove).not.toHaveBeenCalled();
    expect(await service.pull(libraryRequest)).toMatchObject({ ok: false, error: { kind: 'changed' } });
  });

  /** Pulls E4B to completion with Ollama reporting `installed` for it; resolves with the pull's result. */
  async function pulledAs(
    setup: ReturnType<typeof harness>,
    installed: (base: ModelInspection) => ModelInspection | Promise<ModelInspection>
  ) {
    const base = await setup.runtime.inspect(REF);
    setup.runtime.inspect.mockImplementationOnce(async () => installed(base));
    const result = setup.service.pull(libraryRequest);
    await vi.waitFor(() => expect(setup.pulls).toHaveLength(1));
    setup.pulls[0].resolve();
    return result;
  }
  const otherWeights = (b: ModelInspection) => ({ ...b, contents: b.contents && { ...b.contents, modelBlob: SHA } });

  const showTimedOut = () =>
    new RuntimeConnectionError('ollama /api/show failed: timed out after 10000ms', 'ollama', {
      cause: new DOMException('timed out', 'TimeoutError'),
    });
  const readsOf = (runtime: ReturnType<typeof harness>['runtime']) =>
    runtime.inspect.mock.calls.filter(([name]) => name === REF);

  const cancelledCheck = expect.stringMatching(/^Download cancelled while .* It is still installed/);

  /** Pulls E4B to completion and resolves with the pull's result. */
  async function pulled(setup: ReturnType<typeof harness>) {
    const result = setup.service.pull(libraryRequest);
    await vi.waitFor(() => expect(setup.pulls).toHaveLength(1));
    setup.pulls[0].resolve();
    return result;
  }

  it('reads the model again after one failed read, and keeps it as checked', async () => {
    const setup = harness();
    setup.runtime.inspect.mockRejectedValueOnce(showTimedOut());

    expect(await pulled(setup)).toEqual({ ok: true, ref: REF });
    expect(readsOf(setup.runtime)).toHaveLength(2);
    expect(readsOf(setup.runtime)[1][1]).toMatchObject({
      tags: false,
      signal: expect.any(AbortSignal),
      timeoutMs: 30_000,
    });
    expect(setup.runtime.remove).not.toHaveBeenCalled();
    expect(setup.service.pulls()).toEqual([]);
    expect(setup.warn).toHaveBeenCalledTimes(1);
    expect(setup.warn.mock.calls[0][0]).toContain(`could not describe ${REF} after its download (read 1 of 3`);
  });

  it('keeps the model, saying it could not be checked, and logs why when every read fails', async () => {
    const setup = harness();
    setup.runtime.inspect.mockRejectedValue(showTimedOut());
    const result = await pulled(setup);

    expect(result).toMatchObject({
      ok: false,
      error: { kind: 'unverified', message: expect.stringContaining(`${REF} after downloading it`) },
    });
    expect(result.ok || result.error.message).toContain('It is still installed');
    expect(result).toMatchObject({ listed: true });
    expect(setup.service.pulls()).toMatchObject([{ phase: 'failed', ref: REF, error: { kind: 'unverified' } }]);
    expect(readsOf(setup.runtime)).toHaveLength(3);
    expect(setup.runtime.remove).not.toHaveBeenCalled();
    expect(setup.installedChanged).toHaveBeenCalled();
    expect(setup.warn.mock.calls.map(([line]) => line)).toEqual(
      [1, 2, 3].map(read => expect.stringContaining(`read ${read} of 3`))
    );
    expect(setup.warn.mock.calls[2][0]).toContain('timed out after 10000ms');
  });

  it('stops reading at once when the download is cancelled between reads, keeping the model', async () => {
    const setup = harness({ checkBackoffMs: [60_000, 60_000] });
    setup.runtime.inspect.mockRejectedValue(showTimedOut());
    const result = setup.service.pull(libraryRequest);
    await vi.waitFor(() => expect(setup.pulls).toHaveLength(1));
    setup.pulls[0].resolve();
    await vi.waitFor(() => expect(setup.warn).toHaveBeenCalledTimes(1));
    setup.service.cancel(pullKey(libraryRequest.repo, libraryRequest.buildId));

    await expect(result).resolves.toMatchObject({ ok: false, error: { kind: 'unverified', message: cancelledCheck } });
    expect(readsOf(setup.runtime)).toHaveLength(1);
    expect(setup.runtime.remove).not.toHaveBeenCalled();
    expect(setup.service.pulls()).toMatchObject([{ phase: 'failed', error: { kind: 'unverified' } }]);
  });

  it('stops a read in flight when the download is cancelled', async () => {
    const setup = harness();
    setup.runtime.inspect.mockImplementation(
      (_name, options) =>
        new Promise((_resolve, reject) =>
          options?.signal?.addEventListener('abort', () => reject(options.signal?.reason))
        )
    );
    const result = setup.service.pull(libraryRequest);
    await vi.waitFor(() => expect(setup.pulls).toHaveLength(1));
    setup.pulls[0].resolve();
    await vi.waitFor(() => expect(readsOf(setup.runtime)).toHaveLength(1));
    setup.service.cancel(pullKey(libraryRequest.repo, libraryRequest.buildId));

    await expect(result).resolves.toMatchObject({ ok: false, error: { kind: 'unverified', message: cancelledCheck } });
    expect(readsOf(setup.runtime)).toHaveLength(1);
    expect(setup.runtime.remove).not.toHaveBeenCalled();
  });

  it('checks an unverified download again on request', async () => {
    const setup = harness();
    for (let read = 0; read < 3; read++) setup.runtime.inspect.mockRejectedValueOnce(showTimedOut());
    expect(await pulled(setup)).toMatchObject({ ok: false, error: { kind: 'unverified' } });
    setup.installedChanged.mockClear();

    expect(await setup.service.checkCurated(LIBRARY.id, E4B.id)).toEqual({ ok: true });
    expect(readsOf(setup.runtime)).toHaveLength(4);
    expect(setup.service.pulls()).toEqual([]);
    expect(setup.installedChanged).toHaveBeenCalled();
    expect(await setup.service.checkCurated(LIBRARY.id, 'no-such-build')).toMatchObject({
      ok: false,
      error: { kind: 'not-found' },
    });
  });

  it('clears a failed download when dismissed, keeping the model installed', async () => {
    const setup = harness();
    setup.runtime.inspect.mockRejectedValue(showTimedOut());
    expect(await pulled(setup)).toMatchObject({ ok: false, error: { kind: 'unverified' } });
    const key = pullKey(libraryRequest.repo, libraryRequest.buildId);

    setup.service.dismiss('no-such-pull');
    expect(setup.service.pulls()).toHaveLength(1);
    setup.service.dismiss(key);
    expect(setup.service.pulls()).toEqual([]);
    expect(setup.pushed.at(-1)).toEqual([]);
    expect(setup.runtime.remove).not.toHaveBeenCalled();
  });

  it('leaves an active download in place when dismissed', async () => {
    const setup = harness();
    const result = setup.service.pull(libraryRequest);
    await vi.waitFor(() => expect(setup.pulls).toHaveLength(1));

    setup.service.dismiss(pullKey(libraryRequest.repo, libraryRequest.buildId));
    expect(setup.service.pulls()).toMatchObject([{ phase: 'downloading' }]);
    setup.pulls[0].resolve();
    await expect(result).resolves.toEqual({ ok: true, ref: REF });
  });

  it('keeps a warning after a failed removal, then clears it when the user removes the model', async () => {
    const setup = harness();
    setup.runtime.inspect.mockRejectedValue(showTimedOut());
    await pulled(setup);
    setup.runtime.remove.mockRejectedValueOnce(new Error('busy'));
    expect(await setup.service.remove(REF)).toMatchObject({ ok: false });
    expect(setup.service.pulls()).toHaveLength(1);
    expect(await setup.service.remove(REF)).toEqual({ ok: true });
    expect(setup.service.pulls()).toEqual([]);
  });

  it('checks again against one snapshot of the list as it is now', async () => {
    let list = CURATED;
    const getter = vi.fn(() => list);
    const setup = harness({ curated: getter });
    for (let read = 0; read < 3; read++) setup.runtime.inspect.mockRejectedValueOnce(showTimedOut());
    expect(await pulled(setup)).toMatchObject({ ok: false, error: { kind: 'unverified' } });

    list = { ...structuredClone(CURATED), entries: CURATED.entries.filter(entry => entry.id !== LIBRARY.id) };
    getter.mockClear();
    expect(await setup.service.checkCurated(LIBRARY.id, E4B.id)).toMatchObject({
      ok: false,
      error: { kind: 'not-found' },
    });
    expect(getter).toHaveBeenCalledTimes(1);
  });

  it('removes an unverified download that a later check finds unreviewed, when Ollama lacked the tag', async () => {
    const setup = harness();
    const base = await setup.runtime.inspect(REF);
    setup.runtime.inspect.mockRejectedValue(showTimedOut());
    expect(await pulled(setup)).toMatchObject({ ok: false, error: { kind: 'unverified' } });
    setup.runtime.inspect.mockResolvedValue(otherWeights(base));

    expect(await setup.service.checkCurated(LIBRARY.id, E4B.id)).toMatchObject({
      ok: false,
      error: { kind: 'upstream-changed', message: expect.stringContaining('removed what Ollama downloaded') },
    });
    expect(setup.runtime.remove).toHaveBeenCalledWith(REF);
  });

  it('names the unreviewed model still installed when removing it fails', async () => {
    const setup = harness();
    setup.runtime.remove.mockRejectedValueOnce(new LocalRuntimeError('delete failed', 'ollama'));
    const result = await pulledAs(setup, otherWeights);

    expect(result).toMatchObject({ ok: false, error: { kind: 'upstream-changed' } });
    const message = result.ok ? '' : result.error.message;
    expect(message).toContain(`the unreviewed model ${REF} is still installed`);
    expect(message).not.toContain('removed');
    expect(result).toMatchObject({ listed: true });
    expect(setup.service.pulls()).toMatchObject([{ phase: 'failed', error: { message } }]);
    expect(setup.runtime.remove).toHaveBeenCalledWith(REF);
  });

  it('still removes a model that fails the check when the download is cancelled during it', async () => {
    const setup = harness();
    let answer: (() => void) | undefined;
    const result = pulledAs(
      setup,
      base => new Promise<ModelInspection>(resolve => (answer = () => resolve(otherWeights(base))))
    );
    await vi.waitFor(() => expect(answer).toBeDefined());
    setup.service.cancel(pullKey(REF, E4B.id));
    answer?.();

    expect(await result).toMatchObject({
      ok: false,
      error: { kind: 'upstream-changed', message: expect.stringContaining('Bike4Mind removed what Ollama downloaded') },
    });
    expect(setup.runtime.remove).toHaveBeenCalledWith(REF);
    expect(setup.service.pulls()).toMatchObject([{ phase: 'failed', error: { kind: 'upstream-changed' } }]);
  });

  it.each([
    ['listed before the pull', async () => [(await harness().runtime.inspect(REF)).model], 'installed before'],
    ['unknown because the list failed', () => Promise.reject(new Error('busy')), 'could not tell'],
  ])('never removes a tag %s, even when what Ollama installed fails the check', async (_label, listed, says) => {
    const setup = harness();
    setup.runtime.list.mockImplementationOnce(listed);
    const result = await pulledAs(setup, otherWeights);

    expect(result).toMatchObject({
      ok: false,
      error: { kind: 'upstream-changed', message: expect.stringContaining(says) },
    });
    expect(setup.runtime.remove).not.toHaveBeenCalled();
    expect(result).toMatchObject({ listed: true });
    expect(setup.service.pulls()).toMatchObject([
      { phase: 'failed', error: { message: expect.stringContaining(says) } },
    ]);
  });

  it.each([
    ['listed before the pull', async () => [(await harness().runtime.inspect(REF)).model], 'installed before'],
    ['unknown because the list failed', () => Promise.reject(new Error('busy')), 'could not tell'],
  ])('never removes a tag %s when Check again finds it unreviewed', async (_label, listed, says) => {
    const setup = harness();
    const base = await setup.runtime.inspect(REF);
    setup.runtime.list.mockImplementationOnce(listed);
    for (let read = 0; read < 3; read++) setup.runtime.inspect.mockRejectedValueOnce(showTimedOut());
    expect(await pulled(setup)).toMatchObject({ ok: false, error: { kind: 'unverified' } });
    setup.runtime.inspect.mockResolvedValue(otherWeights(base));

    expect(await setup.service.checkCurated(LIBRARY.id, E4B.id)).toMatchObject({
      ok: false,
      error: { kind: 'upstream-changed', message: expect.stringContaining(says) },
    });
    expect(setup.runtime.remove).not.toHaveBeenCalled();
  });

  it('never removes a tag on Check again when no pull this session saw whether it was there', async () => {
    const setup = harness();
    setup.runtime.inspect.mockResolvedValue(otherWeights(await setup.runtime.inspect(REF)));

    expect(await setup.service.checkCurated(LIBRARY.id, E4B.id)).toMatchObject({
      ok: false,
      error: { kind: 'upstream-changed', message: expect.stringContaining('could not tell') },
    });
    expect(setup.runtime.remove).not.toHaveBeenCalled();
  });

  it('runs one check when Check again is clicked in two rows at once', async () => {
    const setup = harness();
    const base = await setup.runtime.inspect(REF);
    for (let read = 0; read < 3; read++) setup.runtime.inspect.mockRejectedValueOnce(showTimedOut());
    expect(await pulled(setup)).toMatchObject({ ok: false, error: { kind: 'unverified' } });
    let answer: (() => void) | undefined;
    setup.runtime.inspect.mockImplementationOnce(
      () => new Promise<ModelInspection>(resolve => (answer = () => resolve(otherWeights(base))))
    );
    const reads = readsOf(setup.runtime).length;

    const first = setup.service.checkCurated(LIBRARY.id, E4B.id);
    const second = setup.service.checkCurated(LIBRARY.id, E4B.id);
    await vi.waitFor(() => expect(answer).toBeDefined());
    answer?.();

    const [one, two] = await Promise.all([first, second]);
    expect(one).toMatchObject({ ok: false, error: { message: expect.stringContaining('removed what Ollama') } });
    expect(two).toBe(one);
    expect(readsOf(setup.runtime)).toHaveLength(reads + 1);
    expect(setup.runtime.remove).toHaveBeenCalledTimes(1);
  });

  it('reports a model removed while its post-download check was pending as gone, not still installed', async () => {
    const setup = harness();
    setup.runtime.inspect.mockRejectedValueOnce(new ModelNotFoundError('ollama', REF));

    expect(await pulled(setup)).toEqual({ ok: true, ref: REF });
    expect(readsOf(setup.runtime)).toHaveLength(1);
    expect(setup.service.pulls()).toEqual([]);
    expect(setup.runtime.remove).not.toHaveBeenCalled();
  });

  it.each([
    [
      'still lists it',
      async (): Promise<InstalledModel[]> => [
        {
          name: REF,
          sizeBytes: 1,
          quantization: null,
          family: null,
          parameterSize: null,
          modifiedAt: null,
          capabilities: { tools: false, vision: false, thinking: false, embeddings: false, completion: true },
        },
      ],
    ],
    ['cannot be read', async (): Promise<InstalledModel[]> => Promise.reject(new Error('list failed'))],
  ])('keeps a pulled model unverified when its read 404s but Ollama %s', async (_, listAfter) => {
    const setup = harness();
    setup.runtime.inspect.mockRejectedValueOnce(new ModelNotFoundError('ollama', REF));
    setup.runtime.list.mockImplementationOnce(async () => []).mockImplementationOnce(listAfter);

    expect(await pulled(setup)).toMatchObject({ ok: false, error: { kind: 'unverified' } });
    expect(setup.runtime.remove).not.toHaveBeenCalled();
  });

  it('clears the warning when Check again finds the unverified model already gone', async () => {
    const setup = harness();
    for (let read = 0; read < 3; read++) setup.runtime.inspect.mockRejectedValueOnce(showTimedOut());
    expect(await pulled(setup)).toMatchObject({ ok: false, error: { kind: 'unverified' } });
    setup.runtime.inspect.mockRejectedValueOnce(new ModelNotFoundError('ollama', REF));

    expect(await setup.service.checkCurated(LIBRARY.id, E4B.id)).toEqual({ ok: true });
    expect(readsOf(setup.runtime)).toHaveLength(4);
    expect(setup.service.pulls()).toEqual([]);
    expect(setup.runtime.remove).not.toHaveBeenCalled();
  });

  it('leaves an active download of the same model alone on Check again', async () => {
    const setup = harness();
    const result = setup.service.pull(libraryRequest);
    await vi.waitFor(() => expect(setup.service.pulls()).toMatchObject([{ phase: 'downloading' }]));

    await setup.service.checkCurated(LIBRARY.id, E4B.id);
    expect(setup.service.pulls()).toMatchObject([{ phase: 'downloading' }]);
    setup.pulls[0].resolve();
    await expect(result).resolves.toEqual({ ok: true, ref: REF });
  });

  it('remembers the tag was absent before an unverified pull when the build is pulled again', async () => {
    const setup = harness();
    const base = await setup.runtime.inspect(REF);
    for (let read = 0; read < 3; read++) setup.runtime.inspect.mockRejectedValueOnce(showTimedOut());
    expect(await pulled(setup)).toMatchObject({ ok: false, error: { kind: 'unverified' } });
    setup.runtime.list.mockResolvedValue([base.model]);
    setup.runtime.inspect.mockResolvedValueOnce(otherWeights(base));

    const again = setup.service.pull(libraryRequest);
    await vi.waitFor(() => expect(setup.pulls).toHaveLength(2));
    setup.pulls[1].resolve();
    expect(await again).toMatchObject({
      ok: false,
      error: { kind: 'upstream-changed', message: expect.stringContaining('removed what Ollama downloaded') },
    });
    expect(setup.runtime.remove).toHaveBeenCalledWith(REF);
  });

  it.each([
    ['another license', (b: ModelInspection) => ({ ...b, contents: b.contents && { ...b.contents, license: 'x' } })],
    ['an adapter', (b: ModelInspection) => ({ ...b, contents: b.contents && { ...b.contents, adapterBlobs: [SHA] } })],
    [
      'an unreadable adapter',
      (b: ModelInspection) => ({ ...b, contents: b.contents && { ...b.contents, adapterBlobs: [null] } }),
    ],
    ['no license', (b: ModelInspection) => ({ ...b, contents: b.contents && { ...b.contents, license: null } })],
    ['other weights', (b: ModelInspection) => ({ ...b, contents: b.contents && { ...b.contents, modelBlob: SHA } })],
    [
      'another projector',
      (b: ModelInspection) => ({ ...b, contents: b.contents && { ...b.contents, projectorBlobs: [SHA] } }),
    ],
    ['no projector', (b: ModelInspection) => ({ ...b, contents: b.contents && { ...b.contents, projectorBlobs: [] } })],
    [
      'an extra projector',
      (b: ModelInspection) => ({
        ...b,
        contents: b.contents && { ...b.contents, projectorBlobs: [...(b.contents.projectorBlobs ?? []), SHA] },
      }),
    ],
    [
      'an unreadable projector',
      (b: ModelInspection) => ({ ...b, contents: b.contents && { ...b.contents, projectorBlobs: [null] } }),
    ],
    [
      'an unexpected draft',
      (b: ModelInspection) => ({ ...b, contents: b.contents && { ...b.contents, draftBlobs: [SHA] } }),
    ],
    ['a num_ctx', (b: ModelInspection) => ({ ...b, parameters: 'num_ctx 8192' })],
    ['nothing to compare', (b: ModelInspection) => ({ ...b, contents: undefined })],
  ])('removes the model when Ollama installed %s than was checked', async (_label, installed) => {
    const { service, runtime, pulls, installedChanged } = harness();
    const base = await runtime.inspect(REF);
    runtime.inspect.mockClear();
    runtime.inspect.mockImplementationOnce(async () => installed(base));
    const result = service.pull(libraryRequest);
    await vi.waitFor(() => expect(pulls).toHaveLength(1));
    pulls[0].resolve();

    expect(await result).toMatchObject({ ok: false, error: { kind: 'upstream-changed' } });
    expect(runtime.remove).toHaveBeenCalledWith(REF);
    expect(installedChanged).toHaveBeenCalledTimes(1);
    expect(service.pulls()).toMatchObject([{ phase: 'failed', error: { kind: 'upstream-changed' } }]);
  });

  it('preserves an existing tag when its installed model has an unreviewed adapter', async () => {
    const setup = harness();
    setup.runtime.list.mockResolvedValueOnce([(await setup.runtime.inspect(REF)).model]);
    const result = await pulledAs(setup, base => ({
      ...base,
      contents: base.contents && { ...base.contents, adapterBlobs: [SHA] },
    }));
    expect(result).toMatchObject({ ok: false, error: { kind: 'upstream-changed' }, listed: true });
    expect(setup.runtime.remove).not.toHaveBeenCalled();
    expect(setup.service.pulls()).toMatchObject([{ phase: 'failed', error: { kind: 'upstream-changed' } }]);
  });

  it.each([
    ['another repo', { repo: 'gemma4:latest' }, 'not-found'],
    ['another build id', { buildId: 'q8-0' }, 'not-found'],
    ['an older digest', { revision: 'e'.repeat(64) }, 'changed'],
    ['another size', { sizeBytes: 1 }, 'changed'],
  ] as const)('refuses a request naming %s without downloading', async (_label, change, kind) => {
    const { service, runtime, libraryLayers } = harness();
    expect(await service.pull({ ...libraryRequest, ...change })).toMatchObject({ ok: false, error: { kind } });
    expect(libraryLayers).not.toHaveBeenCalled();
    expect(runtime.pull).not.toHaveBeenCalled();
  });

  it('needs the license accepted for a pick whose base license is not permissive', async () => {
    const manifest: HubManifest = structuredClone(CURATED);
    const entry = manifest.entries.find(candidate => candidate.id === LIBRARY.id);
    if (!entry) throw new Error('no entry');
    entry.license.base.class = 'restricted-commercial';
    const { service, runtime, pulls } = harness({ curated: manifest });

    expect(await service.curatedPull(LIBRARY.id, E4B.id)).toMatchObject({
      ok: true,
      model: { licenseKind: 'restricted' },
    });
    expect(await service.pull(libraryRequest)).toMatchObject({ ok: false, error: { kind: 'license-required' } });
    expect(runtime.pull).not.toHaveBeenCalled();
    const result = service.pull({ ...libraryRequest, acceptLicense: true });
    await vi.waitFor(() => expect(pulls).toHaveLength(1));
    pulls[0].resolve();
    await expect(result).resolves.toMatchObject({ ok: true });
  });

  it('refuses the dialog and the pull while Ollama is older than the build needs', async () => {
    const { service, runtime, libraryLayers } = harness({ version: '0.30.5' });
    const expected = {
      ok: false,
      error: { kind: 'cannot-pull', message: expect.stringContaining('Needs Ollama 0.30.6 or newer') },
    };
    expect(await service.curatedPull(LIBRARY.id, E4B.id)).toMatchObject(expected);
    expect(await service.pull(libraryRequest)).toMatchObject(expected);
    expect(libraryLayers).not.toHaveBeenCalled();
    expect(runtime.pull).not.toHaveBeenCalled();
  });

  it('keeps a failure to reach Ollama in the pull list', async () => {
    const { service, runtime } = harness({ healthy: false });
    expect(await service.pull(libraryRequest)).toMatchObject({
      ok: false,
      error: { kind: 'runtime-unavailable' },
      listed: true,
    });
    expect(runtime.pull).not.toHaveBeenCalled();
  });
});

describe('ModelHubService curated Hugging Face pulls', () => {
  const gsqRequest = {
    repo: GSQ_REPO,
    buildId: 'Qwen3.8-27B-GSQ-RCO-IQ3_S',
    revision: 'b'.repeat(40),
    sizeBytes: IQ3_FILE.sizeBytes,
    acceptLicense: false,
    confirmAccess: false,
    curated: { entryId: GSQ.id, buildId: IQ3.id },
  };
  const gsqHarness = (options: Parameters<typeof harness>[0] = {}) => {
    const setup = harness({ detail: gsqDetail(), verified: IQ3_REF, ...options });
    setup.hub.getModel.mockImplementation(async (id: string) =>
      id === GSQ.lineage.base ? detail({ id, builds: [] }) : (options.detail ?? gsqDetail())
    );
    return setup;
  };

  it('hands back the live repo and build while the file, licenses and layers match the reviewed ones', async () => {
    const { service, hub } = gsqHarness();
    const row = (await service.curated()).entries.find(entry => entry.id === GSQ.id)?.builds[0];
    const result = await service.curatedPull(GSQ.id, IQ3.id);

    expect(result).toMatchObject({
      ok: true,
      model: { id: GSQ_REPO, revision: 'b'.repeat(40), licenseKind: 'permissive' },
      build: { id: 'Qwen3.8-27B-GSQ-RCO-IQ3_S', fit: { basis: 'arch' } },
    });
    expect(result.ok && result.build.fit).toEqual(row?.fit);
    expect(hub.getModel).toHaveBeenCalledWith(GSQ.lineage.base, expect.anything());
    expect(hub.ollamaLayers).toHaveBeenCalledWith(GSQ_REPO, 'IQ3_S', expect.anything());
  });

  it('checks the registry-proven tag when the quant-only tag cannot serve the reviewed file', async () => {
    const tag = 'Qwen3.8-27B-GSQ-RCO-IQ3_S';
    const { service, hub } = gsqHarness({ verified: `hf.co/${GSQ_REPO}:${tag}` });
    hub.ollamaLayers.mockImplementation(async (_repo, candidate) => (candidate === tag ? reviewedLayers(IQ3) : null));
    expect(await service.curatedPull(GSQ.id, IQ3.id)).toMatchObject({ ok: true });
    expect(hub.ollamaLayers).toHaveBeenCalledWith(GSQ_REPO, tag, expect.anything());
  });

  it('rates the dialog build exactly as its row, from the pinned projector and context, not the live repo', async () => {
    const projectors = [
      ...gsqDetail().projectors,
      { path: 'mmproj-F32.gguf', quant: 'F32', sizeBytes: 1_862_293_056, sha256: 'd'.repeat(64), url: 'https://x' },
    ];
    const gguf = { architecture: 'qwen35', contextLength: 8192, parameterCount: null };
    for (const hardware of [CPU_16, machine('discrete', 32, 15.9), machine('unified', 64)]) {
      const { service } = gsqHarness({ hardware, detail: gsqDetail({}, { projectors, gguf }) });
      const row = (await service.curated()).entries.find(entry => entry.id === GSQ.id)?.builds[0];
      const result = await service.curatedPull(GSQ.id, IQ3.id);

      expect(result.ok && result.build.fit).toEqual(row?.fit);
      expect(result.ok && result.model.projectorBytes).toBe(931_146_528);
      expect(result.ok && result.build.sizeBytes + (result.model.projectorBytes ?? 0)).toBe(row?.sizeBytes);
    }
  });

  it('refuses the dialog and the pull once Hugging Face tags the repo abliterated', async () => {
    const { service, runtime } = gsqHarness({ detail: gsqDetail({}, { tags: ['gguf', 'abliterated'] }) });
    const expected = {
      ok: false,
      error: { kind: 'upstream-changed', message: expect.stringContaining('abliterated') },
    };
    expect(await service.curatedPull(GSQ.id, IQ3.id)).toMatchObject(expected);
    expect(await service.pull(gsqRequest)).toMatchObject(expected);
    expect(runtime.pull).not.toHaveBeenCalled();
  });

  it('keys a pull of the repo under any casing as its Curated row does', async () => {
    const { service, pulls } = gsqHarness();
    const row = (await service.curated()).entries.find(entry => entry.id === GSQ.id)?.builds[0];
    if (!row) throw new Error('no row');
    const result = service.pull({ ...gsqRequest, repo: GSQ_REPO.toLowerCase() });
    await vi.waitFor(() => expect(pulls).toHaveLength(1));

    expect(service.pulls().map(pull => pull.key)).toEqual([pullKey(row.repo, row.pullBuildId)]);
    pulls[0].resolve();
    await result;
  });

  it.each([
    ['a different sha256', gsqDetail({ sha256: 'f'.repeat(64) })],
    ['a different size', gsqDetail({ sizeBytes: 1 })],
    ['the file gone', gsqDetail({}, { builds: [build({ id: 'other' })] })],
  ])('refuses the dialog once the repo has %s', async (_label, live) => {
    const { service, runtime } = gsqHarness({ detail: live });
    expect(await service.curatedPull(GSQ.id, IQ3.id)).toMatchObject({
      ok: false,
      error: { kind: 'upstream-changed', message: expect.stringContaining('changed on Hugging Face') },
    });
    expect(runtime.pull).not.toHaveBeenCalled();
  });

  it.each([
    ['a license added to the repo card', ['apache-2.0', 'mit'], ['apache-2.0']],
    ['the repo card license swapped', ['mit'], ['apache-2.0']],
    ['the base model card license swapped', ['apache-2.0'], ['other']],
  ])('refuses the dialog and the pull with %s', async (_label, repoLicenses, baseLicenses) => {
    const { service, hub, runtime } = gsqHarness();
    hub.getModel.mockImplementation(async (id: string) =>
      id === GSQ.lineage.base
        ? detail({ id, builds: [], licenses: baseLicenses })
        : gsqDetail({}, { licenses: repoLicenses })
    );
    const expected = { ok: false, error: { kind: 'upstream-changed', message: expect.stringContaining('license') } };
    expect(await service.curatedPull(GSQ.id, IQ3.id)).toMatchObject(expected);
    expect(await service.pull(gsqRequest)).toMatchObject(expected);
    expect(runtime.pull).not.toHaveBeenCalled();
  });

  it('refuses once hf.co starts serving a template layer the review did not see', async () => {
    const { service, hub, runtime } = gsqHarness();
    const live = reviewedLayers(IQ3);
    if (!live) throw new Error('no layers');
    hub.ollamaLayers.mockResolvedValue({
      ...live,
      others: [...live.others, { mediaType: 'application/vnd.ollama.image.template', digest: 'f'.repeat(64) }],
    });
    expect(await service.curatedPull(GSQ.id, IQ3.id)).toMatchObject({ ok: false, error: { kind: 'upstream-changed' } });
    expect(await service.pull(gsqRequest)).toMatchObject({ ok: false, error: { kind: 'upstream-changed' } });
    expect(runtime.pull).not.toHaveBeenCalled();
  });

  it('checks the layers of the verified tag, pulls, and checks the installed template against its pin', async () => {
    const { service, hub, runtime, pulls } = gsqHarness();
    const result = service.pull(gsqRequest);
    await vi.waitFor(() => expect(pulls).toHaveLength(1));
    expect(hub.ollamaLayers).toHaveBeenCalledWith(GSQ_REPO, 'IQ3_S', expect.anything());
    pulls[0].resolve();
    await expect(result).resolves.toEqual({ ok: true, ref: IQ3_REF });
    expect(runtime.remove).not.toHaveBeenCalled();

    const again = gsqHarness();
    const installed = await again.runtime.inspect(IQ3_REF);
    again.runtime.inspect.mockResolvedValueOnce({
      ...installed,
      contents: installed.contents && { ...installed.contents, template: 'a different template' },
    });
    const removed = again.service.pull(gsqRequest);
    await vi.waitFor(() => expect(again.pulls).toHaveLength(1));
    again.pulls[0].resolve();
    await expect(removed).resolves.toMatchObject({ ok: false, error: { kind: 'upstream-changed' } });
    expect(again.runtime.remove).toHaveBeenCalledWith(IQ3_REF);
  });

  it('shows and rechecks the build under the tag Hugging Face verified, not the one its quant label implies', async () => {
    const verified = `${IQ3_REF}-imat`;
    const { service, hub, runtime, pulls } = gsqHarness({ verified });
    hub.ollamaLayers.mockResolvedValue(reviewedLayers(IQ3));
    runtime.inspect.mockRejectedValue(new LocalRuntimeError('show timed out', 'ollama'));
    const result = service.pull(gsqRequest);
    await vi.waitFor(() => expect(pulls).toHaveLength(1));
    pulls[0].resolve();
    await expect(result).resolves.toMatchObject({ ok: false, error: { kind: 'unverified' } });

    const row = (await service.curated()).entries.find(entry => entry.id === GSQ.id)?.builds[0];
    expect(row?.ollamaRef).toBe(verified);
    runtime.inspect.mockClear();
    await service.checkCurated(GSQ.id, IQ3.id);
    expect(runtime.inspect).toHaveBeenCalledWith(verified, expect.anything());
  });

  it.each([
    ['an unknown pick', { entryId: 'nope', buildId: 'iq3-s' }],
    ['another build of the pick', { entryId: GSQ.id, buildId: 'iq2-xs' }],
    ['a library pick', { entryId: 'gemma-4-12b', buildId: 'qat-q4-0' }],
  ])('refuses %s without asking Hugging Face', async (_label, curated) => {
    const { service, hub, runtime } = gsqHarness();
    expect(await service.pull({ ...gsqRequest, curated })).toMatchObject({ ok: false, error: { kind: 'not-found' } });
    expect(hub.getModel).not.toHaveBeenCalled();
    expect(runtime.pull).not.toHaveBeenCalled();
  });

  it('refuses while Ollama is older than the build needs', async () => {
    const { service, runtime } = gsqHarness({ version: '0.32.11' });
    const expected = {
      ok: false,
      error: { kind: 'cannot-pull', message: expect.stringContaining('Needs Ollama 0.32.12') },
    };
    expect(await service.curatedPull(GSQ.id, IQ3.id)).toMatchObject(expected);
    expect(await service.pull(gsqRequest)).toMatchObject(expected);
    expect(runtime.pull).not.toHaveBeenCalled();
  });

  it('does not read registry layers for a pull from Explore', async () => {
    const { service, hub, pulls } = harness();
    const result = service.pull(request);
    await vi.waitFor(() => expect(pulls).toHaveLength(1));
    pulls[0].resolve();
    await result;
    expect(hub.ollamaLayers).not.toHaveBeenCalled();
  });

  it('reports a Hugging Face outage from the dialog', async () => {
    const { service, hub } = gsqHarness();
    hub.getModel.mockRejectedValueOnce(new RuntimeConnectionError('offline', 'huggingface', { cause: new Error('x') }));
    expect(await service.curatedPull(GSQ.id, IQ3.id)).toMatchObject({ ok: false, error: { kind: 'hub-unreachable' } });
  });
});

describe('ModelHubService curated pulls to a saved server', () => {
  const gsqRequest = {
    repo: GSQ_REPO,
    buildId: 'Qwen3.8-27B-GSQ-RCO-IQ3_S',
    revision: 'b'.repeat(40),
    sizeBytes: IQ3_FILE.sizeBytes,
    acceptLicense: false,
    confirmAccess: false,
    curated: { entryId: GSQ.id, buildId: IQ3.id },
    serverId: 'a',
  };
  const gsqServers = (options: Parameters<typeof harness>[0] = {}) => {
    const setup = servers({ detail: gsqDetail(), verified: IQ3_REF, ...options });
    setup.hub.getModel.mockImplementation(async (id: string) =>
      id === GSQ.lineage.base ? detail({ id, builds: [] }) : gsqDetail()
    );
    return setup;
  };
  const LIBRARY = CURATED.entries.find(entry => entry.id === 'gemma-4-e4b');
  const E4B = LIBRARY?.builds[0];
  const E4B_LIBRARY = E4B && libraryOf(E4B);
  if (!LIBRARY || !E4B || !E4B_LIBRARY) throw new Error('the bundled list lost its Gemma 4 E4B pick');
  const libraryRequest = {
    repo: E4B_LIBRARY.ref,
    buildId: E4B.id,
    revision: E4B_LIBRARY.digest,
    sizeBytes: E4B_LIBRARY.sizeBytes,
    acceptLicense: false,
    confirmAccess: false,
    curated: { entryId: LIBRARY.id, buildId: E4B.id },
    serverId: 'a',
  };

  it('checks the registry layers, pulls on the server, and checks what that server installed', async () => {
    const { service, hub, local, remote, installedChanged } = gsqServers();
    const result = service.pull(gsqRequest);
    await vi.waitFor(() => expect(remote.a.pulls).toHaveLength(1));
    expect(hub.ollamaLayers).toHaveBeenCalledWith(GSQ_REPO, 'IQ3_S', expect.anything());
    expect(service.pulls()[0].key).toBe(pullKey(GSQ_REPO, gsqRequest.buildId, 'a'));
    remote.a.pulls[0].resolve();

    await expect(result).resolves.toEqual({ ok: true, ref: IQ3_REF });
    expect(remote.a.runtime.list).toHaveBeenCalled();
    expect(remote.a.runtime.inspect).toHaveBeenCalledWith(IQ3_REF, expect.objectContaining({ tags: false }));
    expect(remote.a.runtime.remove).not.toHaveBeenCalled();
    expect(installedChanged).toHaveBeenCalledWith('a');
    for (const call of ['health', 'list', 'inspect', 'pull', 'remove'] as const)
      expect(local.runtime[call]).not.toHaveBeenCalled();
    expect(remote.b.runtime.inspect).not.toHaveBeenCalled();
  });

  it('removes an unreviewed install from the server it landed on, never from this computer', async () => {
    const { service, local, remote } = gsqServers();
    const installed = await remote.a.runtime.inspect(IQ3_REF);
    remote.a.runtime.inspect.mockClear();
    remote.a.runtime.inspect.mockResolvedValueOnce({
      ...installed,
      contents: installed.contents && { ...installed.contents, template: 'a different template' },
    });
    const result = service.pull(gsqRequest);
    await vi.waitFor(() => expect(remote.a.pulls).toHaveLength(1));
    remote.a.pulls[0].resolve();

    await expect(result).resolves.toMatchObject({ ok: false, error: { kind: 'upstream-changed' } });
    expect(remote.a.runtime.remove).toHaveBeenCalledWith(IQ3_REF);
    expect(local.runtime.remove).not.toHaveBeenCalled();
  });

  it('pins the llama.cpp runner on a library pull to the server and checks it there', async () => {
    const { service, local, remote } = servers();
    const result = service.pull(libraryRequest);
    await vi.waitFor(() => expect(remote.a.pulls).toHaveLength(1));
    expect(remote.a.runtime.pull).toHaveBeenCalledWith(
      E4B_LIBRARY.ref,
      expect.objectContaining({ runner: 'llamacpp' })
    );
    expect(local.libraryLayers).toHaveBeenCalledWith(E4B_LIBRARY.ref, expect.anything());
    remote.a.pulls[0].resolve();

    await expect(result).resolves.toEqual({ ok: true, ref: E4B_LIBRARY.ref });
    expect(remote.a.runtime.inspect).toHaveBeenCalledWith(E4B_LIBRARY.ref, expect.anything());
    expect(local.runtime.pull).not.toHaveBeenCalled();
    expect(local.runtime.inspect).not.toHaveBeenCalled();
  });

  it('runs the check after a paused download to the server resumes and finishes', async () => {
    const { service, remote } = gsqServers();
    const first = service.pull(gsqRequest);
    await vi.waitFor(() => expect(remote.a.pulls).toHaveLength(1));
    remote.a.pulls[0].reject(new ServerUnreachableError('box a', 'connection reset'));
    await expect(first).resolves.toMatchObject({ ok: false, error: { kind: 'connection-lost' }, listed: true });
    expect(remote.a.runtime.inspect).not.toHaveBeenCalled();

    const resumed = service.resume(service.pulls()[0].key);
    await vi.waitFor(() => expect(remote.a.pulls).toHaveLength(2));
    remote.a.pulls[1].resolve();

    await expect(resumed).resolves.toEqual({ ok: true, ref: IQ3_REF });
    expect(remote.a.runtime.inspect).toHaveBeenCalledWith(IQ3_REF, expect.objectContaining({ tags: false }));
    expect(service.pulls()).toEqual([]);
  });

  it('keeps an unverified install per server and checks it again on that server', async () => {
    const { service, local, remote } = servers();
    remote.a.runtime.inspect.mockRejectedValue(new LocalRuntimeError('show timed out', 'ollama'));
    const result = service.pull(libraryRequest);
    await vi.waitFor(() => expect(remote.a.pulls).toHaveLength(1));
    remote.a.pulls[0].resolve();
    await expect(result).resolves.toMatchObject({ ok: false, error: { kind: 'unverified' } });
    expect(service.pulls()[0]).toMatchObject({ serverId: 'a', phase: 'failed' });

    const reviewed = await local.runtime.inspect(E4B_LIBRARY.ref);
    local.runtime.inspect.mockClear();
    remote.a.runtime.inspect.mockReset().mockResolvedValue(reviewed);
    expect(await service.checkCurated(LIBRARY.id, E4B.id, 'a')).toEqual({ ok: true });
    expect(remote.a.runtime.inspect).toHaveBeenCalledWith(E4B_LIBRARY.ref, expect.anything());
    expect(local.runtime.inspect).not.toHaveBeenCalled();
    expect(service.pulls()).toEqual([]);
  });

  it("refuses the dialog for a Chat only server and rates the build against that server's Ollama", async () => {
    const { service, chatOnly } = gsqServers({ version: '0.32.11' });
    expect(await service.curatedPull(GSQ.id, IQ3.id, 'a')).toMatchObject({
      ok: false,
      error: { kind: 'cannot-pull', message: expect.stringContaining('Update Ollama on box a') },
    });
    expect(await service.pull(gsqRequest)).toMatchObject({ ok: false, error: { kind: 'cannot-pull' } });
    chatOnly.add('a');
    expect(await service.curatedPull(GSQ.id, IQ3.id, 'a')).toMatchObject({ ok: false, error: { kind: 'not-allowed' } });
    expect(await service.checkCurated(GSQ.id, IQ3.id, 'a')).toMatchObject({
      ok: false,
      error: { kind: 'not-allowed' },
    });
  });

  it('leaves fit off the installed models of a saved server', async () => {
    const { service, remote } = servers();
    remote.a.runtime.list.mockResolvedValue([
      {
        name: 'small:latest',
        sizeBytes: 397_821_319,
        quantization: 'Q4_K_M',
        family: 'llama',
        parameterSize: '494M',
        modifiedAt: null,
        capabilities: { tools: false, vision: false, thinking: false, embeddings: false, completion: true },
      },
    ]);
    const result = await service.installed('a');
    expect(result.ok && result.models.map(model => model.fit)).toEqual([null]);
    expect(remote.a.runtime.inspect).not.toHaveBeenCalled();
  });
});

describe('ModelHubService Hugging Face token', () => {
  const TOKEN = 'hf_TestTokenThatMustNeverLeak0123456789';
  const hidden = build({ files: [{ ...build().files[0], sha256: null }] });

  it('checks a token with Hugging Face before keeping it, and keeps a rejected one nowhere', async () => {
    const { service, hub, tokens, createHub } = harness();
    hub.checkToken.mockResolvedValueOnce(false);

    const refused = await service.setToken(`  ${TOKEN}x  `);
    expect(refused).toMatchObject({
      ok: false,
      error: { kind: 'token-rejected', message: expect.stringContaining('did not accept this token') },
    });
    expect(createHub).toHaveBeenLastCalledWith(`${TOKEN}x`);
    expect(tokens.set).not.toHaveBeenCalled();
    expect(await service.tokenStatus()).toEqual({ set: false, persisted: true });

    expect(await service.setToken(TOKEN)).toEqual({ ok: true, status: { set: true, persisted: true } });
    expect(tokens.set).toHaveBeenCalledWith(TOKEN);
    expect(await service.tokenStatus()).toEqual({ set: true, persisted: true });
  });

  it.each(['short', 'hf_has a space inside', `hf_${String.fromCharCode(0xe9)}accented0000000`])(
    'refuses text that cannot be a token without asking Hugging Face: %s',
    async raw => {
      const { service, hub, tokens } = harness();
      expect(await service.setToken(raw)).toMatchObject({ ok: false, error: { kind: 'token-rejected' } });
      expect(hub.checkToken).not.toHaveBeenCalled();
      expect(tokens.set).not.toHaveBeenCalled();
    }
  );

  it('reports an outage while checking instead of calling the token invalid', async () => {
    const { service, hub, tokens } = harness();
    hub.checkToken.mockRejectedValueOnce(
      new RuntimeConnectionError('offline', 'huggingface', { cause: new Error('x') })
    );
    expect(await service.setToken(TOKEN)).toMatchObject({ ok: false, error: { kind: 'hub-unreachable' } });
    expect(tokens.set).not.toHaveBeenCalled();
  });

  it('sends the saved token from the first request, and stops on remove', async () => {
    const { service, createHub, tokens } = harness({ token: TOKEN });
    await service.search({ query: 'qwen' });
    expect(createHub).toHaveBeenCalledWith(TOKEN);

    expect(await service.clearToken()).toEqual({ ok: true, status: { set: false, persisted: true } });
    expect(tokens.clear).toHaveBeenCalledTimes(1);
    expect(createHub).toHaveBeenLastCalledWith(null);
  });

  it('keeps showing the token as set, and reports the failure, when removing it fails', async () => {
    const { service, createHub, tokens } = harness({ token: TOKEN });
    expect(await service.tokenStatus()).toEqual({ set: true, persisted: true });
    tokens.clear.mockRejectedValueOnce(new Error(`EACCES writing ${TOKEN}`));

    const result = await service.clearToken();
    expect(result).toEqual({ ok: false, error: expect.objectContaining({ kind: 'failed' }) });
    expect(JSON.stringify(result)).not.toContain(TOKEN);
    expect(await service.tokenStatus()).toEqual({ set: true, persisted: true });
    expect(createHub).not.toHaveBeenCalledWith(null);

    expect(await service.clearToken()).toEqual({ ok: true, status: { set: false, persisted: true } });
  });

  it('says a refusal with a token is about the token', async () => {
    const withToken = harness({ token: TOKEN });
    withToken.hub.getModel.mockRejectedValueOnce(
      new HubAccessError('denied', 'huggingface', 403, REPO, 'unauthorized')
    );
    expect(await withToken.service.detail(REPO)).toMatchObject({
      ok: false,
      error: { kind: 'token-rejected', message: expect.stringContaining('invalid or lacks access') },
    });
    withToken.hub.getModel.mockRejectedValueOnce(new HubAccessError('denied', 'huggingface', 401, REPO, 'gated'));
    expect(await withToken.service.detail(REPO)).toMatchObject({ ok: false, error: { kind: 'token-rejected' } });
    withToken.hub.getModel.mockRejectedValueOnce(new ModelNotFoundError('huggingface', REPO, { cause: 'HTTP 401' }));
    expect(await withToken.service.detail(REPO)).toMatchObject({
      ok: false,
      error: { kind: 'not-found', message: expect.stringContaining('token is invalid or lacks access') },
    });

    const anonymous = harness();
    anonymous.hub.getModel.mockRejectedValueOnce(new HubAccessError('denied', 'huggingface', 401, REPO, 'gated'));
    expect(await anonymous.service.detail(REPO)).toMatchObject({ ok: false, error: { kind: 'gated' } });
  });

  it('tells gated access apart by what the token can read', async () => {
    const gated = { gated: 'manual' as const, ollamaNeedsSshKey: true, licenses: ['gemma'] };

    const anonymous = harness({ detail: detail({ ...gated, builds: [hidden], canDownload: false }) });
    const noToken = await anonymous.service.detail(REPO);
    expect(noToken).toMatchObject({ ok: true, model: { hubAccess: 'no-token' } });
    expect(noToken.ok && noToken.model.builds[0].blockedReason).toMatch(/add a Hugging Face token/);

    const denied = harness({ token: TOKEN, detail: detail({ ...gated, builds: [hidden], canDownload: false }) });
    const refused = await denied.service.detail(REPO);
    expect(refused).toMatchObject({ ok: true, model: { hubAccess: 'denied' } });
    expect(refused.ok && refused.model.builds[0].blockedReason).toMatch(/token cannot read this file/);

    const granted = harness({ token: TOKEN, detail: detail({ ...gated, canDownload: true }) });
    const open = await granted.service.detail(REPO);
    expect(open).toMatchObject({ ok: true, model: { hubAccess: 'granted', needsAccess: true } });
    expect(open.ok && open.model.builds[0].blockedReason).toBeNull();

    const result = granted.service.pull({ ...request, acceptLicense: true, confirmAccess: true });
    await vi.waitFor(() => expect(granted.pulls).toHaveLength(1));
    granted.pulls[0].resolve();
    await expect(result).resolves.toMatchObject({ ok: true });
  });

  it('re-reads past the cache when the token looks denied, so a fresh access grant shows', async () => {
    const gated = { gated: 'manual' as const, ollamaNeedsSshKey: true };
    const { service, hub } = harness({
      token: TOKEN,
      detail: detail({ ...gated, builds: [hidden], canDownload: false }),
    });
    hub.getModel.mockResolvedValueOnce(detail({ ...gated, builds: [hidden], canDownload: false }));
    hub.getModel.mockResolvedValueOnce(detail({ ...gated, canDownload: true }));
    expect(await service.detail(REPO)).toMatchObject({ ok: true, model: { hubAccess: 'granted' } });
    expect(hub.getModel).toHaveBeenLastCalledWith(REPO, { refresh: true });

    const open = harness({ token: TOKEN, detail: detail({ ...gated, canDownload: true }) });
    await open.service.detail(REPO);
    const anonymous = harness({ detail: detail({ ...gated, builds: [hidden], canDownload: false }) });
    await anonymous.service.detail(REPO);
    expect(open.hub.getModel).toHaveBeenCalledTimes(1);
    expect(anonymous.hub.getModel).toHaveBeenCalledTimes(1);
  });

  it('pulls a gated or private repo by its huggingface.co name, which Ollama can sign in to', async () => {
    for (const repo of [{ gated: 'auto' as const }, { private: true }]) {
      const { service, runtime, pulls } = harness({
        token: TOKEN,
        detail: detail({ ...repo, ollamaNeedsSshKey: true, canDownload: true }),
      });
      const shown = await service.detail(REPO);
      expect(shown.ok && shown.model.builds[0].ollamaRef).toBe(`huggingface.co/${REPO}:Q4_K_M`);

      const result = service.pull({ ...request, confirmAccess: true });
      await vi.waitFor(() => expect(pulls).toHaveLength(1));
      expect(runtime.pull).toHaveBeenCalledWith(`huggingface.co/${REPO}:Q4_K_M`, expect.anything());
      pulls[0].resolve();
      await expect(result).resolves.toEqual({ ok: true, ref: `huggingface.co/${REPO}:Q4_K_M` });
    }

    const open = harness();
    const shown = await open.service.detail(REPO);
    expect(shown.ok && shown.model.builds[0].ollamaRef).toBe(`hf.co/${REPO}:Q4_K_M`);
  });

  it("explains a pull Ollama's own key could not sign", async () => {
    const { service, pulls } = harness({
      token: TOKEN,
      detail: detail({ gated: 'auto', ollamaNeedsSshKey: true, canDownload: true }),
    });
    const result = service.pull({ ...request, confirmAccess: true });
    await vi.waitFor(() => expect(pulls).toHaveLength(1));
    pulls[0].reject(
      new LocalRuntimeError(
        `ollama could not pull hf.co/${REPO}:Q4_K_M: pull model manifest: 401: {"error":"Invalid username or password."}`,
        'ollama'
      )
    );
    await expect(result).resolves.toMatchObject({
      ok: false,
      error: { kind: 'gated', message: expect.stringContaining('not your token') },
    });
    expect(service.pulls()[0].error?.message).toContain('huggingface.co/settings/keys');
  });

  it('sends the token only to huggingface.co: never to Ollama, and never back in a result', async () => {
    const repo = 'google/gemma-3-1b-it-qat-q4_0-gguf';
    const sha = 'd'.repeat(40);
    const oid = 'e'.repeat(64);
    const file = 'gemma-3-1b-it-q4_0.gguf';
    const sent: { url: string; authorization: string | null }[] = [];
    const fetchStub = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      sent.push({ url, authorization: new Headers(init?.headers).get('authorization') });
      const path = new URL(url).pathname;
      if (path === '/api/whoami-v2') return Response.json({ type: 'user', name: 'someone' });
      if (path === '/api/models') return Response.json([{ id: repo, gated: 'manual', private: false, tags: ['gguf'] }]);
      if (path === `/api/models/${repo}/revision/main`)
        return Response.json({ id: repo, sha, gated: 'manual', private: false, tags: ['gguf'], cardData: {} });
      if (path === `/api/models/${repo}/tree/${sha}`)
        return Response.json([{ type: 'file', path: file, size: 1e9, lfs: { oid, size: 1e9 } }]);
      if (path === `/${repo}/resolve/${sha}/${file}`)
        return new Response(null, { status: 302, headers: { location: 'https://cdn-lfs.hf.co/blob' } });
      if (path.startsWith(`/v2/${repo}/manifests/`))
        return Response.json({
          layers: [{ mediaType: 'application/vnd.ollama.image.model', digest: `sha256:${oid}` }],
        });
      return new Response('{"error":"not found"}', { status: 404 });
    });
    const { runtime, pulls } = harness();
    const pushed: ModelPull[][] = [];
    const service = new ModelHubService({
      runtime,
      createHub: token =>
        new HuggingFaceHub({ fetch: fetchStub as unknown as typeof fetch, ...(token ? { token } : {}) }),
      tokens: memoryTokens(),
      libraryLayers: async () => null,
      hardware: async () => CPU_16,
      localContext: async () => AUTO_LOCAL_CONTEXT,
      curated: () => CURATED,
      onPullsChanged: next => pushed.push(next),
      onInstalledChanged: () => {},
      warn: () => {},
    });

    const results: unknown[] = [await service.setToken(TOKEN), await service.tokenStatus()];
    results.push(await service.search({ query: 'gemma' }));
    const shown = await service.detail(repo);
    results.push(shown);
    if (!shown.ok) throw new Error(shown.error.message);
    expect(shown.model).toMatchObject({ hubAccess: 'granted' });
    const build0 = shown.model.builds[0];
    const pull = service.pull({
      repo,
      buildId: build0.id,
      revision: shown.model.revision,
      sizeBytes: build0.sizeBytes,
      acceptLicense: true,
      confirmAccess: true,
    });
    await vi.waitFor(() => expect(pulls).toHaveLength(1));
    pulls[0].resolve();
    results.push(await pull, pushed);

    expect(sent.length).toBeGreaterThan(4);
    for (const request of sent) {
      expect(new URL(request.url).origin).toBe('https://huggingface.co');
      expect(request.authorization).toBe(`Bearer ${TOKEN}`);
    }
    expect(runtime.pull).toHaveBeenCalledWith(`huggingface.co/${repo}:Q4_0`, expect.anything());
    expect(JSON.stringify(runtime.pull.mock.calls)).not.toContain(TOKEN);
    expect(JSON.stringify(runtime.health.mock.calls)).not.toContain(TOKEN);
    expect(JSON.stringify(results)).not.toContain(TOKEN);
  });
});

describe('removing the token with the real store', () => {
  const TOKEN = 'hf_TestTokenThatMustNeverLeak0123456789';
  const cipher = {
    isEncryptionAvailable: () => true,
    encryptString: (plain: string) => Buffer.from(`enc:${Buffer.from(plain).toString('hex')}`),
    decryptString: (blob: Buffer) => Buffer.from(blob.toString().slice(4), 'hex').toString(),
  };

  it('does not return the token on the next launch when the file write fails', async () => {
    let contents: string | null = null;
    let failWrites = false;
    const file = {
      read: async () => contents,
      write: async (next: string) => {
        if (failWrites) throw new Error('EACCES');
        contents = next;
      },
    };
    const logger = { debug: vi.fn(), warn: vi.fn() };
    const hub = harness().hub;
    const launch = () =>
      new ModelHubService({
        runtime: harness().runtime,
        createHub: () => hub,
        tokens: new HuggingFaceTokenStore(cipher, file, logger),
        libraryLayers: async () => null,
        hardware: async () => CPU_16,
        localContext: async () => AUTO_LOCAL_CONTEXT,
        curated: () => CURATED,
        onPullsChanged: () => undefined,
        onInstalledChanged: () => undefined,
        warn: () => undefined,
      });

    const first = launch();
    expect((await first.setToken(TOKEN)).ok).toBe(true);
    failWrites = true;
    expect(await first.clearToken()).toMatchObject({ ok: false });
    expect(await first.tokenStatus()).toEqual({ set: true, persisted: true });

    failWrites = false;
    expect(await launch().tokenStatus()).toEqual({ set: true, persisted: true });
    expect(await first.clearToken()).toMatchObject({ ok: true, status: { set: false } });
    expect(await launch().tokenStatus()).toEqual({ set: false, persisted: true });
  });
});

describe('token operation failures and ordering', () => {
  it('finishes a later removal after an earlier token validation', async () => {
    const { service, hub, tokens } = harness();
    let finishCheck: (valid: boolean) => void = () => {};
    hub.checkToken.mockImplementationOnce(
      () =>
        new Promise<boolean>(resolve => {
          finishCheck = resolve;
        })
    );
    const saving = service.setToken('hf_pending_token');
    await vi.waitFor(() => expect(hub.checkToken).toHaveBeenCalledOnce());
    const removing = service.clearToken();
    expect(tokens.clear).not.toHaveBeenCalled();
    finishCheck(true);
    expect(await saving).toMatchObject({ ok: true });
    expect(await removing).toMatchObject({ ok: true, status: { set: false } });
    expect(await tokens.get()).toBeNull();
    expect(await service.tokenStatus()).toMatchObject({ set: false });
  });

  it('continues with later mutations when an earlier validation fails', async () => {
    const { service, hub, tokens } = harness();
    hub.checkToken.mockRejectedValueOnce(new Error('offline'));
    const saving = service.setToken('hf_pending_token');
    const removing = service.clearToken();
    expect(await saving).toMatchObject({ ok: false });
    expect(await removing).toMatchObject({ ok: true });
    expect(tokens.clear).toHaveBeenCalledOnce();
  });

  it.each(['search', 'detail', 'pull'] as const)(
    'reports a failed token read on %s and retries it next time',
    async operation => {
      const { service, tokens, hub } = harness({ token: 'hf_saved_token' });
      tokens.get.mockRejectedValueOnce(new Error('EACCES'));
      const result =
        operation === 'search'
          ? await service.search({ query: 'qwen' })
          : operation === 'detail'
            ? await service.detail(REPO)
            : await service.pull(request);
      expect(result).toMatchObject({ ok: false, error: { kind: 'failed' } });
      expect(hub.search).not.toHaveBeenCalled();
      expect(hub.getModel).not.toHaveBeenCalled();
      expect(service.pulls().every(entry => entry.phase === 'failed')).toBe(true);
      expect(await service.tokenStatus()).toMatchObject({ set: true });
      expect(tokens.get).toHaveBeenCalledTimes(2);
    }
  );
});
