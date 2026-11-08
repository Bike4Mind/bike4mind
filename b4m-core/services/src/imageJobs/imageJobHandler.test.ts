import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ALL_IMAGE_MODELS,
  CreditHolderType,
  IMAGE_MODEL_CATALOG,
  ImageModels,
  type ImageModels as ImageModelId,
} from '@bike4mind/common';
import {
  createImageProviderRegistry,
  type ImageProvider,
  type ProviderTerminalResult,
} from '@bike4mind/utils/imageProviders';
import { Logger } from '@bike4mind/observability';
import { createInMemoryGenerationJobRepository } from '../generationJobs/__test__/inMemoryGenerationJobRepository';
import { GenerationJobEngine } from '../generationJobs/engine';
import type { CreditHoldAdapters } from '../creditService/creditHold';
import { createImageJobs } from './createImageJobs';
import { createImageJobHandler } from './imageJobHandler';
import type { CreateImageJobsDeps, CreateImageJobsResult, ImageJob } from './types';

vi.mock('../creditService/creditHold', () => ({
  holdCredits: vi.fn(),
  releaseCreditHold: vi.fn(async () => undefined),
  settleCreditHold: vi.fn(async (_hold: unknown, charged: number) => charged),
}));
import { holdCredits, releaseCreditHold, settleCreditHold } from '../creditService/creditHold';

// creditHold is module-mocked, so the adapters are never touched.
const unusedCredits = {} as CreditHoldAdapters;

const OPENAI_IMAGE_MODEL_IDS = ALL_IMAGE_MODELS.filter(id => IMAGE_MODEL_CATALOG[id].provider === 'openai');
const MODEL = ImageModels.GPT_IMAGE_1;
const SOURCE_FILE_ID = 'a'.repeat(24);
const MASK_FILE_ID = 'b'.repeat(24);
const PNG_BYTES = Buffer.from('fake-png-bytes');

type Generate = Extract<ImageProvider, { mode: 'sync' }>['generate'];

const succeeded: ProviderTerminalResult = {
  status: 'succeeded',
  output: { kind: 'inline', base64: PNG_BYTES.toString('base64'), contentType: 'image/png' },
};

const makeProvider = (generate: Generate): ImageProvider & { fetchOutput: ReturnType<typeof vi.fn> } => ({
  mode: 'sync',
  id: 'openai',
  models: OPENAI_IMAGE_MODEL_IDS as ImageModelId[],
  generate,
  fetchOutput: vi.fn(async () => PNG_BYTES),
});

const setup = (generate: Generate, overrides: Partial<CreateImageJobsDeps> = {}) => {
  let clock = new Date('2026-10-13T00:00:00Z');
  const repository = createInMemoryGenerationJobRepository({ now: () => clock });
  const queue: string[] = [];
  const provider = makeProvider(generate);
  const deps: CreateImageJobsDeps = {
    assertModelAdmission: vi.fn(async () => {}),
    repository,
    providers: createImageProviderRegistry([provider]),
    getSettings: async () => ({ enforceCredits: true }),
    resolveApiKey: vi.fn(async () => 'key'),
    loadInputFile: vi.fn(async () => ({ bytes: Buffer.from('input'), mimeType: 'image/png' })),
    moderate: vi.fn(async () => ({ blocked: false as const })),
    checkStorageFor: async () => undefined,
    saveToFiles: vi.fn(async ({ generation: { jobId } }: { generation: { jobId: string } }) => ({
      saved: true as const,
      fileId: `file-${jobId}`,
      s3Key: `files/${jobId}.png`,
      fileName: 'image.png',
    })),
    saveToGeneratedBucket: vi.fn(async ({ key }: { key: string }) => ({ s3Key: key })),
    credits: unusedCredits,
    enqueue: vi.fn(async (jobId: string) => {
      queue.push(jobId);
    }),
    recordUsage: vi.fn(async () => undefined),
    now: () => clock,
    logger: new Logger({ metadata: { test: 'imageJobHandler' } }),
    engine: { failBeforeStart: (jobId, error) => engine.failBeforeStart(jobId, error) },
    ...overrides,
  };
  const engine = new GenerationJobEngine({
    repository,
    handlers: [createImageJobHandler(deps)],
    enqueue: deps.enqueue,
    notify: async () => undefined,
    now: () => clock,
    logger: deps.logger,
    leaseMs: 330_000,
  });
  const runToCompletion = async () => {
    for (let i = 0; i < 20 && queue.length; i++) {
      const jobId = queue.shift();
      if (!jobId) break;
      clock = new Date(clock.getTime() + 60_000);
      await engine.step(jobId);
    }
  };
  const jobOf = (created: CreateImageJobsResult): ImageJob => {
    if (!created.ok) throw new Error(`createImageJobs refused: ${created.code}`);
    const job = repository.jobs.get(created.jobs[0].id);
    if (!job || job.kind !== 'image') throw new Error('image job vanished');
    return job;
  };
  return { deps, repository, engine, provider, runToCompletion, jobOf };
};

