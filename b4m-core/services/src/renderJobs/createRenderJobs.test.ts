import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CreditHolderType,
  StudioCompositionContentSchema,
  insufficientCreditsError,
  MODEL_REQUIRES_SUBSCRIPTION_ERROR_CODE,
  PAID_PLAN_ENTITLEMENT_KEY,
  usdToCredits,
  type IStudioCompositionDocument,
  type StudioRenderPricing,
  type StudioTimelineInput,
} from '@bike4mind/common';
import { Logger } from '@bike4mind/observability';
import { ForbiddenError } from '@bike4mind/utils';
import { createInMemoryGenerationJobRepository } from '../generationJobs/__test__/inMemoryGenerationJobRepository';
import { GenerationJobEngine } from '../generationJobs/engine';
import type { CreditHold, CreditHoldAdapters } from '../creditService/creditHold';
import { createRenderJobs } from './createRenderJobs';
import { createRenderJobHandler } from './renderJobHandler';
import { RENDER_OUTPUT_BYTES_PER_SECOND_ESTIMATE, type CreateRenderJobsDeps } from './types';

vi.mock('../creditService/creditHold', () => ({
  holdCredits: vi.fn(),
  releaseCreditHold: vi.fn(async () => undefined),
  settleCreditHold: vi.fn(async (_hold: unknown, charged: number) => charged),
}));
import { holdCredits, releaseCreditHold } from '../creditService/creditHold';

const FILE_A = 'a'.repeat(24);
const FILE_B = 'b'.repeat(24);
const COMPOSITION_ID = 'c'.repeat(24);

const PRICING: StudioRenderPricing = { usdPerOutputSecond: { '16:9': 0.01, '9:16': 0.02, '1:1': 0.03, '4:5': 0.04 } };

const OUTPUTS = [
  { id: 'out-wide', aspectRatio: '16:9', width: 1920, height: 1080 },
  { id: 'out-tall', aspectRatio: '9:16', width: 1080, height: 1920 },
  { id: 'out-square', aspectRatio: '1:1', width: 1080, height: 1080 },
] as const;

// 15.2s, so the billed seconds (16) differ from the raw duration.
const timelineInput = (overrides: Partial<StudioTimelineInput> = {}): StudioTimelineInput => ({
  version: 1,
  durationMs: 15_200,
  fps: 30,
  outputs: [...OUTPUTS],
  tracks: [
    {
      id: 'video-1',
      kind: 'video',
      clips: [
        { id: 'v1', fileId: FILE_A, startMs: 0, durationMs: 5000 },
        { id: 'v2', fileId: FILE_B, startMs: 5000, durationMs: 5000 },
      ],
    },
    { id: 'captions-1', kind: 'captions', clips: [{ id: 'c1', text: 'Ride further', startMs: 0, durationMs: 2000 }] },
  ],
  ...overrides,
});

const compositionWith = (timeline: unknown): IStudioCompositionDocument => ({
  ...StudioCompositionContentSchema.parse({ title: 'Spring ad', timeline: timelineInput() }),
  id: COMPOSITION_ID,
  userId: 'u1',
  createdAt: new Date('2026-01-01T00:00:00Z'),
  updatedAt: new Date('2026-01-01T00:00:00Z'),
  timeline: timeline as IStudioCompositionDocument['timeline'],
});

const fakeHold = (params: { userId: string; requiredCredits: number }): CreditHold => ({
  ownerId: params.userId,
  ownerType: CreditHolderType.User,
  userId: params.userId,
  organizationId: null,
  reservedCredits: params.requiredCredits,
  balanceAfterHold: 1000,
});

const user = { id: 'u1', organizationId: null };
const paid = async () => [PAID_PLAN_ENTITLEMENT_KEY];
const ALL_OUTPUT_IDS = OUTPUTS.map(output => output.id);

