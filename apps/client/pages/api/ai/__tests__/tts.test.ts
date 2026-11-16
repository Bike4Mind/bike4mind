import { describe, it, expect, vi, beforeEach } from 'vitest';
import { CreditHolderType, isZodError, SpeechGenerationSchema } from '@bike4mind/common';
import { createMocks } from 'node-mocks-http';

const { mocks } = vi.hoisted(() => ({
  mocks: {
    createSpeechJob: vi.fn(),
    runAudioJobInline: vi.fn(),
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
// error to its statusCode or 500.
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

const createSpeechJobDeps = { sentinel: 'createSpeechJobDeps' };
vi.mock('@bike4mind/services/audioJobs', () => ({
  createSpeechJob: (...a: unknown[]) => mocks.createSpeechJob(...a),
  inlineMinStepMs: (kind: string) => (kind === 'speech' ? 40_000 : 45_000),
}));
vi.mock('@bike4mind/server-utils/generationJobs/audioJobWiring', () => ({
  getCreateSpeechJobDeps: () => createSpeechJobDeps,
  runAudioJobInline: (...a: unknown[]) => mocks.runAudioJobInline(...a),
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
// Real membership predicate: the billing resolver's roster re-check is what the billing tests exercise.
vi.mock('@bike4mind/services', async () => {
  const services = await vi.importActual<typeof import('@bike4mind/services')>('@bike4mind/services');
  return { organizationService: { isCurrentOrgMember: services.organizationService.isCurrentOrgMember } };
});
// Only the oversized-audio offload touches storage; the delivery module itself is real.
vi.mock('@bike4mind/server-utils/utils/storage/index', () => ({
  getFilesStorage: () => ({
    upload: (...a: unknown[]) => mocks.upload(...a),
    getSignedUrl: (...a: unknown[]) => mocks.getSignedUrl(...a),
  }),
}));

import { AI_ACCESS_REVOKED_MESSAGE } from '@bike4mind/services/userService/accountState';
import { GENERATED_AUDIO_TOO_LARGE_MESSAGE } from '@server/utils/generatedAudioDelivery';
vi.mock('@server/generations/routeDeps', () => ({
  mapperDeps: { sign: vi.fn(), now: () => new Date('2026-10-06T00:02:00Z') },
}));

import { AUDIO_JOB_INLINE_TIMEOUT_MS } from '@server/generations/syncAudioJob';
import handler from '../tts';

const AUDIO = Buffer.from([1, 2, 3]);

const run = (
  body: Record<string, unknown>,
  user: Record<string, unknown> | undefined = { id: 'u1' },
  apiKeyInfo?: Record<string, unknown>
) => {
  const { req, res } = createMocks({ method: 'POST', body });
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  Object.assign(req, { user, logger, ...(apiKeyInfo && { apiKeyInfo }) });
  return { res, logger, promise: (handler as unknown as (req: unknown, res: unknown) => Promise<void>)(req, res) };
};

const speechJob = (overrides: Record<string, unknown> = {}, payload: Record<string, unknown> = {}) => ({
  id: 'job-1',
  kind: 'speech',
  state: 'succeeded',
  payload: {
    request: { text: 'hi', provider: 'openai' },
    candidates: ['openai'],
    saveToFiles: true,
    producedBy: { provider: 'openai', model: 'tts-1' },
    output: { location: 'files', s3Key: 'k/speech-1.mp3', fileId: 'fab-1', contentType: 'audio/mpeg', bytes: 3 },
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
const createInput = (call = 0) => mocks.createSpeechJob.mock.calls[call][0];

beforeEach(() => {
  Object.values(mocks).forEach(m => m.mockReset());
  mocks.createSpeechJob.mockResolvedValue(created);
  mocks.runAudioJobInline.mockResolvedValue(speechJob());
  mocks.readAudioJobOutput.mockResolvedValue(AUDIO);
  mocks.fabFileFindById.mockResolvedValue({ id: 'fab-1', fileName: 'speech-1.mp3', fileUrl: 'https://s3/get' });
  mocks.upload.mockResolvedValue(undefined);
  mocks.getSignedUrl.mockResolvedValue('https://s3/offload');
  // Billing fixtures: every named org exists and every caller belongs to the one they name.
  mocks.orgFindById.mockImplementation(async (id: string) => ({ id, users: [{ userId: 'u1' }] }));
  mocks.orgFindAccessibleById.mockImplementation(async (_user: unknown, id: string) => ({ id }));
});

describe('POST /api/ai/tts', () => {
  it('creates a speech job with the request, then returns the binary clip with the save headers', async () => {
    const { res, promise } = run({ text: 'hi', voice: 'nova', format: 'mp3' }, { id: 'u1', preferredVoice: 'echo' });
    await promise;

    expect(mocks.createSpeechJob).toHaveBeenCalledWith(
      {
        user: { id: 'u1', organizationId: null, adminRoleWithheld: false },
        request: expect.objectContaining({ text: 'hi', provider: 'openai', voice: 'nova', format: 'mp3' }),
        source: 'studio',
        apiKeyId: undefined,
        saveToFiles: true,
        preferredVoice: 'echo',
      },
      createSpeechJobDeps
    );
    expect(mocks.runAudioJobInline).toHaveBeenCalledWith('job-1', {
      timeoutMs: AUDIO_JOB_INLINE_TIMEOUT_MS,
      minStepMs: 40_000,
    });
    expect(res._getStatusCode()).toBe(200);
    expect(res._getData()).toEqual(AUDIO);
    expect(res.getHeader('Content-Type')).toBe('audio/mpeg');
    expect(res.getHeader('X-B4M-Audio-Saved')).toBe('true');
    expect(res.getHeader('X-B4M-Audio-Fab-File-Id')).toBe('fab-1');
    expect(res.getHeader('X-B4M-Audio-File-Name')).toBe('speech-1.mp3');
    expect(res.getHeader('X-B4M-Audio-File-Url')).toBe('https://s3/get');
    expect(res.getHeader('X-B4M-Tts-Provider')).toBeUndefined();
  });

  it('returns base64 JSON with the format, save fields and no substitution fields', async () => {
    const { res, promise } = run({ text: 'hi', encoding: 'base64' });
    await promise;
    expect(res._getStatusCode()).toBe(200);
    const body = res._getJSONData();
    expect(body).toMatchObject({
      delivery: 'inline',
      audio: AUDIO.toString('base64'),
      contentType: 'audio/mpeg',
      format: 'mp3',
      saved: true,
      fabFileId: 'fab-1',
      fileName: 'speech-1.mp3',
    });
    expect(body).not.toHaveProperty('fallbackFrom');
  });

  it('marks an API-key call as source api and passes its key id and admin withholding', async () => {
    const { promise } = run({ text: 'hi' }, { id: 'u1' }, { keyId: 'key-1', scopes: ['ai:generate'] });
    await promise;
    expect(createInput()).toMatchObject({
      source: 'api',
      apiKeyId: 'key-1',
      user: { id: 'u1', organizationId: null, adminRoleWithheld: true },
    });
  });

  it('reports a substituted provider in the body and headers, with the alternate default format', async () => {
    mocks.runAudioJobInline.mockResolvedValue(
      speechJob({}, { producedBy: { provider: 'elevenlabs', model: 'eleven_multilingual_v2' } })
    );
    // wav is an OpenAI format ElevenLabs cannot produce, so the alternate fell back to its mp3 default.
    const { res, promise } = run({ text: 'hi', format: 'wav', encoding: 'base64' });
    await promise;
    expect(res.getHeader('X-B4M-Tts-Provider')).toBe('elevenlabs');
    expect(res.getHeader('X-B4M-Tts-Provider-Fallback-From')).toBe('openai');
    expect(res._getJSONData()).toMatchObject({ provider: 'elevenlabs', fallbackFrom: 'openai', format: 'mp3' });
  });

  it('keeps the requested format when the requested provider produced the clip', async () => {
    const { res, promise } = run({ text: 'hi', format: 'wav', encoding: 'base64' });
    await promise;
    expect(res._getJSONData()).toMatchObject({ format: 'wav' });
  });

  it('skips persistence for a throwaway preview: no save fields, no Files lookup', async () => {
    mocks.runAudioJobInline.mockResolvedValue(
      speechJob(
        {},
        { saveToFiles: false, output: { location: 'generated', s3Key: 'g/1.mp3', contentType: 'audio/mpeg', bytes: 3 } }
      )
    );
    const { res, promise } = run({ text: 'hi', preview: true });
    await promise;
    expect(createInput().saveToFiles).toBe(false);
    expect(res._getStatusCode()).toBe(200);
    expect(res.getHeader('X-B4M-Audio-Saved')).toBeUndefined();
    expect(mocks.fabFileFindById).not.toHaveBeenCalled();
  });

  it('reports the save as failed when the Files write fell back to the generated bucket', async () => {
    mocks.runAudioJobInline.mockResolvedValue(
      speechJob({}, { output: { location: 'generated', s3Key: 'g/1.mp3', contentType: 'audio/mpeg', bytes: 3 } })
    );
    const { res, promise } = run({ text: 'hi', encoding: 'base64' });
    await promise;
    expect(res._getJSONData()).toMatchObject({ saved: false, saveSkippedReason: 'error' });
  });

  it('retries without the saved copy when the Files quota is full, and reports the save as skipped', async () => {
    mocks.createSpeechJob
      .mockResolvedValueOnce(
        refusal(400, 'storage_quota_exceeded', 'full', { storage: { errorCode: 'storage_limit_exceeded' } })
      )
      .mockResolvedValueOnce(created);
    mocks.runAudioJobInline.mockResolvedValue(
      speechJob(
        {},
        { saveToFiles: false, output: { location: 'generated', s3Key: 'g/1.mp3', contentType: 'audio/mpeg', bytes: 3 } }
      )
    );
    const { res, promise } = run({ text: 'hi', encoding: 'base64' });
    await promise;
    expect(mocks.createSpeechJob).toHaveBeenCalledTimes(2);
    expect(createInput(0).saveToFiles).toBe(true);
    expect(createInput(1).saveToFiles).toBe(false);
    expect(res._getStatusCode()).toBe(200);
    expect(res._getJSONData()).toMatchObject({ saved: false, saveSkippedReason: 'storage_limit' });
  });

  it('rejects a moderated user with 403 before creating a job', async () => {
    const { res, promise } = run({ text: 'hi' }, { id: 'u1', isModerated: true });
    await promise;
    expect(res._getStatusCode()).toBe(403);
    expect(res._getJSONData()).toMatchObject({ error: AI_ACCESS_REVOKED_MESSAGE });
    expect(mocks.createSpeechJob).not.toHaveBeenCalled();
  });

  it('maps an invalid_request refusal (e.g. an unsupported format) to 422', async () => {
    mocks.createSpeechJob.mockResolvedValue(
      refusal(422, 'invalid_request', "The elevenlabs provider does not support 'wav'")
    );
    const { res, promise } = run({ text: 'hi', provider: 'elevenlabs', format: 'wav' });
    await promise;
    expect(res._getStatusCode()).toBe(422);
    expect(mocks.runAudioJobInline).not.toHaveBeenCalled();
  });

  it('returns 401 with an actionable code when no provider is configured', async () => {
    mocks.createSpeechJob.mockResolvedValue(
      refusal(422, 'model_unavailable', 'No text-to-speech provider is configured')
    );
    const { res, promise } = run({ text: 'hi' });
    await promise;
    expect(res._getStatusCode()).toBe(401);
    expect(res._getJSONData()).toEqual({
      error: 'No text-to-speech provider is configured',
      errorCode: 'provider_not_configured',
    });
  });

  // The classifier is the load-bearing half: this 422 shares its status with an ordinary validation failure.
  it('returns a classified 422 and never runs a job when credits are exhausted', async () => {
    mocks.createSpeechJob.mockResolvedValue(refusal(402, 'insufficient_credits', 'broke'));
    const { res, promise } = run({ text: 'hi' });
    await promise;
    expect(res._getStatusCode()).toBe(422);
    expect(res._getJSONData()).toEqual({ error: 'broke', provider: 'openai', errorCode: 'insufficient_credits' });
    expect(mocks.runAudioJobInline).not.toHaveBeenCalled();
  });

  it('maps a blocked job to a generic 422', async () => {
    mocks.runAudioJobInline.mockResolvedValue(speechJob({ state: 'blocked', error: { code: 'content_blocked' } }));
    const { res, promise } = run({ text: 'hi', provider: 'elevenlabs' });
    await promise;
    expect(res._getStatusCode()).toBe(422);
    expect(res._getJSONData()).toEqual({
      error: 'TTS request rejected by the elevenlabs provider',
      provider: 'elevenlabs',
    });
  });

  it('refuses a free-tier user past the daily cap with a classified 429 and Retry-After, before running a job', async () => {
    mocks.createSpeechJob.mockResolvedValue(
      refusal(429, 'daily_limit_reached', 'Daily free-tier credit limit reached. Try again tomorrow.', {
        retryAfterSeconds: 3_600,
      })
    );
    const { res, promise } = run({ text: 'hi' });
    await promise;
    expect(res._getStatusCode()).toBe(429);
    expect(res._getJSONData()).toEqual({
      error: 'Daily free-tier credit limit reached. Try again tomorrow.',
      errorCode: 'daily_free_limit_reached',
      retryAfter: 3_600,
    });
    expect(mocks.runAudioJobInline).not.toHaveBeenCalled();
  });

  // The job's error carries the status: rawProviderError is never read back from the database.
  it.each([401, 403])('flags a %i credential rejection as provider_rejected (401)', async status => {
    mocks.runAudioJobInline.mockResolvedValue(
      speechJob({ state: 'failed', error: { code: 'provider_error', message: 'x', providerStatus: status } })
    );
    const { res, promise } = run({ text: 'hi' });
    await promise;
    expect(res._getStatusCode()).toBe(401);
    expect(res._getJSONData()).toEqual({
      error: 'TTS request rejected by the openai provider',
      provider: 'openai',
      errorCode: 'provider_rejected',
    });
  });

  it('passes a provider rate limit through as 429 with the Retry-After the job recorded', async () => {
    mocks.runAudioJobInline.mockResolvedValue(
      speechJob({
        state: 'failed',
        error: { code: 'provider_error', message: 'openai_rate_limited', providerStatus: 429, retryAfterSeconds: 12 },
      })
    );
    const { res, promise } = run({ text: 'hi' });
    await promise;
    expect(res._getStatusCode()).toBe(429);
    expect(res.getHeader('Retry-After')).toBe('12');
    expect(res._getJSONData()).toEqual({ error: 'TTS request rejected by the openai provider', provider: 'openai' });
  });

  it('no longer reads a rate limit from the error message alone', async () => {
    mocks.runAudioJobInline.mockResolvedValue(
      speechJob({ state: 'failed', error: { code: 'provider_error', message: 'openai_rate_limited' } })
    );
    const { res, promise } = run({ text: 'hi' });
    await promise;
    expect(res._getStatusCode()).toBe(502);
  });

  it('maps another provider 4xx to a generic 422 without leaking the provider text', async () => {
    mocks.runAudioJobInline.mockResolvedValue(
      speechJob({
        state: 'failed',
        error: { code: 'provider_error', message: 'openai_http_400', providerStatus: 400 },
        rawProviderError: { status: 400, snippet: 'raw provider detail' },
      })
    );
    const { res, promise } = run({ text: 'hi' });
    await promise;
    expect(res._getStatusCode()).toBe(422);
    expect(JSON.stringify(res._getJSONData())).not.toContain('raw provider detail');
  });

  it.each([
    ['failed (orphaned)', { state: 'failed', error: { code: 'orphaned_submit', message: 'timeout' } }],
    ['cancelled', { state: 'cancelled' }],
  ])('maps a %s job to 502', async (_label, overrides) => {
    mocks.runAudioJobInline.mockResolvedValue(speechJob(overrides));
    const { res, logger, promise } = run({ text: 'hi' });
    await promise;
    expect(res._getStatusCode()).toBe(502);
    expect(res._getJSONData()).toEqual({ error: 'Failed to generate speech', provider: 'openai' });
    expect(logger.error).toHaveBeenCalled();
  });

  it('answers 202 with the job resource when the job does not finish in time', async () => {
    mocks.runAudioJobInline.mockResolvedValue(null);
    mocks.generationJobFindById.mockResolvedValue(
      speechJob(
        {
          state: 'running',
          source: 'studio',
          createdAt: new Date('2026-10-06T00:00:00Z'),
          updatedAt: new Date('2026-10-06T00:01:00Z'),
        },
        { output: undefined }
      )
    );
    const { res, logger, promise } = run({ text: 'hi' });
    await promise;
    expect(res._getStatusCode()).toBe(202);
    const body = SpeechGenerationSchema.parse(res._getJSONData());
    expect(body).toMatchObject({ id: 'job-1', state: 'running', text: 'hi', output: null, error: null });
    expect(mocks.generationJobFindById).toHaveBeenCalledWith('job-1');
    expect(mocks.readAudioJobOutput).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('background'),
      expect.objectContaining({ jobId: 'job-1' })
    );
  });

  it('answers 502 when the job vanished during the inline wait', async () => {
    mocks.runAudioJobInline.mockResolvedValue(null);
    mocks.generationJobFindById.mockResolvedValue(null);
    const { res, logger, promise } = run({ text: 'hi' });
    await promise;
    expect(res._getStatusCode()).toBe(502);
    expect(res._getJSONData()).toEqual({ error: 'Failed to generate speech', provider: 'openai' });
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining('vanished'),
      expect.objectContaining({ jobId: 'job-1' })
    );
  });

  it('answers 502 when the stored clip cannot be read back', async () => {
    mocks.readAudioJobOutput.mockRejectedValue(new Error('s3 down'));
    const { res, promise } = run({ text: 'hi' });
    await promise;
    expect(res._getStatusCode()).toBe(502);
  });

  describe('billing account', () => {
    it('bills the organization the switcher selected', async () => {
      const { promise } = run({ text: 'hi', organization_id: 'teamOrg' });
      await promise;
      expect(createInput().user.organizationId).toBe('teamOrg');
    });

    it('bills personal credits when the field is omitted, even for an org member', async () => {
      const { promise } = run({ text: 'hi' }, { id: 'u1', organizationId: 'homeOrg' });
      await promise;
      expect(createInput().user.organizationId).toBeNull();
    });

    it('refuses (403) an organization the caller does not belong to, before creating a job', async () => {
      mocks.orgFindAccessibleById.mockResolvedValue(null);
      const { res, promise } = run({ text: 'hi', organization_id: 'otherOrg' });
      await promise;
      expect(res._getStatusCode()).toBe(403);
      expect(mocks.createSpeechJob).not.toHaveBeenCalled();
    });

    it('bills an org-billed API key to its own organization when the body names none', async () => {
      const { promise } = run(
        { text: 'hi' },
        { id: 'u1' },
        { billingOwnerType: CreditHolderType.Organization, organizationId: 'keyOrg', scopes: [] }
      );
      await promise;
      expect(createInput().user.organizationId).toBe('keyOrg');
    });

    it('bills a user-billed key to the user even when the user has an org seat', async () => {
      const { promise } = run(
        { text: 'hi' },
        { id: 'u1', organizationId: 'homeOrg' },
        { billingOwnerType: CreditHolderType.User, scopes: [] }
      );
      await promise;
      expect(createInput().user.organizationId).toBeNull();
    });
  });

  describe('audio over the response limit', () => {
    const oversizedAudio = Buffer.alloc(4 * 1024 * 1024 + 1);

    beforeEach(() => {
      mocks.readAudioJobOutput.mockResolvedValue(oversizedAudio);
    });

    it('serves the saved copy by URL for base64, without offloading', async () => {
      const { res, promise } = run({ text: 'hi', encoding: 'base64' });
      await promise;
      expect(res._getStatusCode()).toBe(200);
      expect(res._getJSONData()).toMatchObject({ delivery: 'url', url: 'https://s3/get', saved: true });
      expect(mocks.upload).not.toHaveBeenCalled();
    });

    it('returns a 413 with the provider when an unsaved clip cannot be offloaded', async () => {
      mocks.runAudioJobInline.mockResolvedValue(
        speechJob(
          {},
          {
            saveToFiles: false,
            output: { location: 'generated', s3Key: 'g/1.mp3', contentType: 'audio/mpeg', bytes: 3 },
          }
        )
      );
      mocks.upload.mockRejectedValue(new Error('s3 down'));
      const { res, promise } = run({ text: 'hi', preview: true, encoding: 'base64' });
      await promise;
      expect(res._getStatusCode()).toBe(413);
      expect(res._getJSONData()).toEqual({ error: GENERATED_AUDIO_TOO_LARGE_MESSAGE, provider: 'openai' });
    });
  });
});