const user = { id: 'u1', organizationId: null };
const request = (extra: Record<string, unknown> = {}) => ({
  model: MODEL,
  mode: 'generate',
  prompt: 'a red bicycle',
  ...extra,
});
const editRequest = () =>
  request({
    mode: 'edit',
    inputs: [
      { role: 'edit_source', fileId: SOURCE_FILE_ID },
      { role: 'mask', fileId: MASK_FILE_ID },
    ],
  });

const create = (t: ReturnType<typeof setup>, req: Record<string, unknown> = request()) =>
  createImageJobs({ user, request: req, count: 1, source: 'studio' }, t.deps);

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(holdCredits).mockImplementation(async params => ({
    ownerId: params.userId,
    ownerType: CreditHolderType.User,
    userId: params.userId,
    organizationId: null,
    reservedCredits: params.requiredCredits,
    balanceAfterHold: 1000,
  }));
});

describe('image job handler through the real engine', () => {
  it('generates, moderates, saves to Files and settles the hold', async () => {
    const generate = vi.fn<Generate>(async () => succeeded);
    const t = setup(generate);
    const created = await create(t);
    const job = t.jobOf(created);
    expect(await t.engine.step(job.id)).toBe('terminal');

    const done = t.jobOf(created);
    expect(done.state).toBe('succeeded');
    expect(done.payload.output).toMatchObject({
      location: 'files',
      fileId: `file-${job.id}`,
      contentType: 'image/png',
      bytes: PNG_BYTES.byteLength,
    });
    expect(generate).toHaveBeenCalledTimes(1);
    expect(generate).toHaveBeenCalledWith(
      job.payload.request,
      { images: [] },
      expect.objectContaining({ apiKey: 'key' })
    );
    expect(t.deps.moderate).toHaveBeenCalledWith(expect.objectContaining({ bytes: PNG_BYTES, mimeType: 'image/png' }));
    expect(t.deps.saveToFiles).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'u1',
        bytes: PNG_BYTES,
        contentType: 'image/png',
        generation: {
          generator: 'image',
          provider: 'openai',
          modelId: MODEL,
          jobId: job.id,
          prompt: 'a red bicycle',
          request: job.payload.request,
        },
      })
    );
    expect(vi.mocked(t.deps.saveToFiles).mock.calls[0][0]).not.toHaveProperty('derivedFrom');
    expect(settleCreditHold).toHaveBeenCalledTimes(1);
    expect(vi.mocked(settleCreditHold).mock.calls[0][2]).toMatchObject({
      type: 'image_generation_usage',
      model: MODEL,
    });
    expect(releaseCreditHold).not.toHaveBeenCalled();
    expect(t.deps.recordUsage).toHaveBeenCalledWith(expect.objectContaining({ status: 'ok' }));
  });

  it('passes resolved inputs to the provider, records lineage, and settles an edit as image_edit_usage', async () => {
    const generate = vi.fn<Generate>(async () => succeeded);
    const t = setup(generate, {
      loadInputFile: vi.fn(async (_userId: string, fileId: string) => ({
        bytes: Buffer.from(`bytes-${fileId}`),
        mimeType: 'image/webp',
      })),
    });
    const created = await create(t, editRequest());
    const job = t.jobOf(created);
    await t.runToCompletion();

    expect(t.jobOf(created).state).toBe('succeeded');
    expect(t.deps.loadInputFile).toHaveBeenCalledWith('u1', SOURCE_FILE_ID);
    expect(t.deps.loadInputFile).toHaveBeenCalledWith('u1', MASK_FILE_ID);
    expect(generate).toHaveBeenCalledWith(
      job.payload.request,
      {
        images: [
          { role: 'edit_source', bytes: Buffer.from(`bytes-${SOURCE_FILE_ID}`), mimeType: 'image/webp' },
          { role: 'mask', bytes: Buffer.from(`bytes-${MASK_FILE_ID}`), mimeType: 'image/webp' },
        ],
      },
      expect.anything()
    );
    expect(t.deps.saveToFiles).toHaveBeenCalledWith(
      expect.objectContaining({
        derivedFrom: [
          { fileId: SOURCE_FILE_ID, role: 'edit_source', jobId: job.id },
          { fileId: MASK_FILE_ID, role: 'mask', jobId: job.id },
        ],
      })
    );
    expect(vi.mocked(settleCreditHold).mock.calls[0][2]).toMatchObject({ type: 'image_edit_usage' });
  });

  it('falls back to the generated bucket when Files refuses', async () => {
    const t = setup(
      vi.fn<Generate>(async () => succeeded),
      { saveToFiles: vi.fn(async () => ({ saved: false as const, reason: 'storage_limit' as const })) }
    );
    const created = await create(t);
    await t.runToCompletion();
    const job = t.jobOf(created);
    expect(job.state).toBe('succeeded');
    expect(job.payload.output).toMatchObject({ location: 'generated', s3Key: `generated-images/u1/${job.id}.png` });
    expect(job.payload.output?.fileId).toBeUndefined();
    expect(t.deps.saveToGeneratedBucket).toHaveBeenCalledWith(
      expect.objectContaining({ key: `generated-images/u1/${job.id}.png`, contentType: 'image/png' })
    );
  });

  it('blocks on our own moderation: nothing saved, hold released not settled', async () => {
    const t = setup(
      vi.fn<Generate>(async () => succeeded),
      { moderate: vi.fn(async () => ({ blocked: true as const, reason: 'not allowed' })) }
    );
    const created = await create(t);
    await t.runToCompletion();
    expect(t.jobOf(created)).toMatchObject({
      state: 'blocked',
      error: { code: 'content_blocked', message: 'not allowed' },
    });
    expect(t.deps.saveToFiles).not.toHaveBeenCalled();
    expect(t.deps.saveToGeneratedBucket).not.toHaveBeenCalled();
    expect(releaseCreditHold).toHaveBeenCalledTimes(1);
    expect(settleCreditHold).not.toHaveBeenCalled();
    expect(t.deps.recordUsage).not.toHaveBeenCalled();
  });

  it('settles a billed provider block and records it as a refusal', async () => {
    const t = setup(vi.fn<Generate>(async () => ({ status: 'blocked', billed: true, raw: {} })));
    const created = await create(t);
    await t.runToCompletion();
    expect(t.jobOf(created)).toMatchObject({
      state: 'blocked',
      error: { code: 'content_blocked' },
      payload: { billedBlock: true },
    });
    expect(settleCreditHold).toHaveBeenCalledTimes(1);
    expect(releaseCreditHold).not.toHaveBeenCalled();
    expect(t.deps.recordUsage).toHaveBeenCalledWith(expect.objectContaining({ status: 'refusal' }));
    expect(t.deps.saveToFiles).not.toHaveBeenCalled();
  });

  it('releases an unbilled provider block', async () => {
    const t = setup(vi.fn<Generate>(async () => ({ status: 'blocked', billed: false, raw: {} })));
    const created = await create(t);
    await t.runToCompletion();
    expect(t.jobOf(created).state).toBe('blocked');
    expect(releaseCreditHold).toHaveBeenCalledTimes(1);
    expect(settleCreditHold).not.toHaveBeenCalled();
    expect(t.deps.recordUsage).not.toHaveBeenCalled();
  });

  it('fails a non-retryable provider failure without retrying and releases the hold', async () => {
    const generate = vi.fn<Generate>(async () => ({
      status: 'failed',
      retryable: false,
      message: 'bad request',
      raw: {},
    }));
    const t = setup(generate);
    const created = await create(t);
    await t.runToCompletion();
    expect(t.jobOf(created)).toMatchObject({
      state: 'failed',
      error: { code: 'provider_error', message: 'bad request' },
      settledCredits: 0,
    });
    expect(generate).toHaveBeenCalledTimes(1);
    expect(releaseCreditHold).toHaveBeenCalledTimes(1);
    expect(settleCreditHold).not.toHaveBeenCalled();
  });

  it('retries a retryable provider failure and then succeeds', async () => {
    const generate = vi
      .fn<Generate>()
      .mockResolvedValueOnce({ status: 'failed', retryable: true, message: '429', raw: {} })
      .mockResolvedValueOnce(succeeded);
    const t = setup(generate);
    const error = vi.spyOn(t.deps.logger, 'error');
    const created = await create(t);
    await t.runToCompletion();
    expect(t.jobOf(created).state).toBe('succeeded');
    expect(generate).toHaveBeenCalledTimes(2);
    expect(error).not.toHaveBeenCalledWith('generation_job_orphaned_submit', expect.anything());
    expect(settleCreditHold).toHaveBeenCalledTimes(1);
  });

  it('fails a thrown generate as orphaned_submit, never calling it again, and releases the hold', async () => {
    const generate = vi.fn<Generate>(async () => {
      throw new Error('socket hang up');
    });
    const t = setup(generate);
    const created = await create(t);
    await t.runToCompletion();
    // A redelivered message must not resubmit either.
    await t.engine.step(t.jobOf(created).id);
    expect(t.jobOf(created)).toMatchObject({ state: 'failed', error: { code: 'orphaned_submit' } });
    expect(generate).toHaveBeenCalledTimes(1);
    expect(releaseCreditHold).toHaveBeenCalledTimes(1);
    expect(settleCreditHold).not.toHaveBeenCalled();
    expect(t.deps.saveToFiles).not.toHaveBeenCalled();
  });

  it('fails input_image_not_found when an input vanished after create', async () => {
    const generate = vi.fn<Generate>(async () => succeeded);
    const t = setup(generate);
    const created = await create(t, editRequest());
    vi.mocked(t.deps.loadInputFile).mockResolvedValue(null);
    await t.runToCompletion();
    expect(t.jobOf(created)).toMatchObject({ state: 'failed', error: { code: 'input_image_not_found' } });
    expect(generate).not.toHaveBeenCalled();
    expect(releaseCreditHold).toHaveBeenCalledTimes(1);
  });

  it('fails provider_error without calling the provider when no API key is configured', async () => {
    const generate = vi.fn<Generate>(async () => succeeded);
    const t = setup(generate);
    const created = await create(t);
    vi.mocked(t.deps.resolveApiKey).mockResolvedValue(null);
    await t.runToCompletion();
    expect(t.jobOf(created)).toMatchObject({ state: 'failed', error: { code: 'provider_error' } });
    expect(generate).not.toHaveBeenCalled();
    expect(releaseCreditHold).toHaveBeenCalledTimes(1);
    expect(settleCreditHold).not.toHaveBeenCalled();
  });
});
