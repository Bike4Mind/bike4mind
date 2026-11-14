import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ALL_IMAGE_MODELS,
  CreditHolderType,
  IMAGE_MODEL_CATALOG,
  ImageModels,
  insufficientCreditsError,
  resolveLegacyImageModel,
  type ImageModels as ImageModelId,
  type StorageLimitErrorInfo,
} from '@bike4mind/common';
import {
  createImageProviderRegistry,
  LocalImageProvider,
  TestImageProvider,
  type ImageProvider,
} from '@bike4mind/utils/imageProviders';
import { Logger } from '@bike4mind/observability';
import { createInMemoryGenerationJobRepository } from '../generationJobs/__test__/inMemoryGenerationJobRepository';
import { GenerationJobEngine } from '../generationJobs/engine';
import type { CreditHold, CreditHoldAdapters } from '../creditService/creditHold';
import { createImageJobs } from './createImageJobs';
import { createImageJobHandler } from './imageJobHandler';
import {
  IMAGE_JOB_BATCH_MAX,
  IMAGE_JOB_OUTPUT_BYTES_ESTIMATE,
  type CreateImageJobsDeps,
  type CreateImageJobsInput,
} from './types';

vi.mock('../creditService/creditHold', () => ({
  holdCredits: vi.fn(),
  releaseCreditHold: vi.fn(async () => undefined),
  settleCreditHold: vi.fn(async (_hold: unknown, charged: number) => charged),
}));
import { holdCredits, releaseCreditHold } from '../creditService/creditHold';

vi.mock('../creditService/newAccountSpendCap', () => ({ checkNewAccountSpendCap: vi.fn(async () => null) }));
import { checkNewAccountSpendCap } from '../creditService/newAccountSpendCap';

const fakeHold = (params: { userId: string; requiredCredits: number }): CreditHold => ({
  ownerId: params.userId,
  ownerType: CreditHolderType.User,
  userId: params.userId,
  organizationId: null,
  reservedCredits: params.requiredCredits,
  balanceAfterHold: 1000,
});

// creditHold and the spend cap are module-mocked: only the user lookup a batch's cap check makes is real.
const capUser = { id: 'u1', createdAt: new Date('2026-10-12T00:00:00Z'), isAdmin: false };
const testCredits = {
  users: { findById: vi.fn(async () => capUser) },
  newAccountSpendCap: {},
} as unknown as CreditHoldAdapters;

const openAiProvider: ImageProvider = {
  mode: 'sync',
  id: 'openai',
  models: ALL_IMAGE_MODELS.filter(id => IMAGE_MODEL_CATALOG[id].provider === 'openai') as ImageModelId[],
  generate: vi.fn(),
  fetchOutput: vi.fn(),
};

const FILE_ID = 'c'.repeat(24);
const SOURCE_ID = 'd'.repeat(24);

const makeDeps = (overrides: Partial<CreateImageJobsDeps> = {}) => {
  const repository = createInMemoryGenerationJobRepository();
  const deps: CreateImageJobsDeps = {
    assertModelAdmission: vi.fn(async () => {}),
    repository,
    providers: createImageProviderRegistry([openAiProvider]),
    getSettings: async () => ({ enforceCredits: true }),
    resolveApiKey: vi.fn(async () => 'key'),
    loadInputFile: vi.fn(async () => ({ bytes: Buffer.from('x'), mimeType: 'image/png' })),
    moderate: vi.fn(async () => ({ blocked: false as const })),
    checkStorageFor: vi.fn(async () => undefined),
    saveToFiles: vi.fn(),
    saveToGeneratedBucket: vi.fn(),
    credits: testCredits,
    enqueue: vi.fn(async () => undefined),
    recordUsage: vi.fn(async () => undefined),
    now: () => new Date('2026-10-13T00:00:00Z'),
    logger: new Logger({ metadata: { test: 'createImageJobs' } }),
    engine: { failBeforeStart: (jobId, error) => engine.failBeforeStart(jobId, error) },
    ...overrides,
  };
  const engine = new GenerationJobEngine({
    repository,
    handlers: [createImageJobHandler(deps)],
    enqueue: deps.enqueue,
    notify: async () => undefined,
    now: deps.now,
    logger: deps.logger,
    leaseMs: 330_000,
  });
  return { deps, repository };
};

