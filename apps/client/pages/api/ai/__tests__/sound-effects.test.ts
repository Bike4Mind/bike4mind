import { CreditHolderType, isZodError, SoundEffectGenerationSchema } from '@bike4mind/common';
import { createMocks } from 'node-mocks-http';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mocks } = vi.hoisted(() => ({
  mocks: {
    createSoundEffectJob: vi.fn(),
    runAudioJobInline: vi.fn(),
    requestAudioJobCancel: vi.fn(),
    readAudioJobOutput: vi.fn(),
    fabFileFindById: vi.fn(),
    upload: vi.fn(),
    getSignedUrl: vi.fn(),
    orgFindById: vi.fn(),
    orgFindAccessibleById: vi.fn(),
    generationJobFindById: vi.fn(),
  },
}));

// Contract-adapter mock: runs the contract's own request schema into `req.validated` (so body validation stays
// under test), then the handler. A thrown ZodError maps to 422 (mirroring the real errorHandler), any other thrown
// error to its statusCode or 500, with its additionalInfo spread into the body.
vi.mock('@server/middlewares/defineNextRoute', () => ({
  nextRouteForContract: (contract: { request: { parse: (body: unknown) => unknown } }) => ({
    post: (fn: (req: unknown, res: unknown) => unknown) => async (req: unknown, res: unknown) => {
      try {
        (req as { validated?: unknown }).validated = contract.request.parse((req as { body?: unknown }).body);
        return await fn(req, res);
      } catch (err) {
        const statusCode = (err as { statusCode?: number })?.statusCode;
        const status = isZodError(err) ? 422 : typeof statusCode === 'number' ? statusCode : 500;
        (res as { status: (n: number) => { json: (b: unknown) => void } })
          .status(status)
          .json({ error: (err as Error)?.message, ...(err as { additionalInfo?: object }).additionalInfo });
      }
    },
  }),
}));

const createSoundEffectJobDeps = { sentinel: 'createSoundEffectJobDeps' };
vi.mock('@bike4mind/services/audioJobs', () => ({
  createSoundEffectJob: (...a: unknown[]) => mocks.createSoundEffectJob(...a),
  inlineMinStepMs: (kind: string) => (kind === 'speech' ? 40_000 : 39_000),
}));
vi.mock('@bike4mind/server-utils/generationJobs/audioJobWiring', () => ({
  getCreateSoundEffectJobDeps: () => createSoundEffectJobDeps,
  runAudioJobInline: (...a: unknown[]) => mocks.runAudioJobInline(...a),
  requestAudioJobCancel: (...a: unknown[]) => mocks.requestAudioJobCancel(...a),
  readAudioJobOutput: (...a: unknown[]) => mocks.readAudioJobOutput(...a),
}));
vi.mock('@bike4mind/database', () => ({
  fabFileRepository: { findById: (...a: unknown[]) => mocks.fabFileFindById(...a) },
  generationJobRepository: { findById: (...a: unknown[]) => mocks.generationJobFindById(...a) },
  organizationRepository: {
    findById: (...a: unknown[]) => mocks.orgFindById(...a),
    shareable: { findAccessibleById: (...a: unknown[]) => mocks.orgFindAccessibleById(...a) },
  },
}));
// Real membership predicate and busy error: the billing resolver and the 429 mapping use them.
vi.mock('@bike4mind/services', async () => {
  const services = await vi.importActual<typeof import('@bike4mind/services')>('@bike4mind/services');
  return {
    organizationService: { isCurrentOrgMember: services.organizationService.isCurrentOrgMember },
    ProviderBusyError: services.ProviderBusyError,
  };
});
// Only the oversized-audio offload touches storage; the delivery module itself is real.
vi.mock('@bike4mind/server-utils/utils/storage/index', () => ({
  getFilesStorage: () => ({
    upload: (...a: unknown[]) => mocks.upload(...a),
    getSignedUrl: (...a: unknown[]) => mocks.getSignedUrl(...a),
  }),
}));