const setup = (overrides: Partial<CreateRenderJobsDeps> = {}) => {
  const repository = createInMemoryGenerationJobRepository();
  const deps: CreateRenderJobsDeps = {
    repository,
    // creditHold is module-mocked; the batch spend cap reads users.findById and the freeze check
    // reads spendFreezes (null for both: nothing to cap, no freeze).
    credits: {
      users: { findById: vi.fn(async () => null) },
      spendFreezes: { findActiveForSubject: vi.fn(async () => null) },
    } as unknown as CreditHoldAdapters,
    enqueue: vi.fn(async () => undefined),
    engine: { failBeforeStart: (jobId, error) => engine.failBeforeStart(jobId, error) },
    getSettings: async () => ({ enforceCredits: true, pricing: PRICING }),
    planlessDeployment: false,
    findComposition: vi.fn(async () => compositionWith(timelineInput())),
    findReadableFiles: vi.fn(
      async () =>
        new Map([
          [FILE_A, 'video/mp4'],
          [FILE_B, 'image/png'],
        ])
    ),
    checkStorageFor: vi.fn(async () => undefined),
    now: () => new Date('2026-11-17T00:00:00Z'),
    logger: new Logger({ metadata: { test: 'createRenderJobs' } }),
    ...overrides,
  };
  const engine = new GenerationJobEngine({
    repository,
    handlers: [
      createRenderJobHandler({
        repository,
        credits: deps.credits,
        dispatchRender: async () => undefined,
        readRenderStatus: async () => null,
        fetchRenderedOutput: async () => Buffer.alloc(0),
        saveToFiles: vi.fn(),
        saveToGeneratedBucket: vi.fn(),
        now: deps.now,
        logger: deps.logger,
      }),
    ],
    enqueue: deps.enqueue,
    notify: async () => undefined,
    now: deps.now,
    logger: deps.logger,
    leaseMs: 330_000,
  });
  return { deps, repository };
};

const run = (deps: CreateRenderJobsDeps, outputIds: string[] = ALL_OUTPUT_IDS) =>
  createRenderJobs({ user, getEntitlements: paid, compositionId: COMPOSITION_ID, outputIds }, deps);

