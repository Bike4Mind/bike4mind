import {
  HubAccessError,
  HubRateLimitError,
  HuggingFaceHub,
  LocalRuntimeError,
  ModelNotFoundError,
  RuntimeConnectionError,
  ollamaPullRef,
  type HubGgufBuild,
  type HubModelDetail,
  type HubSearchPage,
  type InstalledModel,
  type LoadedModel,
  type PullOptions,
} from '@bike4mind/local-models';
import { pullKey, type ModelPull } from '@shared/models';
import { describe, expect, it, vi } from 'vitest';
import { HuggingFaceTokenStore } from './HuggingFaceTokenStore';
import { ModelHubService, type HubTokenPort, type ModelHubPort, type ModelRuntimePort } from './ModelHubService';

const REPO = 'Qwen/Qwen2.5-0.5B-Instruct-GGUF';
const SHA = 'a'.repeat(64);

function build(overrides: Partial<HubGgufBuild> = {}): HubGgufBuild {
  return {
    id: 'qwen2.5-0.5b-instruct-q4_k_m',
    quant: 'Q4_K_M',
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
  options: { detail?: HubModelDetail; verified?: string | null; healthy?: boolean; token?: string | null } = {}
) {
  const pulls: Deferred[] = [];
  const runtime = {
    baseUrl: 'http://127.0.0.1:11434',
    health: vi.fn(async (): Promise<Health> =>
      options.healthy === false
        ? { ok: false, version: null, error: 'connection refused' }
        : { ok: true, version: '0.40.11', error: null }
    ),
    list: vi.fn(async (): Promise<InstalledModel[]> => []),
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
    checkToken: vi.fn(async () => true),
  } satisfies ModelHubPort;
  const pushed: ModelPull[][] = [];
  const installedChanged = vi.fn();
  const tokens = memoryTokens(options.token ?? null);
  const createHub = vi.fn((_token: string | null) => hub);
  const service = new ModelHubService({
    runtime,
    createHub,
    tokens,
    onPullsChanged: next => pushed.push(next),
    onInstalledChanged: installedChanged,
    progressIntervalMs: 0,
  });
  return { service, runtime, hub, pulls, pushed, installedChanged, tokens, createHub };
}

const request = {
  repo: REPO,
  buildId: 'qwen2.5-0.5b-instruct-q4_k_m',
  revision: 'b'.repeat(40),
  sizeBytes: 491_400_032,
  acceptLicense: false,
  confirmAccess: false,
};

describe('ModelHubService pulls', () => {
  it('verifies the ref, then pulls it with progress, and reports the model installed', async () => {
    const { service, runtime, hub, pulls, pushed, installedChanged } = harness();
    const result = service.pull(request);
    await vi.waitFor(() => expect(pulls).toHaveLength(1));

    expect(hub.verifyOllamaRef).toHaveBeenCalledTimes(1);
    expect(runtime.pull).toHaveBeenCalledWith(`hf.co/${REPO}:Q4_K_M`, expect.anything());
    pulls[0].options?.onProgress?.({ status: 'pulling abc', completedBytes: 100, totalBytes: 491_400_032 });
    expect(service.pulls()[0]).toMatchObject({ phase: 'downloading', completedBytes: 100, quant: 'Q4_K_M' });

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
      onPullsChanged: () => {},
      onInstalledChanged: () => {},
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
      onPullsChanged: () => {},
      onInstalledChanged: () => {},
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
      onPullsChanged: next => pushed.push(next),
      onInstalledChanged: () => {},
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
        onPullsChanged: () => undefined,
        onInstalledChanged: () => undefined,
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