vi.mock('@server/generations/routeDeps', () => ({
  mapperDeps: { sign: vi.fn(), now: () => new Date('2026-10-06T00:02:00Z') },
}));

import handler from '../sound-effects';

const AUDIO = Buffer.from('boom');

const run = (
  body: unknown,
  apiKeyInfo?: Record<string, unknown>,
  user: Record<string, unknown> = { id: 'u1', organizationId: null }
) => {
  const { req, res } = createMocks({ method: 'POST', body });
  const logger = { error: vi.fn(), warn: vi.fn() };
  Object.assign(req, { user, logger, ...(apiKeyInfo && { apiKeyInfo }) });
  return { res, logger, promise: (handler as unknown as (req: unknown, res: unknown) => Promise<void>)(req, res) };
};

const generatedOutput = { location: 'generated', s3Key: 'g/1.mp3', contentType: 'audio/mpeg', bytes: 4 };
const soundJob = (overrides: Record<string, unknown> = {}, payload: Record<string, unknown> = {}) => ({
  id: 'job-1',
  kind: 'sound_effect',
  state: 'succeeded',
  payload: {
    request: { text: 'door creak', provider: 'elevenlabs' },
    providerId: 'elevenlabs',
    saveToFiles: true,
    output: { location: 'files', s3Key: 'k/sfx-1.mp3', fileId: 'fab-1', contentType: 'audio/mpeg', bytes: 4 },
    ...payload,
  },
  ...overrides,
});

const created = { ok: true, job: { id: 'job-1' }, created: true };
const refusal = (status: number, code: string, message: string, extra: Record<string, unknown> = {}) => ({
  ok: false,
  status,
  code,
  message,
  ...extra,
});
const createInput = (call = 0) => mocks.createSoundEffectJob.mock.calls[call][0];

beforeEach(() => {
  Object.values(mocks).forEach(m => m.mockReset());
  mocks.createSoundEffectJob.mockResolvedValue(created);
  mocks.runAudioJobInline.mockResolvedValue(soundJob());
  mocks.readAudioJobOutput.mockResolvedValue(AUDIO);
  mocks.fabFileFindById.mockResolvedValue({ id: 'fab-1', fileName: 'sfx-1.mp3', fileUrl: 'https://s3/get' });
  mocks.upload.mockResolvedValue(undefined);
  mocks.getSignedUrl.mockResolvedValue('https://s3/offload');
  mocks.orgFindById.mockImplementation(async (id: string) => ({ id, users: [{ userId: 'u1' }] }));
  mocks.orgFindAccessibleById.mockImplementation(async (_user: unknown, id: string) => ({ id }));
});