const user = { id: 'u1', organizationId: null };
const validRequest = { model: ImageModels.GPT_IMAGE_2, mode: 'generate', prompt: 'a red bicycle' };
const run = (
  deps: CreateImageJobsDeps,
  request: unknown,
  extra: { count?: number; idempotencyKey?: string; delivery?: CreateImageJobsInput['delivery'] } = {}
) => createImageJobs({ user, request, count: extra.count ?? 1, source: 'api', ...extra }, deps);

describe('createImageJobs', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(holdCredits).mockImplementation(async params => fakeHold(params));
  });

  describe('input validation', () => {
    it.each([0, 5, 1.5, Number.NaN, -1])('refuses count %s with 400 invalid_count', async count => {
      const { deps } = makeDeps();
      expect(IMAGE_JOB_BATCH_MAX).toBe(4);
      expect(await run(deps, validRequest, { count })).toMatchObject({
        ok: false,
        status: 400,
        code: 'invalid_count',
      });
      expect(holdCredits).not.toHaveBeenCalled();
    });

    it.each([
      ['an empty prompt', { ...validRequest, prompt: '   ' }],
      ['an unknown field', { ...validRequest, count: 2 }],
      ['an unknown model', { ...validRequest, model: 'not-a-model' }],
      ['a malformed fileId', { ...validRequest, inputs: [{ role: 'reference', fileId: 'nope' }] }],
      ['a non-object', 'a red bicycle'],
    ])('refuses %s with 400 invalid_request', async (_label, request) => {
      const { deps } = makeDeps();
      expect(await run(deps, request)).toMatchObject({ ok: false, status: 400, code: 'invalid_request' });
      expect(holdCredits).not.toHaveBeenCalled();
      expect(deps.enqueue).not.toHaveBeenCalled();
    });
  });

  describe('model checks', () => {
    it('refuses an option the model cannot honour with every reason, holding nothing and creating nothing', async () => {
      expect(IMAGE_MODEL_CATALOG[ImageModels.GPT_IMAGE_2].transparentBackground).toBe(false);
      const { deps, repository } = makeDeps();
      const result = await run(deps, {
        model: ImageModels.GPT_IMAGE_2,
        mode: 'generate',
        prompt: 'x',
        transparentBackground: true,
      });
      if (result.ok || result.code !== 'unsupported_by_model') throw new Error('expected unsupported_by_model');
      expect(result.status).toBe(422);
      expect(result.failures.length).toBeGreaterThan(0);
      for (const failure of result.failures) expect(failure.reason).toEqual(expect.any(String));
      expect(result.failures.map(failure => failure.code)).toContain('unsupported_transparent_background');
      expect(result.message).toBe(result.failures[0].reason);
      expect(holdCredits).not.toHaveBeenCalled();
      expect(repository.jobs.size).toBe(0);
      expect(deps.enqueue).not.toHaveBeenCalled();
    });

    it('refuses edit regions on a model that takes none, holding nothing and creating nothing', async () => {
      const { deps, repository } = makeDeps();
      const result = await run(deps, {
        model: ImageModels.GPT_IMAGE_2,
        mode: 'edit',
        prompt: 'x',
        inputs: [{ role: 'edit_source', fileId: SOURCE_ID }],
        editRegions: [{ prompt: 'make it blue', bbox: [0.1, 0.1, 0.5, 0.5] }],
      });
      if (result.ok || result.code !== 'unsupported_by_model') throw new Error('expected unsupported_by_model');
      expect(result.failures.map(failure => failure.code)).toContain('unsupported_edit_regions');
      expect(holdCredits).not.toHaveBeenCalled();
      expect(repository.jobs.size).toBe(0);
    });

    it.each([
      ['an inverted bbox', [0.5, 0.1, 0.1, 0.5]],
      ['a bbox outside 0..1', [0, 0, 1.5, 1]],
    ])('refuses %s with 400 invalid_request', async (_label, bbox) => {
      const { deps } = makeDeps();
      const result = await run(deps, {
        model: ImageModels.GPT_IMAGE_2,
        mode: 'edit',
        prompt: 'x',
        inputs: [{ role: 'edit_source', fileId: SOURCE_ID }],
        editRegions: [{ prompt: 'make it blue', bbox }],
      });
      expect(result).toMatchObject({ ok: false, status: 400, code: 'invalid_request' });
      expect(holdCredits).not.toHaveBeenCalled();
    });

    it('reports several failures at once', async () => {
      const { deps } = makeDeps();
      const result = await run(deps, {
        model: ImageModels.GPT_IMAGE_2,
        mode: 'generate',
        prompt: 'x',
        transparentBackground: true,
        seed: 3,
      });
      if (result.ok || result.code !== 'unsupported_by_model') throw new Error('expected unsupported_by_model');
      expect(result.failures.length).toBeGreaterThanOrEqual(2);
    });

    it('refuses a model whose provider is not registered with 422 model_unavailable', async () => {
      const { deps } = makeDeps();
      expect(await run(deps, { ...validRequest, model: ImageModels.GEMINI_3_PRO_IMAGE })).toMatchObject({
        ok: false,
        status: 422,
        code: 'model_unavailable',
      });
      expect(holdCredits).not.toHaveBeenCalled();
    });

    it('refuses a retired alias with 422 model_unavailable instead of rendering its successor', async () => {
      expect(resolveLegacyImageModel(ImageModels.GPT_IMAGE_1)).not.toBe(ImageModels.GPT_IMAGE_1);
      expect(openAiProvider.models).toContain(ImageModels.GPT_IMAGE_1);
      const { deps, repository } = makeDeps();
      expect(await run(deps, { ...validRequest, model: ImageModels.GPT_IMAGE_1 })).toMatchObject({
        ok: false,
        status: 422,
        code: 'model_unavailable',
      });
      expect(holdCredits).not.toHaveBeenCalled();
      expect(repository.jobs.size).toBe(0);
    });

    it('refuses an id that is not in the model enum at all (dall-e-3) with 400 invalid_request', async () => {
      const { deps } = makeDeps();
      expect(await run(deps, { ...validRequest, model: 'dall-e-3' })).toMatchObject({
        ok: false,
        status: 400,
        code: 'invalid_request',
      });
      expect(holdCredits).not.toHaveBeenCalled();
    });

    it('refuses a model the registered provider does not list with 422 model_unavailable', async () => {
      const provider: ImageProvider = {
        ...openAiProvider,
        models: openAiProvider.models.filter(id => id !== validRequest.model),
      };
      // The real registry refuses a provider that omits a catalog model, so the narrowed one is served directly.
      const { deps, repository } = makeDeps({ providers: { get: () => provider } });
      expect(await run(deps, validRequest)).toMatchObject({ ok: false, status: 422, code: 'model_unavailable' });
      expect(holdCredits).not.toHaveBeenCalled();
      expect(repository.jobs.size).toBe(0);
    });

    it('serves a runtime-discovered local checkpoint through the local provider', async () => {
      const { deps } = makeDeps({ providers: createImageProviderRegistry([openAiProvider, new LocalImageProvider()]) });
      const result = await run(deps, {
        model: 'local-image/sdxl_base.safetensors',
        mode: 'generate',
        prompt: 'a kite',
      });
      if (!result.ok) throw new Error(`refused: ${result.code}`);
      expect(result.jobs[0].payload).toMatchObject({ providerId: 'local' });
    });

    it('refuses a local checkpoint with 422 model_unavailable when the local provider is not registered', async () => {
      const { deps } = makeDeps();
      expect(
        await run(deps, { model: 'local-image/sdxl_base.safetensors', mode: 'generate', prompt: 'a kite' })
      ).toMatchObject({ ok: false, status: 422, code: 'model_unavailable' });
    });

    it('serves test-image only when the test provider is registered', async () => {
      const request = { model: 'test-image', mode: 'generate', prompt: 'a kite' };
      expect(await run(makeDeps().deps, request)).toMatchObject({ ok: false, code: 'model_unavailable' });
      const { deps } = makeDeps({ providers: createImageProviderRegistry([openAiProvider, new TestImageProvider()]) });
      const result = await run(deps, request);
      if (!result.ok) throw new Error(`refused: ${result.code}`);
      expect(result.jobs[0].payload).toMatchObject({ providerId: 'test' });
    });

    it('refuses model_unavailable when no API key is configured', async () => {
      const { deps } = makeDeps({ resolveApiKey: vi.fn(async () => null) });
      expect(await run(deps, validRequest)).toMatchObject({ ok: false, status: 422, code: 'model_unavailable' });
      expect(holdCredits).not.toHaveBeenCalled();
    });

    it('lets a rejected model admission propagate before any hold', async () => {
      const refusal = new Error('paid plan required');
      const { deps } = makeDeps({ assertModelAdmission: vi.fn().mockRejectedValue(refusal) });
      await expect(run(deps, validRequest)).rejects.toBe(refusal);
      expect(holdCredits).not.toHaveBeenCalled();
    });
  });

  describe('batches', () => {
    it('creates one job per image sharing a groupId, each with its own hold and a pinned quality', async () => {
      const { deps, repository } = makeDeps();
      const result = await run(deps, validRequest, { count: 3 });
      if (!result.ok) throw new Error(`refused: ${result.code}`);
      expect(result.created).toBe(true);
      expect(result.jobs).toHaveLength(3);
      expect(new Set(result.jobs.map(job => job.id)).size).toBe(3);
      for (const job of result.jobs) {
        expect(job).toMatchObject({
          kind: 'image',
          state: 'pending',
          payload: { groupId: result.groupId, providerId: 'openai' },
        });
        expect(job.payload.request).toEqual({ ...validRequest, quality: 'medium' });
        expect(job.creditHold).toEqual(expect.objectContaining({ userId: 'u1' }));
      }
      expect(holdCredits).toHaveBeenCalledTimes(3);
      expect(deps.enqueue).toHaveBeenCalledTimes(3);
      expect(repository.jobs.size).toBe(3);
    });

    it('persists the delivery target on every job of the batch', async () => {
      const { deps } = makeDeps();
      const delivery = { kind: 'slack' as const, workspaceId: 'w1', channelId: 'C1', threadTs: '1700000000.000100' };
      const result = await run(deps, validRequest, { count: 3, delivery });
      if (!result.ok) throw new Error(`refused: ${result.code}`);
      expect(result.jobs).toHaveLength(3);
      for (const job of result.jobs) expect(job.delivery).toEqual(delivery);
    });

    it('stores no delivery field when the input names none', async () => {
      const { deps } = makeDeps();
      const result = await run(deps, validRequest, { count: 2 });
      if (!result.ok) throw new Error(`refused: ${result.code}`);
      for (const job of result.jobs) expect(job).not.toHaveProperty('delivery');
    });

    it('records the batch size on every job so the group completes only when all members are in', async () => {
      const { deps } = makeDeps();
      const result = await run(deps, validRequest, { count: 3 });
      if (!result.ok) throw new Error(`refused: ${result.code}`);
      for (const job of result.jobs) expect(job.payload.groupSize).toBe(3);
    });

    it.each(['low', 'high', 'auto'] as const)('stores an explicit %s quality as asked', async quality => {
      const { deps } = makeDeps();
      const result = await run(deps, { ...validRequest, quality });
      if (!result.ok) throw new Error(`refused: ${result.code}`);
      expect(result.jobs[0].payload.request.quality).toBe(quality);
    });

    it.each(['standard', 'hd'] as const)('refuses the legacy %s tier the model does not list', async quality => {
      const { deps } = makeDeps();
      const result = await run(deps, { ...validRequest, quality });
      if (result.ok || result.code !== 'unsupported_by_model') throw new Error('expected unsupported_by_model');
      expect(result.failures.map(failure => failure.code)).toContain('unsupported_quality');
      expect(holdCredits).not.toHaveBeenCalled();
    });

    it('holds the same estimate for every job in the batch', async () => {
      const { deps } = makeDeps();
      await run(deps, validRequest, { count: 2 });
      const [first, second] = vi.mocked(holdCredits).mock.calls.map(([params]) => params.requiredCredits);
      expect(first).toBeGreaterThan(0);
      expect(second).toBe(first);
    });

    it('refuses with 402, releases the first hold and persists no job when the second hold fails', async () => {
      const firstHold = fakeHold({ userId: 'u1', requiredCredits: 1 });
      vi.mocked(holdCredits)
        .mockResolvedValueOnce(firstHold)
        .mockRejectedValueOnce(insufficientCreditsError('You do not have enough credits'));
      const { deps, repository } = makeDeps();
      expect(await run(deps, validRequest, { count: 2 })).toMatchObject({
        ok: false,
        status: 402,
        code: 'insufficient_credits',
      });
      expect(releaseCreditHold).toHaveBeenCalledTimes(1);
      expect(vi.mocked(releaseCreditHold).mock.calls[0][0]).toBe(firstHold);
      expect(repository.jobs.size).toBe(0);
      expect(deps.enqueue).not.toHaveBeenCalled();
    });

    it('refuses a batch whose total would take a new account over its spend cap, before any hold', async () => {
      vi.mocked(checkNewAccountSpendCap).mockResolvedValueOnce('New accounts can spend up to 100 credits per day');
      const { deps, repository } = makeDeps();
      expect(await run(deps, validRequest, { count: 3 })).toEqual({
        ok: false,
        status: 402,
        code: 'insufficient_credits',
        message: 'New accounts can spend up to 100 credits per day',
      });
      const [params] = vi.mocked(checkNewAccountSpendCap).mock.calls[0];
      expect(params).toMatchObject({ user: capUser, billedToOrganization: false });
      expect(holdCredits).not.toHaveBeenCalled();
      expect(repository.jobs.size).toBe(0);
      expect(deps.enqueue).not.toHaveBeenCalled();
    });

    it('checks the whole batch total against the spend cap and holds every job when it fits', async () => {
      const { deps } = makeDeps();
      const result = await run(deps, validRequest, { count: 3 });
      if (!result.ok) throw new Error(`refused: ${result.code}`);
      const perJob = vi.mocked(holdCredits).mock.calls[0][0].requiredCredits;
      expect(vi.mocked(checkNewAccountSpendCap).mock.calls[0][0].requestedCredits).toBe(3 * perJob);
      expect(holdCredits).toHaveBeenCalledTimes(3);
    });

    it('leaves a single job to its hold, which checks the spend cap itself', async () => {
      const { deps } = makeDeps();
      await run(deps, validRequest);
      expect(checkNewAccountSpendCap).not.toHaveBeenCalled();
      expect(holdCredits).toHaveBeenCalledTimes(1);
    });

    it('skips holds when credits are not enforced', async () => {
      const { deps } = makeDeps({ getSettings: async () => ({ enforceCredits: false }) });
      const result = await run(deps, validRequest, { count: 2 });
      if (!result.ok) throw new Error(`refused: ${result.code}`);
      expect(result.jobs.every(job => job.creditHold === null)).toBe(true);
      expect(holdCredits).not.toHaveBeenCalled();
    });
  });

  describe('idempotency', () => {
    it('replays the same batch without holding or enqueuing again', async () => {
      const { deps, repository } = makeDeps();
      const first = await run(deps, validRequest, { count: 2, idempotencyKey: 'k1' });
      const second = await run(deps, validRequest, { count: 2, idempotencyKey: 'k1' });
      if (!first.ok || !second.ok) throw new Error('expected both calls to succeed');
      expect(first.created).toBe(true);
      expect(second.created).toBe(false);
      expect(second.groupId).toBe(first.groupId);
      expect(second.jobs.map(job => job.id)).toEqual(first.jobs.map(job => job.id));
      expect(holdCredits).toHaveBeenCalledTimes(2);
      expect(deps.enqueue).toHaveBeenCalledTimes(2);
      expect(repository.jobs.size).toBe(2);
    });

    it('keys each job by index and batch size, so a different count never replays a partial batch', async () => {
      const { deps, repository } = makeDeps();
      const created = await run(deps, validRequest, { count: 2, idempotencyKey: 'k' });
      if (!created.ok) throw new Error(`refused: ${created.code}`);
      expect(created.jobs.map(job => job.idempotencyKey)).toEqual(['k:0/2', 'k:1/2']);
      expect([...repository.jobs.values()].map(job => job.idempotencyKey).sort()).toEqual(['k:0/2', 'k:1/2']);

      const resized = await run(deps, validRequest, { count: 3, idempotencyKey: 'k' });
      if (!resized.ok) throw new Error(`refused: ${resized.code}`);
      expect(resized.created).toBe(true);
      expect(resized.jobs.map(job => job.idempotencyKey)).toEqual(['k:0/3', 'k:1/3', 'k:2/3']);
    });

    it('looks every key up through the repository', async () => {
      const { deps, repository } = makeDeps();
      const lookup = vi.spyOn(repository, 'findByIdempotencyKey');
      await run(deps, validRequest, { count: 2, idempotencyKey: 'k' });
      expect(lookup.mock.calls.map(call => call[2])).toEqual(['k:0/2', 'k:1/2']);
    });

    it('treats an omitted quality and its pinned tier as the same request', async () => {
      const { deps } = makeDeps();
      const first = await run(deps, validRequest, { idempotencyKey: 'k1' });
      const second = await run(deps, { ...validRequest, quality: 'medium' }, { idempotencyKey: 'k1' });
      if (!first.ok || !second.ok) throw new Error('expected both calls to succeed');
      expect(second).toMatchObject({ created: false, jobs: [{ id: first.jobs[0].id }] });
    });

    it('rejects a reused key with a different request', async () => {
      const { deps } = makeDeps();
      await run(deps, validRequest, { idempotencyKey: 'k1' });
      expect(await run(deps, { ...validRequest, prompt: 'a blue bicycle' }, { idempotencyKey: 'k1' })).toMatchObject({
        ok: false,
        status: 422,
        code: 'idempotency_key_reused',
      });
    });
  });

  describe('inputs and storage', () => {
    it('refuses a missing input file with 422 before any hold', async () => {
      const { deps } = makeDeps({ loadInputFile: vi.fn(async () => null) });
      const result = await run(deps, {
        model: ImageModels.GPT_IMAGE_2,
        mode: 'generate',
        prompt: 'x',
        inputs: [{ role: 'reference', fileId: FILE_ID }],
      });
      expect(result).toMatchObject({ ok: false, status: 422, code: 'input_image_not_found' });
      expect(deps.loadInputFile).toHaveBeenCalledWith('u1', FILE_ID);
      expect(holdCredits).not.toHaveBeenCalled();
    });

    const inputRequest = (role: 'reference' | 'edit_source' | 'mask') => ({
      model: ImageModels.GPT_IMAGE_2,
      mode: role === 'reference' ? 'generate' : 'edit',
      prompt: 'x',
      inputs:
        role === 'mask'
          ? [
              { role: 'edit_source', fileId: SOURCE_ID },
              { role, fileId: FILE_ID },
            ]
          : [{ role, fileId: FILE_ID }],
    });
    const loadingAs = (mimeType: string) =>
      makeDeps({ loadInputFile: vi.fn(async () => ({ bytes: Buffer.from('x'), mimeType })) });

    it.each([
      ['reference', 'image/gif'],
      ['edit_source', 'image/gif'],
      ['mask', 'image/webp'],
    ] as const)('refuses a %s of type %s with 422 unsupported_input_image before any hold', async (role, mimeType) => {
      const { deps, repository } = loadingAs(mimeType);
      expect(await run(deps, inputRequest(role))).toMatchObject({
        ok: false,
        status: 422,
        code: 'unsupported_input_image',
      });
      expect(holdCredits).not.toHaveBeenCalled();
      expect(repository.jobs.size).toBe(0);
      expect(deps.enqueue).not.toHaveBeenCalled();
    });

    it.each([
      ['reference', 'image/webp'],
      ['edit_source', 'IMAGE/JPEG'],
      ['edit_source', 'image/png; charset=binary'],
      ['mask', 'image/png; charset=binary'],
      ['mask', 'image/jpeg'],
    ] as const)('accepts a %s of type %s', async (role, mimeType) => {
      const { deps } = loadingAs(mimeType);
      const result = await run(deps, inputRequest(role));
      if (!result.ok) throw new Error(`refused: ${result.code} ${result.message}`);
      expect(result.created).toBe(true);
    });

    it('refuses with 400 storage_quota_exceeded when the Files quota lacks room, sized per new job', async () => {
      const storage = { limit: 1 } as unknown as StorageLimitErrorInfo;
      const { deps } = makeDeps({ checkStorageFor: vi.fn(async () => storage) });
      expect(await run(deps, validRequest, { count: 3 })).toMatchObject({
        ok: false,
        status: 400,
        code: 'storage_quota_exceeded',
        storage,
      });
      expect(deps.checkStorageFor).toHaveBeenCalledWith('u1', 3 * IMAGE_JOB_OUTPUT_BYTES_ESTIMATE);
      expect(holdCredits).not.toHaveBeenCalled();
    });
  });

  describe('hold and persist failures', () => {
    const numberedHolds = () => {
      let next = 0;
      vi.mocked(holdCredits).mockImplementation(async params => ({
        ...fakeHold(params),
        balanceAfterHold: 1000 - next++,
      }));
    };
    const releasedBalances = () => vi.mocked(releaseCreditHold).mock.calls.map(([hold]) => hold.balanceAfterHold);

    it('releases the holds already taken and rethrows when a later hold throws', async () => {
      const failure = new Error('credit store down');
      numberedHolds();
      vi.mocked(holdCredits)
        .mockImplementationOnce(async params => ({ ...fakeHold(params), balanceAfterHold: 1000 }))
        .mockImplementationOnce(async params => ({ ...fakeHold(params), balanceAfterHold: 999 }))
        .mockRejectedValueOnce(failure);
      const { deps, repository } = makeDeps();
      await expect(run(deps, validRequest, { count: 3 })).rejects.toBe(failure);
      expect(releaseCreditHold).toHaveBeenCalledTimes(2);
      expect(releasedBalances()).toEqual([1000, 999]);
      expect(repository.jobs.size).toBe(0);
      expect(deps.enqueue).not.toHaveBeenCalled();
    });

    it('returns the failed job hold and the unattached ones when the second job cannot be persisted', async () => {
      numberedHolds();
      const { deps, repository } = makeDeps();
      const createJob = repository.createJob.bind(repository);
      let calls = 0;
      vi.spyOn(repository, 'createJob').mockImplementation(async input => {
        if (++calls === 2) throw new Error('mongo down');
        return createJob(input);
      });
      await expect(run(deps, validRequest, { count: 3 })).rejects.toThrow('mongo down');
      // Job 1 is persisted and owns hold 1000. Job 2 returned its own hold (999) and persistBatch returned job 3's.
      expect(releaseCreditHold).toHaveBeenCalledTimes(2);
      expect(releasedBalances().sort()).toEqual([998, 999]);
      expect(repository.jobs.size).toBe(1);
      expect(deps.enqueue).toHaveBeenCalledTimes(1);
    });

    it('logs what to return by hand when releasing a hold fails, and still surfaces the refusal', async () => {
      const firstHold = fakeHold({ userId: 'u1', requiredCredits: 7 });
      vi.mocked(holdCredits)
        .mockResolvedValueOnce(firstHold)
        .mockRejectedValueOnce(insufficientCreditsError('You do not have enough credits'));
      vi.mocked(releaseCreditHold).mockRejectedValueOnce(new Error('ledger down'));
      const { deps } = makeDeps();
      const logged = vi.spyOn(deps.logger, 'error');
      expect(await run(deps, validRequest, { count: 2 })).toMatchObject({ ok: false, status: 402 });
      expect(logged).toHaveBeenCalledWith(
        'image_job_create_hold_release_failed',
        expect.objectContaining({
          ownerId: firstHold.ownerId,
          ownerType: firstHold.ownerType,
          reservedCredits: 7,
          error: expect.any(Error),
        })
      );
    });
  });

  describe('enqueue failure', () => {
    it('releases the hold and fails the job when enqueue throws', async () => {
      const { deps, repository } = makeDeps({
        enqueue: vi.fn(async () => {
          throw new Error('SQS down');
        }),
      });
      await expect(run(deps, validRequest)).rejects.toThrow('SQS down');
      const [job] = [...repository.jobs.values()];
      expect(job).toMatchObject({ kind: 'image', state: 'failed', error: { code: 'enqueue_failed' } });
      expect(releaseCreditHold).toHaveBeenCalledTimes(1);
    });
  });
});
