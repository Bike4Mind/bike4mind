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
vi.mock('@server/utils/orgAccess', async orig =>
  (await import('@server/videoGenerations/__test__/routeHarness')).orgAccessMock(orig)
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

  it('bills the org that resolveBillingOrgId returns', async () => {
    validateWithScopes([ApiKeyScope.AI_GENERATE]);
    h.resolveBillingOrgId.mockResolvedValue('billing-org');
    h.createVideoJob.mockResolvedValue({ ok: true, job: videoJob(), created: true });
    const { req, res } = post({ model: 'gemini-omni-1.1-flash', prompt: 'p' });
    await handler(req, res);
    expect(h.resolveBillingOrgId).toHaveBeenCalledWith(expect.anything(), undefined);
    expect(h.createVideoJob.mock.calls[0][0].user).toEqual({ id: 'user-1', organizationId: 'billing-org' });
  });

  it('falls back to personal billing when the org pointer is stale', async () => {
    validateWithScopes([ApiKeyScope.AI_GENERATE]);
    asUser('user-1', 'left-org');
    h.resolveBillingOrgId.mockResolvedValue(null);
    h.createVideoJob.mockResolvedValue({ ok: true, job: videoJob(), created: true });
    const { req, res } = post({ model: 'gemini-omni-1.1-flash', prompt: 'p' });
    await handler(req, res);
    expect(h.createVideoJob.mock.calls[0][0].user).toEqual({ id: 'user-1', organizationId: null });
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

describe('GET /api/v1/video-generations', () => {
  beforeEach(resetHarness);
  const id = (n: number) => `664f1c2b9a1e4d0012ab34${n.toString(16).padStart(2, '0')}`;
  const list = (query: Record<string, string> = {}) => fire({ url: '/api/v1/video-generations', query });
  const forgeCursor = (after: string) =>
    Buffer.from(JSON.stringify({ v: 1, s: 'v1.video-generations', after }), 'utf8').toString('base64url');

  it('pages newest first across two pages with an opaque cursor', async () => {
    validateWithScopes([ApiKeyScope.AI_GENERATE]);
    h.listByRequester
      .mockResolvedValueOnce([videoJob({ id: id(3) }), videoJob({ id: id(2) }), videoJob({ id: id(1) })])
      .mockResolvedValueOnce([videoJob({ id: id(1) })]);

    const first = list({ limit: '2' });
    await handler(first.req, first.res);
    const page1 = first.res._getJSONData();
    expect(page1.data.map((job: { id: string }) => job.id)).toEqual([id(3), id(2)]);
    expect(page1.next_cursor).toEqual(expect.any(String));
    expect(h.listByRequester).toHaveBeenLastCalledWith({
      requestedBy: 'user-1',
      kind: 'video',
      state: undefined,
      source: undefined,
      beforeId: undefined,
      limit: 3,
    });

    const second = list({ limit: '2', cursor: page1.next_cursor });
    await handler(second.req, second.res);
    expect(second.res._getJSONData()).toEqual({ data: [expect.objectContaining({ id: id(1) })], next_cursor: null });
    expect(h.listByRequester).toHaveBeenLastCalledWith(expect.objectContaining({ beforeId: id(2), limit: 3 }));
  });

  it('passes the state and source filters through', async () => {
    validateWithScopes([ApiKeyScope.AI_GENERATE]);
    h.listByRequester.mockResolvedValue([]);
    const { req, res } = list({ state: 'succeeded', source: 'api' });
    await handler(req, res);
    expect(res._getStatusCode()).toBe(200);
    expect(h.listByRequester).toHaveBeenCalledWith(expect.objectContaining({ state: 'succeeded', source: 'api' }));
  });

  it('422s a malformed cursor, a cursor carrying a non-ObjectId, and an unknown state', async () => {
    validateWithScopes([ApiKeyScope.AI_GENERATE]);
    for (const query of [{ cursor: 'garbage' }, { cursor: forgeCursor('not-an-object-id') }, { state: 'done' }]) {
      const { req, res } = list(query);
      await handler(req, res);
      expect(res._getStatusCode()).toBe(422);
    }
    expect(h.listByRequester).not.toHaveBeenCalled();
  });

  it("never returns another member's jobs", async () => {
    validateWithScopes([ApiKeyScope.AI_GENERATE], 'member-a');
    asUser('member-a', 'org-1');
    h.listByRequester.mockResolvedValue([]);
    const { req, res } = list();
    await handler(req, res);
    expect(h.listByRequester).toHaveBeenCalledWith(expect.objectContaining({ requestedBy: 'member-a' }));
    expect(h.listByRequester.mock.calls[0][0]).not.toHaveProperty('ownerId');
  });
});