describe('POST /api/ai/sound-effects', () => {
  it('creates a sound-effect job with the request, then returns the binary clip with the save headers', async () => {
    const { res, promise } = run({ text: 'door creak', durationSeconds: 3, promptInfluence: 0 });
    await promise;

    expect(mocks.createSoundEffectJob).toHaveBeenCalledWith(
      {
        user: { id: 'u1', organizationId: null, adminRoleWithheld: false },
        request: expect.objectContaining({
          provider: 'elevenlabs',
          text: 'door creak',
          durationSeconds: 3,
          promptInfluence: 0,
        }),
        source: 'studio',
        apiKeyId: undefined,
        saveToFiles: true,
        usageSource: 'api',
      },
      createSoundEffectJobDeps
    );
    expect(mocks.runAudioJobInline).toHaveBeenCalledWith('job-1', {
      timeoutMs: expect.any(Number),
      minStepMs: 39_000,
      stepReserveMs: 11_000,
    });
    expect(res._getStatusCode()).toBe(200);
    expect(res._getData()).toEqual(AUDIO);
    expect(res.getHeader('X-B4M-Audio-Saved')).toBe('true');
    expect(res.getHeader('X-B4M-Audio-Fab-File-Id')).toBe('fab-1');
    expect(res.getHeader('X-B4M-Audio-File-Name')).toBe('sfx-1.mp3');
    expect(res.getHeader('X-B4M-Audio-File-Url')).toBe('https://s3/get');
  });

  it('returns base64 JSON with the audio and save fields for encoding: base64', async () => {
    const { res, promise } = run({ text: 'door creak', encoding: 'base64' });
    await promise;
    expect(res._getJSONData()).toMatchObject({
      delivery: 'inline',
      audio: AUDIO.toString('base64'),
      contentType: 'audio/mpeg',
      saved: true,
      fabFileId: 'fab-1',
    });
  });

  it('marks an API-key call as source api and passes its key id', async () => {
    const { promise } = run({ text: 'door creak' }, { keyId: 'key-1', scopes: ['ai:generate'] });
    await promise;
    expect(createInput()).toMatchObject({ source: 'api', apiKeyId: 'key-1', user: { adminRoleWithheld: true } });
  });

  it.each([
    ['b4m-cli/1.2.0', 'cli'],
    ['b4m-desktop/0.9.1', 'desktop'],
    ['curl/8.0', 'api'],
  ])('stamps the client a %s request came from as the usage source (%s)', async (userAgent, usageSource) => {
    const { req, res } = createMocks({
      method: 'POST',
      body: { text: 'door creak' },
      headers: { 'user-agent': userAgent },
    });
    Object.assign(req, { user: { id: 'u1', organizationId: null }, logger: { error: vi.fn(), warn: vi.fn() } });
    await (handler as unknown as (req: unknown, res: unknown) => Promise<void>)(req, res);
    expect(createInput()).toMatchObject({ usageSource });
  });

  it('skips persistence for a throwaway preview', async () => {
    mocks.runAudioJobInline.mockResolvedValue(soundJob({}, { saveToFiles: false, output: generatedOutput }));
    const { res, promise } = run({ text: 'door creak', preview: true });
    await promise;
    expect(createInput().saveToFiles).toBe(false);
    expect(res.getHeader('X-B4M-Audio-Saved')).toBeUndefined();
  });

  it('reports not-saved when the Files write fell back to the generated bucket', async () => {
    mocks.runAudioJobInline.mockResolvedValue(soundJob({}, { output: generatedOutput }));
    const { res, promise } = run({ text: 'door creak' });
    await promise;
    expect(res.getHeader('X-B4M-Audio-Saved')).toBe('false');
    expect(res.getHeader('X-B4M-Audio-Fab-File-Id')).toBeUndefined();
  });

  it('retries without the saved copy when the Files quota is full, and reports the save as skipped', async () => {
    mocks.createSoundEffectJob
      .mockResolvedValueOnce(
        refusal(400, 'storage_quota_exceeded', 'full', { storage: { errorCode: 'file_too_large' } })
      )
      .mockResolvedValueOnce(created);
    mocks.runAudioJobInline.mockResolvedValue(soundJob({}, { saveToFiles: false, output: generatedOutput }));
    const { res, promise } = run({ text: 'door creak', encoding: 'base64' });
    await promise;
    expect(createInput(0).saveToFiles).toBe(true);
    expect(createInput(1).saveToFiles).toBe(false);
    expect(res._getStatusCode()).toBe(200);
    expect(res._getJSONData()).toMatchObject({ saved: false, saveSkippedReason: 'file_too_large' });
  });

  it('rejects an invalid body (422) without creating a job', async () => {
    const { res, promise } = run({ text: '' });
    await promise;
    expect(res._getStatusCode()).toBe(422);
    expect(mocks.createSoundEffectJob).not.toHaveBeenCalled();
  });

  it('rejects a 451-character prompt (422) and accepts a 450-character one', async () => {
    const tooLong = run({ text: 'x'.repeat(451) });
    await tooLong.promise;
    expect(tooLong.res._getStatusCode()).toBe(422);
    expect(mocks.createSoundEffectJob).not.toHaveBeenCalled();

    const atLimit = run({ text: 'x'.repeat(450) });
    await atLimit.promise;
    expect(atLimit.res._getStatusCode()).toBe(200);
  });

  it('maps an invalid_request refusal (an unsupported format) to 422', async () => {
    mocks.createSoundEffectJob.mockResolvedValue(refusal(422, 'invalid_request', "does not support 'alaw_8000'"));
    const { res, promise } = run({ text: 'door creak', format: 'alaw_8000' });
    await promise;
    expect(res._getStatusCode()).toBe(422);
    expect(mocks.runAudioJobInline).not.toHaveBeenCalled();
  });

  it('returns a classified 422 and never runs a job when credits are exhausted', async () => {
    mocks.createSoundEffectJob.mockResolvedValue(refusal(402, 'insufficient_credits', 'broke'));
    const { res, promise } = run({ text: 'door creak' });
    await promise;
    expect(res._getStatusCode()).toBe(422);
    expect(res._getJSONData()).toMatchObject({ error: 'broke', errorCode: 'insufficient_credits' });
    expect(mocks.runAudioJobInline).not.toHaveBeenCalled();
  });

  it('returns 503 (not 401) when no provider key resolves', async () => {
    mocks.createSoundEffectJob.mockResolvedValue(refusal(422, 'model_unavailable', 'No elevenlabs API key configured'));
    const { res, promise } = run({ text: 'door creak' });
    await promise;
    expect(res._getStatusCode()).toBe(503);
    expect(res._getJSONData()).toEqual({ error: 'No elevenlabs API key configured' });
  });

  it.each([
    ['blocked', { state: 'blocked', error: { code: 'content_blocked', message: 'x' } }],
    [
      'failed',
      {
        state: 'failed',
        error: { code: 'provider_error', message: 'elevenlabs_http_400', providerStatus: 400 },
      },
    ],
    ['credential-rejected', { state: 'failed', error: { code: 'provider_error', message: 'x', providerStatus: 401 } }],
    ['cancelled', { state: 'cancelled' }],
  ])('maps a %s job to 502 with a generic body', async (_label, overrides) => {
    mocks.runAudioJobInline.mockResolvedValue(soundJob(overrides));
    const { res, logger, promise } = run({ text: 'door creak' });
    await promise;
    expect(res._getStatusCode()).toBe(502);
    expect(res._getJSONData()).toEqual({ error: 'Sound generation failed' });
    expect(logger.error).toHaveBeenCalled();
  });

  it('maps a rate-limited job to the provider-busy 429 with the Retry-After the job recorded', async () => {
    mocks.runAudioJobInline.mockResolvedValue(
      soundJob({
        state: 'failed',
        error: {
          code: 'provider_error',
          message: 'elevenlabs is at capacity (slots_exhausted); retry in 5s',
          providerStatus: 429,
          retryAfterSeconds: 5,
        },
      })
    );
    const { res, promise } = run({ text: 'door creak' });
    await promise;
    expect(res._getStatusCode()).toBe(429);
    expect(res._getJSONData()).toEqual({
      error: 'The generation service is busy. Please try again in a moment.',
      retryAfter: 5,
    });
  });

  it('refuses a free-tier user past the daily cap with a classified 429, before running a job', async () => {
    mocks.createSoundEffectJob.mockResolvedValue(
      refusal(429, 'daily_limit_reached', 'Daily free-tier credit limit reached. Try again tomorrow.', {
        retryAfterSeconds: 3_600,
      })
    );
    const { res, promise } = run({ text: 'door creak' });
    await promise;
    expect(res._getStatusCode()).toBe(429);
    expect(res._getJSONData()).toEqual({
      error: 'Daily free-tier credit limit reached. Try again tomorrow.',
      errorCode: 'daily_free_limit_reached',
      retryAfter: 3_600,
    });
    expect(mocks.runAudioJobInline).not.toHaveBeenCalled();
  });

  it('answers 202 with the job resource when the job does not finish in time', async () => {
    mocks.runAudioJobInline.mockResolvedValue(null);
    mocks.generationJobFindById.mockResolvedValue(
      soundJob(
        {
          state: 'running',
          source: 'studio',
          createdAt: new Date('2026-10-06T00:00:00Z'),
          updatedAt: new Date('2026-10-06T00:01:00Z'),
        },
        { output: undefined }
      )
    );
    const { res, logger, promise } = run({ text: 'door creak' });
    await promise;
    expect(res._getStatusCode()).toBe(202);
    const body = SoundEffectGenerationSchema.parse(res._getJSONData());
    expect(body).toMatchObject({ id: 'job-1', state: 'running', text: 'door creak', output: null, error: null });
    expect(mocks.generationJobFindById).toHaveBeenCalledWith('job-1');
    expect(mocks.readAudioJobOutput).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('background'),
      expect.objectContaining({ jobId: 'job-1' })
    );
  });

  it('waits only for what the request has left since it arrived, keeping time to deliver', async () => {
    const { req, res } = createMocks({ method: 'POST', body: { text: 'door creak' } });
    Object.assign(req, {
      user: { id: 'u1' },
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      receivedAt: new Date(Date.now() - 10_000),
    });
    await (handler as unknown as (req: unknown, res: unknown) => Promise<void>)(req, res);
    const { timeoutMs } = mocks.runAudioJobInline.mock.calls[0][1];
    // 58s from arrival, less 3s to read the clip back and answer, less the 10s already gone.
    expect(timeoutMs).toBeGreaterThan(44_000);
    expect(timeoutMs).toBeLessThanOrEqual(45_000);
  });

  it('delivers a job that ended just after the inline wait gave up on it, instead of answering 202', async () => {
    mocks.runAudioJobInline.mockResolvedValue(null);
    mocks.generationJobFindById.mockResolvedValue(soundJob());
    const { res, promise } = run({ text: 'door creak' });
    await promise;
    expect(res._getStatusCode()).toBe(200);
    expect(res._getData()).toEqual(AUDIO);
    expect(mocks.requestAudioJobCancel).not.toHaveBeenCalled();
  });

  it('maps a job that failed just after the inline wait gave up on it as a failure, not 202', async () => {
    mocks.runAudioJobInline.mockResolvedValue(null);
    mocks.generationJobFindById.mockResolvedValue(
      soundJob({ state: 'failed', error: { code: 'orphaned_submit', message: 'timeout' } })
    );
    const { res, promise } = run({ text: 'door creak' });
    await promise;
    expect(res._getStatusCode()).toBe(502);
  });

  describe('a clip that outlasts the request and is not saved to Files', () => {
    const unsaved = () => soundJob({ state: 'pending' }, { saveToFiles: false, output: undefined });

    beforeEach(() => {
      mocks.runAudioJobInline.mockResolvedValue(null);
      mocks.generationJobFindById.mockResolvedValue(unsaved());
    });

    it.each(['requested', 'not_cancellable'] as const)(
      'cancels the job (%s) and answers 504 rather than a 202 nothing could follow up',
      async status => {
        mocks.requestAudioJobCancel.mockResolvedValue({ status, job: unsaved() });
        const { res, logger, promise } = run({ ...{ text: 'door creak' }, preview: true });
        await promise;
        expect(mocks.requestAudioJobCancel).toHaveBeenCalledWith(expect.objectContaining({ id: 'job-1' }));
        expect(res._getStatusCode()).toBe(504);
        expect(res._getJSONData()).toEqual({ error: 'Sound generation took too long', errorCode: 'request_timeout' });
        expect(logger.warn).toHaveBeenCalledWith(
          expect.stringContaining('not saved to Files'),
          expect.objectContaining({ jobId: 'job-1', cancel: status })
        );
      }
    );

    it('delivers the clip when the cancel finds the job already ended', async () => {
      mocks.requestAudioJobCancel.mockResolvedValue({
        status: 'unchanged',
        job: soundJob(
          {},
          {
            saveToFiles: false,
            output: { location: 'generated', s3Key: 'g/1.mp3', contentType: 'audio/mpeg', bytes: 3 },
          }
        ),
      });
      const { res, promise } = run({ ...{ text: 'door creak' }, preview: true });
      await promise;
      expect(res._getStatusCode()).toBe(200);
      expect(res._getData()).toEqual(AUDIO);
    });
  });

  it('answers 502 when the job vanished during the inline wait', async () => {
    mocks.runAudioJobInline.mockResolvedValue(null);
    mocks.generationJobFindById.mockResolvedValue(null);
    const { res, logger, promise } = run({ text: 'door creak' });
    await promise;
    expect(res._getStatusCode()).toBe(502);
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining('vanished'),
      expect.objectContaining({ jobId: 'job-1' })
    );
  });

  describe('billing account', () => {
    it('bills the home org seat of a browser/JWT member when the field is omitted', async () => {
      const { promise } = run({ text: 'door creak' }, undefined, { id: 'u1', organizationId: 'homeOrg' });
      await promise;
      expect(createInput().user.organizationId).toBe('homeOrg');
    });

    it('bills the personal balance when the switcher is on Personal', async () => {
      const { promise } = run({ text: 'door creak', organization_id: null }, undefined, {
        id: 'u1',
        organizationId: 'homeOrg',
      });
      await promise;
      expect(createInput().user.organizationId).toBeNull();
    });

    it('refuses (403) an organization the caller does not belong to, before creating a job', async () => {
      mocks.orgFindAccessibleById.mockResolvedValue(null);
      const { res, promise } = run({ text: 'door creak', organization_id: 'otherOrg' });
      await promise;
      expect(res._getStatusCode()).toBe(403);
      expect(mocks.createSoundEffectJob).not.toHaveBeenCalled();
    });

    it('bills an org-billed API key to its own organization', async () => {
      const { promise } = run(
        { text: 'door creak' },
        {
          billingOwnerType: CreditHolderType.Organization,
          organizationId: 'keyOrg',
          scopes: [],
        }
      );
      await promise;
      expect(createInput().user.organizationId).toBe('keyOrg');
    });

    it('bills the user for a user-billed API key, ignoring the org seat', async () => {
      const { promise } = run(
        { text: 'door creak' },
        { billingOwnerType: CreditHolderType.User, scopes: [] },
        {
          id: 'u1',
          organizationId: 'homeOrg',
        }
      );
      await promise;
      expect(createInput().user.organizationId).toBeNull();
    });
  });

  describe('generated-audio delivery', () => {
    const oversizedAudio = Buffer.alloc(4 * 1024 * 1024 + 1);

    beforeEach(() => {
      mocks.readAudioJobOutput.mockResolvedValue(oversizedAudio);
    });

    it('serves an oversized base64 result by the saved copy URL without offloading', async () => {
      const { res, promise } = run({ text: 'door creak', encoding: 'base64' });
      await promise;
      expect(res._getJSONData()).toMatchObject({ delivery: 'url', url: 'https://s3/get' });
      expect(mocks.upload).not.toHaveBeenCalled();
    });

    it('redirects an unsaved oversized binary result with a 303 to an offloaded URL', async () => {
      mocks.runAudioJobInline.mockResolvedValue(soundJob({}, { saveToFiles: false, output: generatedOutput }));
      const { res, promise } = run({ text: 'door creak', preview: true });
      await promise;
      expect(res._getStatusCode()).toBe(303);
      expect(res._getRedirectUrl()).toBe('https://s3/offload');
    });
  });
});
