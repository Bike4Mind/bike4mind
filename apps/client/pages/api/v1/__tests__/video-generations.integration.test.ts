// @vitest-environment node
/**
 * Integration test for POST and GET /api/v1/video-generations through the real next-connect chain
 * (nextRouteForContract -> apiKeyAuth -> scope check -> validation -> handler). The domain (createVideoJob)
 * and the repository are mocked: their behaviour is covered in services and database.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiKeyScope } from '@bike4mind/common';
import {
  asUser,
  fire,
  h,
  JOB_ID,
  resetHarness,
  validateWithScopes,
  videoJob,
} from '@server/videoGenerations/__test__/routeHarness';

vi.mock('@server/utils/apiKeyRateLimitCheck', async orig =>
  (await import('@server/videoGenerations/__test__/routeHarness')).apiKeyRateLimitCheckMock(orig)
);
vi.mock('@server/middlewares/rateLimit', async () =>
  (await import('@server/videoGenerations/__test__/routeHarness')).rateLimitMiddlewareMock()
);
vi.mock('@server/utils/userRateTier', async () =>
  (await import('@server/videoGenerations/__test__/routeHarness')).userRateTierMock()
);
vi.mock('@server/utils/analyticsLog', () => ({ logEvent: vi.fn().mockResolvedValue(undefined) }));
vi.mock('@bike4mind/services', async orig =>
  (await import('@server/videoGenerations/__test__/routeHarness')).servicesMock(orig)
);
vi.mock('@bike4mind/services/videoJobs', async orig =>
  (await import('@server/videoGenerations/__test__/routeHarness')).videoJobsServiceMock(orig)
);
vi.mock('@bike4mind/database', async orig =>
  (await import('@server/videoGenerations/__test__/routeHarness')).databaseMock(orig)
);
vi.mock('@server/generationJobs/wiring', async () =>
  (await import('@server/videoGenerations/__test__/routeHarness')).wiringMock()
);
vi.mock('@server/videoGenerations/signOutputUrl', async () =>
  (await import('@server/videoGenerations/__test__/routeHarness')).signOutputUrlMock()
);
vi.mock('@server/videoGenerations/listUsableVideoModels', async orig =>
  (await import('@server/videoGenerations/__test__/routeHarness')).listUsableVideoModelsMock(orig)
);
vi.mock('@server/auth/auth', async orig =>
  (await import('@server/videoGenerations/__test__/routeHarness')).authMock(orig)
);

import handler from '../video-generations/index';

const post = (body: Record<string, unknown>, headers: Record<string, string> = {}) =>
  fire({ method: 'POST', url: '/api/v1/video-generations', body, headers });

describe('POST /api/v1/video-generations', () => {
  beforeEach(resetHarness);

  it('rejects a key lacking ai:generate (403) before creating a job', async () => {
    validateWithScopes([ApiKeyScope.READ_FILES]);
    const { req, res } = post({ model: 'gemini-omni-1.1-flash', prompt: 'a lighthouse' });
    await handler(req, res);
    expect(res._getStatusCode()).toBe(403);
    expect(res._getJSONData().error).toMatch(/insufficient/i);
    expect(h.createVideoJob).not.toHaveBeenCalled();
  });

  it('accepts a JWT caller and fills catalog defaults (202)', async () => {
    h.createVideoJob.mockResolvedValue({ ok: true, job: videoJob({ requestedBy: 'jwt-user' }), created: true });
    const { req, res } = fire({
      method: 'POST',
      url: '/api/v1/video-generations',
      apiKey: null,
      body: { model: 'gemini-omni-1.1-flash', prompt: 'a lighthouse' },
    });
    await handler(req, res);
    expect(res._getStatusCode()).toBe(202);
    expect(res._getJSONData()).toMatchObject({ id: JOB_ID, object: 'video_generation', state: 'pending' });
    expect(h.createVideoJob).toHaveBeenCalledWith(
      {
        user: { id: 'jwt-user', organizationId: null },
        source: 'api',
        request: {
          model: 'gemini-omni-1.1-flash',
          mode: 'text_to_video',
          prompt: 'a lighthouse',
          durationSeconds: 6,
          aspectRatio: '16:9',
          resolution: '720p',
        },
      },
      expect.anything()
    );
  });

  it('infers image_to_video from input_image_file_id', async () => {
    validateWithScopes([ApiKeyScope.AI_GENERATE]);
    h.createVideoJob.mockResolvedValue({ ok: true, job: videoJob(), created: true });
    const { req, res } = post({ model: 'gemini-omni-1.1-flash', prompt: 'p', input_image_file_id: 'f1' });
    await handler(req, res);
    expect(h.createVideoJob.mock.calls[0][0].request).toMatchObject({ mode: 'image_to_video', inputImageFileId: 'f1' });
  });

  it('namespaces the Idempotency-Key per user and returns 202 on replay', async () => {
    validateWithScopes([ApiKeyScope.AI_GENERATE]);
    h.createVideoJob.mockResolvedValue({ ok: true, job: videoJob(), created: false });
    const { req, res } = post({ model: 'gemini-omni-1.1-flash', prompt: 'p' }, { 'idempotency-key': 'retry-1' });
    await handler(req, res);
    expect(res._getStatusCode()).toBe(202);
    expect(h.createVideoJob.mock.calls[0][0].idempotencyKey).toBe('api:user-1:retry-1');
  });

  it('the same Idempotency-Key from two org members reaches the domain under different keys', async () => {
    validateWithScopes([ApiKeyScope.AI_GENERATE]);
    h.createVideoJob.mockResolvedValue({ ok: true, job: videoJob(), created: true });
    for (const userId of ['member-a', 'member-b']) {
      validateWithScopes([ApiKeyScope.AI_GENERATE], userId);
      asUser(userId, 'org-1');
      const { req, res } = post({ model: 'gemini-omni-1.1-flash', prompt: 'p' }, { 'idempotency-key': 'shared' });
      await handler(req, res);
      expect(res._getStatusCode()).toBe(202);
    }
    const keys = h.createVideoJob.mock.calls.map(call => call[0].idempotencyKey);
    expect(keys).toEqual(['api:member-a:shared', 'api:member-b:shared']);
    expect(h.createVideoJob.mock.calls.map(call => call[0].user)).toEqual([
      { id: 'member-a', organizationId: 'org-1' },
      { id: 'member-b', organizationId: 'org-1' },
    ]);
  });

  it.each(['', 'x'.repeat(256), 'bad\u0001key'])('rejects Idempotency-Key %j with 422', async key => {
    validateWithScopes([ApiKeyScope.AI_GENERATE]);
    const { req, res } = post({ model: 'gemini-omni-1.1-flash', prompt: 'p' }, { 'idempotency-key': key });
    await handler(req, res);
    expect(res._getStatusCode()).toBe(422);
    expect(res._getJSONData()).toMatchObject({ errorCode: 'invalid_idempotency_key' });
    expect(h.createVideoJob).not.toHaveBeenCalled();
  });

  it.each([
    [{ status: 422, code: 'unsupported_duration' }, 422],
    [{ status: 422, code: 'idempotency_key_reused' }, 422],
    [{ status: 422, code: 'model_unavailable' }, 422],
    [{ status: 402, code: 'insufficient_credits' }, 422],
    [{ status: 403, code: 'model_disabled' }, 422],
    [{ status: 400, code: 'invalid_request' }, 422],
    [{ status: 404, code: 'input_image_not_found' }, 404],
  ])('maps a %o refusal to HTTP %i with errorCode', async (refusal, expected) => {
    validateWithScopes([ApiKeyScope.AI_GENERATE]);
    h.createVideoJob.mockResolvedValue({ ok: false, message: 'refused', ...refusal });
    const { req, res } = post({ model: 'gemini-omni-1.1-flash', prompt: 'p' });
    await handler(req, res);
    expect(res._getStatusCode()).toBe(expected);
    expect(res._getJSONData()).toMatchObject({ errorCode: refusal.code });
  });

  it('refuses an unknown model and a model without a usable key as model_unavailable', async () => {
    validateWithScopes([ApiKeyScope.AI_GENERATE]);
    const unknown = post({ model: 'sora-2', prompt: 'p' });
    await handler(unknown.req, unknown.res);
    expect(unknown.res._getStatusCode()).toBe(422);
    expect(unknown.res._getJSONData()).toMatchObject({ errorCode: 'model_unavailable' });

    h.hasUsableKey.mockResolvedValue(false);
    const keyless = post({ model: 'gemini-omni-1.1-flash', prompt: 'p' });
    await handler(keyless.req, keyless.res);
    expect(keyless.res._getStatusCode()).toBe(422);
    expect(keyless.res._getJSONData()).toMatchObject({ errorCode: 'model_unavailable' });
    expect(h.createVideoJob).not.toHaveBeenCalled();
  });

  it('rejects a body without a prompt (422) before the domain', async () => {
    validateWithScopes([ApiKeyScope.AI_GENERATE]);
    const { req, res } = post({ model: 'gemini-omni-1.1-flash' });
    await handler(req, res);
    expect(res._getStatusCode()).toBe(422);
    expect(h.createVideoJob).not.toHaveBeenCalled();
  });

  it('ignores camelCase field names and applies the catalog default duration', async () => {
    validateWithScopes([ApiKeyScope.AI_GENERATE]);
    h.createVideoJob.mockResolvedValue({ ok: true, job: videoJob(), created: true });
    const { req, res } = post({ model: 'gemini-omni-1.1-flash', prompt: 'p', durationSeconds: 3 });
    await handler(req, res);
    expect(res._getStatusCode()).toBe(202);
    expect(h.createVideoJob.mock.calls[0][0].request).toMatchObject({ durationSeconds: 6 });
  });
});