describe('createRenderJobs', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(holdCredits).mockImplementation(async params => fakeHold(params));
  });

  describe('paid-plan gate', () => {
    it('refuses a free-tier user before reading the composition or holding credits', async () => {
      const { deps, repository } = setup();
      const findComposition = vi.spyOn(deps, 'findComposition');
      const error = await createRenderJobs(
        { user, getEntitlements: async () => [], compositionId: COMPOSITION_ID, outputIds: ALL_OUTPUT_IDS },
        deps
      ).catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(ForbiddenError);
      expect((error as ForbiddenError).additionalInfo?.errorCode).toBe(MODEL_REQUIRES_SUBSCRIPTION_ERROR_CODE);
      expect(findComposition).not.toHaveBeenCalled();
      expect(holdCredits).not.toHaveBeenCalled();
      expect(await repository.listByRequester({ requestedBy: user.id, kind: 'render', limit: 10 })).toHaveLength(0);
    });

    it('admits an exempt admin without a paid plan', async () => {
      const { deps } = setup();
      const result = await createRenderJobs(
        {
          user: { ...user, isAdmin: true },
          getEntitlements: async () => [],
          compositionId: COMPOSITION_ID,
          outputIds: ALL_OUTPUT_IDS,
        },
        deps
      );
      expect(result.ok).toBe(true);
    });

    it('admits a free user on a planless (self-host) deployment', async () => {
      const { deps } = setup({ planlessDeployment: true });
      const result = await createRenderJobs(
        { user, getEntitlements: async () => [], compositionId: COMPOSITION_ID, outputIds: ALL_OUTPUT_IDS },
        deps
      );
      expect(result.ok).toBe(true);
    });

    it('still refuses a free user on a hosted install with the free-tier model gate off', async () => {
      // The render gate never reads freeTierModelGateEnabled: opening models to free users must not open exports.
      const { deps } = setup({ planlessDeployment: false });
      const getSettings = vi.spyOn(deps, 'getSettings');
      const error = await createRenderJobs(
        { user, getEntitlements: async () => [], compositionId: COMPOSITION_ID, outputIds: ALL_OUTPUT_IDS },
        deps
      ).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(ForbiddenError);
      expect(getSettings).not.toHaveBeenCalled();
    });
  });

  it('creates one held, enqueued job per output under one group, each priced from its own ratio', async () => {
    const { deps } = setup();
    const result = await run(deps);
    if (!result.ok) throw new Error(`refused: ${result.code}`);

    expect(result.jobs).toHaveLength(3);
    expect(new Set(result.jobs.map(job => job.payload.groupId))).toEqual(new Set([result.groupId]));
    const expectedRates = [0.01, 0.02, 0.03];
    result.jobs.forEach((job, index) => {
      const usd = 16 * expectedRates[index];
      expect(job).toMatchObject({
        kind: 'render',
        state: 'pending',
        source: 'studio',
        requestedBy: 'u1',
        ownerType: CreditHolderType.User,
        ownerId: 'u1',
        payload: {
          groupSize: 3,
          pricing: { usdPerOutputSecond: expectedRates[index], billedSeconds: 16, usd },
          request: { compositionId: COMPOSITION_ID, title: 'Spring ad', output: OUTPUTS[index] },
        },
        creditHold: { reservedCredits: usdToCredits(usd) },
      });
      expect(deps.enqueue).toHaveBeenCalledWith(job.id, 0);
    });
    expect(holdCredits).toHaveBeenCalledTimes(3);
    expect(holdCredits).toHaveBeenCalledWith(
      expect.objectContaining({ featureLabel: 'studio render', requiredCredits: usdToCredits(0.16) }),
      deps.credits
    );
  });

  it('stamps the deadline from the wall-clock budget and sizes the storage check for every output', async () => {
    const { deps } = setup();
    const result = await run(deps);
    if (!result.ok) throw new Error(`refused: ${result.code}`);
    expect(result.jobs[0].deadlineAt.getTime()).toBe(new Date('2026-11-17T01:00:00Z').getTime());
    expect(deps.checkStorageFor).toHaveBeenCalledWith('u1', 3 * 16 * RENDER_OUTPUT_BYTES_PER_SECOND_ESTIMATE);
  });

  it('renders a single selected output and ignores a repeated id', async () => {
    const { deps } = setup();
    const result = await run(deps, ['out-tall', 'out-tall']);
    if (!result.ok) throw new Error(`refused: ${result.code}`);
    expect(result.jobs).toHaveLength(1);
    expect(result.jobs[0].payload).toMatchObject({ groupSize: 1, request: { output: { id: 'out-tall' } } });
  });

  it('bills an organization member against the organization', async () => {
    const { deps } = setup();
    const result = await createRenderJobs(
      {
        user: { id: 'u1', organizationId: 'org1' },
        getEntitlements: paid,
        compositionId: COMPOSITION_ID,
        outputIds: ['out-wide'],
      },
      deps
    );
    expect(result).toMatchObject({
      ok: true,
      jobs: [{ ownerType: CreditHolderType.Organization, ownerId: 'org1' }],
    });
  });

  it('skips the holds when credits are not enforced', async () => {
    const { deps } = setup({ getSettings: async () => ({ enforceCredits: false, pricing: PRICING }) });
    const result = await run(deps);
    expect(result).toMatchObject({
      ok: true,
      jobs: [{ creditHold: null }, { creditHold: null }, { creditHold: null }],
    });
    expect(holdCredits).not.toHaveBeenCalled();
  });

  it('answers a missing or foreign composition as 404 composition_not_found', async () => {
    const { deps } = setup({ findComposition: vi.fn(async () => null) });
    expect(await run(deps)).toMatchObject({ ok: false, status: 404, code: 'composition_not_found' });
    expect(deps.findComposition).toHaveBeenCalledWith(COMPOSITION_ID, 'u1');
    expect(holdCredits).not.toHaveBeenCalled();
  });

  it('refuses a stored timeline that no longer parses as invalid_timeline', async () => {
    const { deps } = setup({ findComposition: vi.fn(async () => compositionWith({ version: 99 })) });
    expect(await run(deps)).toMatchObject({ ok: false, status: 422, code: 'invalid_timeline' });
    expect(holdCredits).not.toHaveBeenCalled();
  });

  it('refuses a parsed timeline that breaks a rule (overlapping clips) as invalid_timeline', async () => {
    const overlapping = timelineInput({
      tracks: [
        {
          id: 'video-1',
          kind: 'video',
          clips: [
            { id: 'v1', fileId: FILE_A, startMs: 0, durationMs: 5000 },
            { id: 'v2', fileId: FILE_A, startMs: 4000, durationMs: 5000 },
          ],
        },
      ],
    });
    const { deps } = setup({ findComposition: vi.fn(async () => compositionWith(overlapping)) });
    expect(await run(deps)).toMatchObject({ ok: false, status: 422, code: 'invalid_timeline' });
  });

  it('refuses a clip whose file kind its track cannot play as invalid_timeline', async () => {
    const { deps } = setup({
      findReadableFiles: vi.fn(
        async () =>
          new Map([
            [FILE_A, 'application/pdf'],
            [FILE_B, 'image/png'],
          ])
      ),
    });
    expect(await run(deps)).toMatchObject({ ok: false, status: 422, code: 'invalid_timeline' });
  });

  it.each([
    ['no tracks', timelineInput({ tracks: [] })],
    ['only empty tracks', timelineInput({ tracks: [{ id: 'video-1', kind: 'video', clips: [] }] })],
    [
      'only disabled tracks',
      timelineInput({
        tracks: [
          {
            id: 'video-1',
            kind: 'video',
            enabled: false,
            clips: [{ id: 'v1', fileId: FILE_A, startMs: 0, durationMs: 5000 }],
          },
        ],
      }),
    ],
  ])('refuses a timeline with %s as empty_timeline', async (_label, timeline) => {
    const { deps } = setup({ findComposition: vi.fn(async () => compositionWith(timeline)) });
    expect(await run(deps)).toMatchObject({ ok: false, status: 422, code: 'empty_timeline' });
    expect(deps.findReadableFiles).not.toHaveBeenCalled();
  });

  it('ignores an unreadable file on a disabled track and admits the export', async () => {
    const timeline = timelineInput({
      tracks: [
        { id: 'video-1', kind: 'video', clips: [{ id: 'v1', fileId: FILE_A, startMs: 0, durationMs: 5000 }] },
        {
          id: 'music-1',
          kind: 'music',
          enabled: false,
          clips: [{ id: 'm1', fileId: FILE_B, startMs: 0, durationMs: 5000 }],
        },
      ],
    });
    const { deps } = setup({
      findComposition: vi.fn(async () => compositionWith(timeline)),
      findReadableFiles: vi.fn(async () => new Map([[FILE_A, 'video/mp4']])),
    });
    expect(await run(deps)).toMatchObject({ ok: true });
    expect(deps.findReadableFiles).toHaveBeenCalledWith([FILE_A], 'u1');
  });

  it('admits captions synced to a voice clip on a disabled track', async () => {
    const timeline = timelineInput({
      tracks: [
        { id: 'video-1', kind: 'video', clips: [{ id: 'v1', fileId: FILE_A, startMs: 0, durationMs: 5000 }] },
        {
          id: 'voice-1',
          kind: 'voice',
          enabled: false,
          clips: [{ id: 'vo1', fileId: FILE_B, startMs: 0, durationMs: 5000 }],
        },
        {
          id: 'captions-1',
          kind: 'captions',
          clips: [{ id: 'c1', text: 'Hello', startMs: 0, durationMs: 1000, syncedVoiceClipId: 'vo1' }],
        },
      ],
    });
    const { deps } = setup({
      findComposition: vi.fn(async () => compositionWith(timeline)),
      findReadableFiles: vi.fn(async () => new Map([[FILE_A, 'video/mp4']])),
    });
    expect(await run(deps)).toMatchObject({ ok: true });
  });

  it.each(['image/svg+xml', 'image/heic', 'image/avif'])(
    'refuses a %s image clip as invalid_timeline before any credit hold',
    async mimeType => {
      const { deps } = setup({
        findReadableFiles: vi.fn(
          async () =>
            new Map([
              [FILE_A, 'video/mp4'],
              [FILE_B, mimeType],
            ])
        ),
      });
      expect(await run(deps)).toMatchObject({ ok: false, status: 422, code: 'invalid_timeline' });
      expect(holdCredits).not.toHaveBeenCalled();
    }
  );

  it('admits an image clip whose MIME type carries parameters and upper case', async () => {
    const { deps } = setup({
      findReadableFiles: vi.fn(
        async () =>
          new Map([
            [FILE_A, 'video/mp4'],
            [FILE_B, 'Image/PNG; charset=binary'],
          ])
      ),
    });
    expect(await run(deps)).toMatchObject({ ok: true });
  });

  it('refuses a clip file the user cannot read as input_file_not_found', async () => {
    const { deps } = setup({ findReadableFiles: vi.fn(async () => new Map([[FILE_A, 'video/mp4']])) });
    expect(await run(deps)).toMatchObject({ ok: false, status: 422, code: 'input_file_not_found' });
    expect(deps.findReadableFiles).toHaveBeenCalledWith([FILE_A, FILE_B], 'u1');
    expect(holdCredits).not.toHaveBeenCalled();
  });

  it.each([
    ['an unknown output id', ['out-wide', 'nope']],
    ['no output ids', []],
    ['more ids than an export allows', Array.from({ length: 9 }, (_, index) => `out-${index}`)],
  ])('refuses %s as invalid_outputs', async (_label, outputIds) => {
    const { deps } = setup();
    expect(await run(deps, outputIds)).toMatchObject({ ok: false, status: 422, code: 'invalid_outputs' });
    expect(holdCredits).not.toHaveBeenCalled();
  });

  it('refuses a full Files quota with the storage details, before holding credits', async () => {
    const storage = {
      errorCode: 'storage_limit_exceeded',
      used_bytes: 900,
      limit_bytes: 1000,
      requested_bytes: 200_000,
      owner: 'user',
    } as const;
    const { deps } = setup({ checkStorageFor: vi.fn(async () => storage) });
    expect(await run(deps)).toMatchObject({ ok: false, status: 400, code: 'storage_quota_exceeded', storage });
    expect(holdCredits).not.toHaveBeenCalled();
  });

  it('returns the earlier holds and refuses with 402 when a later hold is short of credits', async () => {
    vi.mocked(holdCredits)
      .mockImplementationOnce(async params => fakeHold(params))
      .mockRejectedValueOnce(insufficientCreditsError('You do not have enough credits'));
    const { deps, repository } = setup();
    expect(await run(deps)).toMatchObject({ ok: false, status: 402, code: 'insufficient_credits' });
    expect(releaseCreditHold).toHaveBeenCalledTimes(1);
    expect(releaseCreditHold).toHaveBeenCalledWith(
      expect.objectContaining({ reservedCredits: usdToCredits(0.16) }),
      deps.credits
    );
    expect(repository.jobs.size).toBe(0);
    expect(deps.enqueue).not.toHaveBeenCalled();
  });

  it('returns the holds already taken and rethrows when a hold fails for another reason', async () => {
    vi.mocked(holdCredits)
      .mockImplementationOnce(async params => fakeHold(params))
      .mockRejectedValueOnce(new Error('ledger down'));
    const { deps } = setup();
    await expect(run(deps)).rejects.toThrow('ledger down');
    expect(releaseCreditHold).toHaveBeenCalledTimes(1);
  });

  it('returns the holds that never reached a job when persisting a later job fails', async () => {
    const { deps, repository } = setup();
    const createJob = repository.createJob.bind(repository);
    vi.spyOn(repository, 'createJob')
      .mockImplementationOnce(createJob)
      .mockRejectedValueOnce(new Error('write failed'));
    await expect(run(deps)).rejects.toThrow('write failed');
    // The second job's hold (returned by the create path) and the third's (never attached to a job).
    expect(releaseCreditHold).toHaveBeenCalledTimes(2);
    expect(repository.jobs.size).toBe(1);
    expect(deps.enqueue).toHaveBeenCalledTimes(1);
  });

  it('fails the job and returns its hold, plus the unattached holds, when enqueue throws', async () => {
    const enqueue = vi
      .fn<CreateRenderJobsDeps['enqueue']>()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('SQS down'));
    const { deps, repository } = setup({ enqueue });
    await expect(run(deps)).rejects.toThrow('SQS down');
    const states = [...repository.jobs.values()].map(job => ({ state: job.state, error: job.error?.code }));
    expect(states).toEqual([
      { state: 'pending', error: undefined },
      { state: 'failed', error: 'enqueue_failed' },
    ]);
    expect(releaseCreditHold).toHaveBeenCalledTimes(2);
  });

  it('logs a failed hold release without masking the refusal', async () => {
    vi.mocked(holdCredits)
      .mockImplementationOnce(async params => fakeHold(params))
      .mockRejectedValueOnce(insufficientCreditsError('short'));
    vi.mocked(releaseCreditHold).mockRejectedValueOnce(new Error('refund failed'));
    const { deps } = setup();
    const error = vi.spyOn(deps.logger, 'error');
    expect(await run(deps)).toMatchObject({ ok: false, code: 'insufficient_credits' });
    expect(error).toHaveBeenCalledWith(
      'render_job_create_hold_release_failed',
      expect.objectContaining({ ownerId: 'u1' })
    );
  });
});
