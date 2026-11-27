// @vitest-environment node
/**
 * Integration test for POST and GET /api/v1/video-generations through the real next-connect chain
 * (nextRouteForContract -> apiKeyAuth -> scope check -> validation -> handler). The domain (createVideoJob)
 * and the repository are mocked: their behaviour is covered in services and database.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ApiKeyScope,
  CreditHolderType,
  ForbiddenError,
  NotFoundError,
  UnprocessableEntityError,
} from '@bike4mind/common';
import {
  asUser,
  fire,
  h,
  JOB_ID,
  resetHarness,
  validateWithScopes,
  videoJob,
} from '@server/generations/__test__/routeHarness';

vi.mock('@bike4mind/server-utils/utils/apiKeyTrust', () => ({
  resolveUntrustedKeyLimits: async (_owner: unknown, key: { rateLimit: unknown }) => ({
    rateLimit: key.rateLimit,
    ownerUntrusted: false,
  }),
}));
vi.mock('@bike4mind/server-utils/utils/apiKeyRateLimitCheck', async orig =>
  (await import('@server/generations/__test__/routeHarness')).apiKeyRateLimitCheckMock(orig)
);
vi.mock('@bike4mind/server-utils/middlewares/rateLimit', async () =>
  (await import('@server/generations/__test__/routeHarness')).rateLimitMiddlewareMock()
);
vi.mock('@bike4mind/server-utils/utils/userRateTier', async () =>
  (await import('@server/generations/__test__/routeHarness')).userRateTierMock()
);
vi.mock('@bike4mind/server-utils/utils/orgAccess', async orig =>
  (await import('@server/generations/__test__/routeHarness')).orgAccessMock(orig)
);
vi.mock('@bike4mind/server-utils/utils/analyticsLog', () => ({ logEvent: vi.fn().mockResolvedValue(undefined) }));
vi.mock('@bike4mind/services', async orig =>
  (await import('@server/generations/__test__/routeHarness')).servicesMock(orig)
);
vi.mock('@bike4mind/services/videoJobs', async orig =>
  (await import('@server/generations/__test__/routeHarness')).videoJobsServiceMock(orig)
);
vi.mock('@bike4mind/database', async orig =>
  (await import('@server/generations/__test__/routeHarness')).databaseMock(orig)
);
vi.mock('@bike4mind/server-utils/generationJobs/wiring', async () =>
  (await import('@server/generations/__test__/routeHarness')).wiringMock()
);
vi.mock('@bike4mind/server-utils/generations/signOutputUrl', async () =>
  (await import('@server/generations/__test__/routeHarness')).signOutputUrlMock()
);
vi.mock('@bike4mind/server-utils/videoGenerations/listUsableVideoModels', async orig =>
  (await import('@server/generations/__test__/routeHarness')).listUsableVideoModelsMock(orig)
);
const paidCallRun = vi.hoisted(() => ({
  resolve: vi.fn(async (_req: unknown, run: { runId: string } | undefined, _organizationId?: string | null) =>
    run ? { attribution: { ...run, purpose: 'tool' as const }, billingOrganizationId: null } : undefined
  ),
}));
vi.mock('@server/completionRuns/paidCallRun', () => ({ resolvePaidCallRun: paidCallRun.resolve }));

vi.mock('@server/auth/auth', async orig => (await import('@server/generations/__test__/routeHarness')).authMock(orig));

import handler from '../video-generations/index';

const post = (body: Record<string, unknown>, headers: Record<string, string> = {}) =>
  fire({ method: 'POST', url: '/api/v1/video-generations', body, headers });

describe('POST /api/v1/video-generations', () => {
  beforeEach(resetHarness);

  it.each([true, false])('maps keyframes, infers image mode and preserves draft=%s', async draft => {
    validateWithScopes([ApiKeyScope.AI_GENERATE]);
    h.createVideoJob.mockResolvedValue({ ok: true, job: videoJob(), created: true });
    const { req, res } = post({
      model: 'flux-3-video',
      prompt: 'p',
      draft,
      keyframes: [
        { file_id: 'f1', time_seconds: 0 },
        { file_id: 'f2', time_seconds: 5 },
      ],
    });
    await handler(req, res);
    expect(res._getStatusCode()).toBe(202);
    expect(h.createVideoJob.mock.calls[0][0].request).toMatchObject({
      mode: 'image_to_video',
      draft,
      keyframes: [
        { fileId: 'f1', timeSeconds: 0 },
        { fileId: 'f2', timeSeconds: 5 },
      ],
    });
  });

  it('rejects a key lacking ai:generate (403) before creating a job', async () => {
    validateWithScopes([ApiKeyScope.READ_FILES]);
    const { req, res } = post({ model: 'gemini-omni-1.1-flash', prompt: 'a lighthouse' });
    await handler(req, res);
    expect(res._getStatusCode()).toBe(403);
    expect(res._getJSONData().error).toMatch(/insufficient/i);
    expect(h.createVideoJob).not.toHaveBeenCalled();
  });

  it('labels a session (studio) caller studio and keeps its Idempotency-Key apart from API keys', async () => {
    h.createVideoJob.mockResolvedValue({
      ok: true,
      job: videoJob({ requestedBy: 'jwt-user', source: 'studio' }),
      created: true,
    });
    const { req, res } = fire({
      method: 'POST',
      url: '/api/v1/video-generations',
      apiKey: null,
      body: { model: 'gemini-omni-1.1-flash', prompt: 'a lighthouse' },
      headers: { 'idempotency-key': 'ui-1' },
    });
    await handler(req, res);
    expect(res._getStatusCode()).toBe(202);
    expect(res._getJSONData()).toMatchObject({ source: 'studio' });
    expect(h.createVideoJob.mock.calls[0][0]).toMatchObject({
      source: 'studio',
      idempotencyKey: 'studio:jwt-user:ui-1',
    });
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
        user: { id: 'jwt-user', organizationId: null, adminRoleWithheld: false },
        source: 'studio',
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
    expect(h.createVideoJob.mock.calls[0][0].user.adminRoleWithheld).toBe(true);
  });

  it('maps role-tagged inputs to the domain and infers image_to_video from a first_frame', async () => {
    validateWithScopes([ApiKeyScope.AI_GENERATE]);
    h.createVideoJob.mockResolvedValue({ ok: true, job: videoJob(), created: true });
    const { req, res } = post({
      model: 'test-video',
      prompt: 'p',
      inputs: [
        { file_id: 'f1', role: 'first_frame' },
        { file_id: 'r1', role: 'reference' },
      ],
    });
    await handler(req, res);
    expect(res._getStatusCode()).toBe(202);
    const { request } = h.createVideoJob.mock.calls[0][0];
    expect(request).toMatchObject({
      mode: 'image_to_video',
      inputs: [
        { role: 'first_frame', fileId: 'f1' },
        { role: 'reference', fileId: 'r1' },
      ],
    });
    expect(request).not.toHaveProperty('inputImageFileId');
  });

  it('keeps text_to_video when the inputs carry no first_frame', async () => {
    validateWithScopes([ApiKeyScope.AI_GENERATE]);
    h.createVideoJob.mockResolvedValue({ ok: true, job: videoJob(), created: true });
    const { req, res } = post({ model: 'test-video', prompt: 'p', inputs: [{ file_id: 'r1', role: 'reference' }] });
    await handler(req, res);
    expect(h.createVideoJob.mock.calls[0][0].request).toMatchObject({ mode: 'text_to_video' });
  });

  it('rejects inputs combined with input_image_file_id (422) before the domain', async () => {
    validateWithScopes([ApiKeyScope.AI_GENERATE]);
    const { req, res } = post({
      model: 'test-video',
      prompt: 'p',
      input_image_file_id: 'f1',
      inputs: [{ file_id: 'f1', role: 'first_frame' }],
    });
    await handler(req, res);
    expect(res._getStatusCode()).toBe(422);
    expect(res._getJSONData()).toMatchObject({ errorCode: 'unexpected_input_image' });
    expect(h.createVideoJob).not.toHaveBeenCalled();
  });

  it.each([
    { role: 'first_frame', generated_image_key: 'k.png' },
    { role: 'first_frame', generatedImageKey: 'k.png' },
    { role: 'first_frame', file_id: 'f1', generatedImageKey: 'k.png' },
  ])('never takes a generated-image key in inputs (422) before the domain: %o', async input => {
    validateWithScopes([ApiKeyScope.AI_GENERATE]);
    const { req, res } = post({ model: 'test-video', prompt: 'p', inputs: [input] });
    await handler(req, res);
    expect(res._getStatusCode()).toBe(422);
    expect(h.createVideoJob).not.toHaveBeenCalled();
  });

  it('rejects an input role the API does not define (422) before the domain', async () => {
    validateWithScopes([ApiKeyScope.AI_GENERATE]);
    const { req, res } = post({ model: 'test-video', prompt: 'p', inputs: [{ file_id: 'f1', role: 'mask' }] });
    await handler(req, res);
    expect(res._getStatusCode()).toBe(422);
    expect(h.createVideoJob).not.toHaveBeenCalled();
  });

  it('namespaces the Idempotency-Key per user and returns 202 on replay', async () => {
    validateWithScopes([ApiKeyScope.AI_GENERATE]);
    h.createVideoJob.mockResolvedValue({ ok: true, job: videoJob(), created: false });
    const { req, res } = post({ model: 'gemini-omni-1.1-flash', prompt: 'p' }, { 'idempotency-key': 'retry-1' });
    await handler(req, res);
    expect(res._getStatusCode()).toBe(202);
    expect(h.createVideoJob.mock.calls[0][0].idempotencyKey).toBe('api:user-1:retry-1');
    expect(h.createVideoJob.mock.calls[0][0].source).toBe('api');
  });

  it('records the authenticating key on the job so its settlement is attributed to the key', async () => {
    validateWithScopes([ApiKeyScope.AI_GENERATE]);
    h.createVideoJob.mockResolvedValue({ ok: true, job: videoJob(), created: true });
    const { req, res } = post({ model: 'gemini-omni-1.1-flash', prompt: 'p' });
    await handler(req, res);
    expect(res._getStatusCode()).toBe(202);
    expect(h.createVideoJob.mock.calls[0][0].apiKeyId).toBe('k1');
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
      { id: 'member-a', organizationId: 'org-1', adminRoleWithheld: true },
      { id: 'member-b', organizationId: 'org-1', adminRoleWithheld: true },
    ]);
  });

  it('bills the org that resolveBillingOrgId returns', async () => {
    validateWithScopes([ApiKeyScope.AI_GENERATE]);
    h.resolveBillingOrgId.mockResolvedValue('billing-org');
    h.createVideoJob.mockResolvedValue({ ok: true, job: videoJob(), created: true });
    const { req, res } = post({ model: 'gemini-omni-1.1-flash', prompt: 'p' });
    await handler(req, res);
    expect(h.resolveBillingOrgId).toHaveBeenCalledWith(expect.anything(), undefined);
    expect(h.createVideoJob.mock.calls[0][0].user).toEqual({
      id: 'user-1',
      organizationId: 'billing-org',
      adminRoleWithheld: true,
    });
  });

  describe('organization_id (the account switcher)', () => {
    const MEMBER_ORG = 'a'.repeat(24);
    const OTHER_ORG = 'b'.repeat(24);
    const HOME_ORG = 'c'.repeat(24);

    beforeEach(async () => {
      validateWithScopes([ApiKeyScope.AI_GENERATE]);
      asUser('user-1', HOME_ORG);
      // The real resolver, so membership is decided by the shareable gate rather than the harness default.
      const actual = await vi.importActual<typeof import('@bike4mind/server-utils/utils/orgAccess')>(
        '@bike4mind/server-utils/utils/orgAccess'
      );
      h.resolveBillingOrgId.mockImplementation(actual.resolveBillingOrgId);
      h.orgFindAccessibleById.mockImplementation(async (_user: unknown, id: string) =>
        id === MEMBER_ORG || id === HOME_ORG ? { id } : null
      );
      h.createVideoJob.mockResolvedValue({ ok: true, job: videoJob(), created: true });
    });

    it('bills an org the caller belongs to', async () => {
      const { req, res } = post({ model: 'gemini-omni-1.1-flash', prompt: 'p', organization_id: MEMBER_ORG });
      await handler(req, res);
      expect(res._getStatusCode()).toBe(202);
      expect(h.createVideoJob.mock.calls[0][0].user).toEqual({
        id: 'user-1',
        organizationId: MEMBER_ORG,
        adminRoleWithheld: true,
      });
    });

    it('rejects an org the caller does not belong to (403) before the domain', async () => {
      const { req, res } = post({ model: 'gemini-omni-1.1-flash', prompt: 'p', organization_id: OTHER_ORG });
      await handler(req, res);
      expect(res._getStatusCode()).toBe(403);
      expect(h.createVideoJob).not.toHaveBeenCalled();
    });

    it('bills personal credits for an explicit null, even with a home org', async () => {
      const { req, res } = post({ model: 'gemini-omni-1.1-flash', prompt: 'p', organization_id: null });
      await handler(req, res);
      expect(res._getStatusCode()).toBe(202);
      expect(h.createVideoJob.mock.calls[0][0].user).toEqual({
        id: 'user-1',
        organizationId: null,
        adminRoleWithheld: true,
      });
      expect(h.orgFindAccessibleById).not.toHaveBeenCalled();
    });

    it('falls back to the home org when omitted', async () => {
      const { req, res } = post({ model: 'gemini-omni-1.1-flash', prompt: 'p' });
      await handler(req, res);
      expect(res._getStatusCode()).toBe(202);
      expect(h.createVideoJob.mock.calls[0][0].user).toEqual({
        id: 'user-1',
        organizationId: HOME_ORG,
        adminRoleWithheld: true,
      });
    });

    it.each(['', '   '])('rejects a blank organization_id %j (422) instead of billing personal', async orgId => {
      const { req, res } = post({ model: 'gemini-omni-1.1-flash', prompt: 'p', organization_id: orgId });
      await handler(req, res);
      expect(res._getStatusCode()).toBe(422);
      expect(h.createVideoJob).not.toHaveBeenCalled();
    });

    it('rejects a non-string organization_id (422) before the domain', async () => {
      const { req, res } = post({ model: 'gemini-omni-1.1-flash', prompt: 'p', organization_id: 42 });
      await handler(req, res);
      expect(res._getStatusCode()).toBe(422);
      expect(h.createVideoJob).not.toHaveBeenCalled();
    });
  });

  describe('billing target (API key)', () => {
    const KEY_ORG = 'd'.repeat(24);
    const OTHER_ORG = 'b'.repeat(24);
    const HOME_ORG = 'c'.repeat(24);
    const base = { model: 'gemini-omni-1.1-flash', prompt: 'p' };
    const orgKey = () =>
      validateWithScopes([ApiKeyScope.AI_GENERATE], 'user-1', {
        billingOwnerType: CreditHolderType.Organization,
        organizationId: KEY_ORG,
      });

    beforeEach(() => {
      h.createVideoJob.mockResolvedValue({ ok: true, job: videoJob(), created: true });
    });

    it('carries the key billing owner type to the job', async () => {
      orgKey();
      const first = post(base);
      await handler(first.req, first.res);
      expect(h.createVideoJob.mock.calls[0][0].apiKeyBillingOwnerType).toBe(CreditHolderType.Organization);

      h.createVideoJob.mockClear();
      validateWithScopes([ApiKeyScope.AI_GENERATE], 'user-1', { billingOwnerType: CreditHolderType.User });
      const second = post(base);
      await handler(second.req, second.res);
      expect(h.createVideoJob.mock.calls[0][0].apiKeyBillingOwnerType).toBe(CreditHolderType.User);
    });

    it('bills the key org when the body names none', async () => {
      orgKey();
      const { req, res } = post(base);
      await handler(req, res);
      expect(res._getStatusCode()).toBe(202);
      expect(h.createVideoJob.mock.calls[0][0].user).toEqual({
        id: 'user-1',
        organizationId: KEY_ORG,
        adminRoleWithheld: true,
      });
    });

    it('bills the key org when the body names the same org', async () => {
      orgKey();
      const { req, res } = post({ ...base, organization_id: KEY_ORG });
      await handler(req, res);
      expect(res._getStatusCode()).toBe(202);
      expect(h.createVideoJob.mock.calls[0][0].user).toEqual({
        id: 'user-1',
        organizationId: KEY_ORG,
        adminRoleWithheld: true,
      });
    });

    it.each([
      ['another org', OTHER_ORG],
      ['null (personal)', null],
    ])('refuses %s on an org-billed key (403) before the domain', async (_label, orgId) => {
      orgKey();
      const { req, res } = post({ ...base, organization_id: orgId });
      await handler(req, res);
      expect(res._getStatusCode()).toBe(403);
      expect(res._getJSONData()).toMatchObject({ errorCode: 'billing_organization_mismatch' });
      expect(h.createVideoJob).not.toHaveBeenCalled();
    });

    it('refuses an org-billed key whose org no longer exists (400) before the domain', async () => {
      orgKey();
      h.orgFindById.mockResolvedValue(null);
      const { req, res } = post(base);
      await handler(req, res);
      expect(res._getStatusCode()).toBe(400);
      expect(h.createVideoJob).not.toHaveBeenCalled();
    });

    describe('without an org-billed key', () => {
      beforeEach(async () => {
        asUser('user-1', HOME_ORG);
        const actual = await vi.importActual<typeof import('@bike4mind/server-utils/utils/orgAccess')>(
          '@bike4mind/server-utils/utils/orgAccess'
        );
        h.resolveBillingOrgId.mockImplementation(actual.resolveBillingOrgId);
        h.orgFindAccessibleById.mockImplementation(async (_user: unknown, id: string) =>
          id === HOME_ORG ? { id } : null
        );
      });

      it('keeps a personal key on the home org when the body names none', async () => {
        validateWithScopes([ApiKeyScope.AI_GENERATE]);
        const { req, res } = post(base);
        await handler(req, res);
        expect(res._getStatusCode()).toBe(202);
        expect(h.createVideoJob.mock.calls[0][0].user).toEqual({
          id: 'user-1',
          organizationId: HOME_ORG,
          adminRoleWithheld: true,
        });
        expect(h.orgFindById).not.toHaveBeenCalled();
      });

      it('keeps a personal key on the org the body names', async () => {
        validateWithScopes([ApiKeyScope.AI_GENERATE]);
        const { req, res } = post({ ...base, organization_id: HOME_ORG });
        await handler(req, res);
        expect(res._getStatusCode()).toBe(202);
        expect(h.createVideoJob.mock.calls[0][0].user).toEqual({
          id: 'user-1',
          organizationId: HOME_ORG,
          adminRoleWithheld: true,
        });
      });

      it('keeps a session caller on the org the body names', async () => {
        const { req, res } = fire({
          method: 'POST',
          url: '/api/v1/video-generations',
          apiKey: null,
          body: { ...base, organization_id: HOME_ORG },
        });
        await handler(req, res);
        expect(res._getStatusCode()).toBe(202);
        expect(h.createVideoJob.mock.calls[0][0].user).toEqual({
          id: 'jwt-user',
          organizationId: HOME_ORG,
          adminRoleWithheld: false,
        });
        expect(h.orgFindById).not.toHaveBeenCalled();
      });
    });
  });

  it('falls back to personal billing when the org pointer is stale', async () => {
    validateWithScopes([ApiKeyScope.AI_GENERATE]);
    asUser('user-1', 'left-org');
    h.resolveBillingOrgId.mockResolvedValue(null);
    h.createVideoJob.mockResolvedValue({ ok: true, job: videoJob(), created: true });
    const { req, res } = post({ model: 'gemini-omni-1.1-flash', prompt: 'p' });
    await handler(req, res);
    expect(h.createVideoJob.mock.calls[0][0].user).toEqual({
      id: 'user-1',
      organizationId: null,
      adminRoleWithheld: true,
    });
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

  it('refuses an unknown model as model_unavailable before the domain', async () => {
    validateWithScopes([ApiKeyScope.AI_GENERATE]);
    const unknown = post({ model: 'sora-2', prompt: 'p' });
    await handler(unknown.req, unknown.res);
    expect(unknown.res._getStatusCode()).toBe(422);
    expect(unknown.res._getJSONData()).toMatchObject({ errorCode: 'model_unavailable' });
    expect(h.createVideoJob).not.toHaveBeenCalled();
  });

  it('leaves the key check to the domain, so a same-key retry replays after the key is removed', async () => {
    validateWithScopes([ApiKeyScope.AI_GENERATE]);
    h.hasUsableKey.mockResolvedValue(false);
    h.createVideoJob.mockResolvedValue({ ok: true, job: videoJob(), created: false });
    const { req, res } = post({ model: 'gemini-omni-1.1-flash', prompt: 'p' }, { 'idempotency-key': 'retry-1' });
    await handler(req, res);
    expect(res._getStatusCode()).toBe(202);
    expect(res._getJSONData()).toMatchObject({ id: videoJob().id });
    expect(h.createVideoJob).toHaveBeenCalledTimes(1);
  });

  it('rejects a body without a prompt (422) before the domain', async () => {
    validateWithScopes([ApiKeyScope.AI_GENERATE]);
    const { req, res } = post({ model: 'gemini-omni-1.1-flash' });
    await handler(req, res);
    expect(res._getStatusCode()).toBe(422);
    expect(h.createVideoJob).not.toHaveBeenCalled();
  });

  it('rejects an unknown key such as the removed callbackUrl (422), naming it', async () => {
    validateWithScopes([ApiKeyScope.AI_GENERATE]);
    const { req, res } = post({
      model: 'gemini-omni-1.1-flash',
      prompt: 'p',
      callbackUrl: 'https://example.com/hook',
    });
    await handler(req, res);
    expect(res._getStatusCode()).toBe(422);
    expect(res._getJSONData()).toMatchObject({ error: expect.stringContaining('Unrecognized key: "callbackUrl"') });
    expect(h.createVideoJob).not.toHaveBeenCalled();
  });

  // The generated-image input is the chat agent's alone; the public body has no field that reaches it.
  it.each(['inputGeneratedImageKey', 'input_generated_image_key'])(
    'rejects a generated-image key sent as %s (422) before creating a job',
    async field => {
      validateWithScopes([ApiKeyScope.AI_GENERATE]);
      const { req, res } = post({
        model: 'gemini-omni-1.1-flash',
        prompt: 'p',
        mode: 'image_to_video',
        [field]: '86cdc650-43d2-416e-aca6-23ff4fe23081.png',
      });
      await handler(req, res);
      expect(res._getStatusCode()).toBe(422);
      expect(res._getJSONData()).toMatchObject({ error: expect.stringContaining(`Unrecognized key: "${field}"`) });
      expect(h.createVideoJob).not.toHaveBeenCalled();
    }
  );

  it('rejects camelCase field names (422) rather than silently applying the catalog default', async () => {
    validateWithScopes([ApiKeyScope.AI_GENERATE]);
    const { req, res } = post({ model: 'gemini-omni-1.1-flash', prompt: 'p', durationSeconds: 3 });
    await handler(req, res);
    expect(res._getStatusCode()).toBe(422);
    expect(h.createVideoJob).not.toHaveBeenCalled();
  });
});

describe('GET /api/v1/video-generations', () => {
  beforeEach(resetHarness);
  const id = (n: number) => `664f1c2b9a1e4d0012ab34${n.toString(16).padStart(2, '0')}`;
  const list = (query: Record<string, string> = {}) => fire({ url: '/api/v1/video-generations', query });
  const forgeCursor = (after: string) =>
    Buffer.from(JSON.stringify({ v: 1, s: 'v1.video-generations', after }), 'utf8').toString('base64url');

  it('rejects a key lacking ai:generate (403) before listing', async () => {
    validateWithScopes([ApiKeyScope.READ_FILES]);
    const { req, res } = list();
    await handler(req, res);
    expect(res._getStatusCode()).toBe(403);
    expect(h.listByRequester).not.toHaveBeenCalled();
  });

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

describe('POST /api/v1/video-generations with a completion run', () => {
  beforeEach(resetHarness);
  const RUN_ID = '0b6f3c1e-8a52-4c4e-9d55-3f0a6f2c7d11';
  const runBody = { runId: RUN_ID, role: 'worker' as const, taskId: 'task-1' };
  const attribution = { ...runBody, purpose: 'tool' as const };

  it("bills the run's account and hands the run attribution to the domain", async () => {
    validateWithScopes([ApiKeyScope.AI_GENERATE]);
    paidCallRun.resolve.mockResolvedValueOnce({ attribution, billingOrganizationId: 'run-org' });
    h.createVideoJob.mockResolvedValue({ ok: true, job: videoJob(), created: true });
    const { req, res } = post({ model: 'gemini-omni-1.1-flash', prompt: 'p', run: runBody });
    await handler(req, res);
    expect(res._getStatusCode()).toBe(202);
    expect(paidCallRun.resolve).toHaveBeenCalledWith(expect.anything(), runBody, undefined);
    expect(h.resolveBillingOrgId).not.toHaveBeenCalled();
    const input = h.createVideoJob.mock.calls[0][0];
    expect(input.user).toMatchObject({ id: 'user-1', organizationId: 'run-org' });
    expect(input.run).toEqual(attribution);
  });

  it('passes organization_id to the run check, which refuses a different account (403)', async () => {
    validateWithScopes([ApiKeyScope.AI_GENERATE]);
    paidCallRun.resolve.mockRejectedValueOnce(
      new ForbiddenError('This run bills a different account', { errorCode: 'billing_organization_mismatch' })
    );
    const { req, res } = post({ model: 'gemini-omni-1.1-flash', prompt: 'p', run: runBody, organization_id: null });
    await handler(req, res);
    expect(res._getStatusCode()).toBe(403);
    expect(paidCallRun.resolve).toHaveBeenCalledWith(expect.anything(), runBody, null);
    expect(h.createVideoJob).not.toHaveBeenCalled();
  });

  it("refuses another caller's run (404) before creating a job", async () => {
    validateWithScopes([ApiKeyScope.AI_GENERATE]);
    paidCallRun.resolve.mockRejectedValueOnce(new NotFoundError('Run not found', { errorCode: 'run_not_found' }));
    const { req, res } = post({ model: 'gemini-omni-1.1-flash', prompt: 'p', run: runBody });
    await handler(req, res);
    expect(res._getStatusCode()).toBe(404);
    expect(res._getJSONData()).toMatchObject({ errorCode: 'run_not_found' });
    expect(h.createVideoJob).not.toHaveBeenCalled();
  });

  it('answers 422 run_budget_exhausted when the job does not fit the run', async () => {
    validateWithScopes([ApiKeyScope.AI_GENERATE]);
    h.createVideoJob.mockRejectedValue(
      new UnprocessableEntityError('run budget used up', { errorCode: 'run_budget_exhausted' })
    );
    const { req, res } = post({ model: 'gemini-omni-1.1-flash', prompt: 'p', run: runBody });
    await handler(req, res);
    expect(res._getStatusCode()).toBe(422);
    expect(res._getJSONData()).toMatchObject({ errorCode: 'run_budget_exhausted' });
  });

  it('sends no run to the domain when none is given', async () => {
    validateWithScopes([ApiKeyScope.AI_GENERATE]);
    h.createVideoJob.mockResolvedValue({ ok: true, job: videoJob(), created: true });
    const { req, res } = post({ model: 'gemini-omni-1.1-flash', prompt: 'p' });
    await handler(req, res);
    expect(res._getStatusCode()).toBe(202);
    expect(h.createVideoJob.mock.calls[0][0]).not.toHaveProperty('run');
  });

  it('rejects a malformed run (422) before the domain', async () => {
    validateWithScopes([ApiKeyScope.AI_GENERATE]);
    const { req, res } = post({
      model: 'gemini-omni-1.1-flash',
      prompt: 'p',
      run: { runId: 'not-a-uuid', role: 'worker' },
    });
    await handler(req, res);
    expect(res._getStatusCode()).toBe(422);
    expect(h.createVideoJob).not.toHaveBeenCalled();
  });
});
