// @vitest-environment node
/**
 * Integration test for POST and GET /api/v1/music-generations through the real next-connect chain
 * (nextRouteForContract -> apiKeyAuth -> scope check -> validation -> handler). The domain (createMusicJob)
 * and the repository are mocked: their behaviour is covered in services and database.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiKeyScope, CreditHolderType } from '@bike4mind/common';
import {
  asUser,
  fire,
  h,
  JOB_ID,
  musicJob,
  resetHarness,
  validateWithScopes,
} from '@server/generations/__test__/routeHarness';

vi.mock('@server/utils/apiKeyTrust', () => ({
  applyUntrustedRateLimit: async (_owner: unknown, key: { rateLimit: unknown }) => key.rateLimit,
}));
vi.mock('@server/utils/apiKeyRateLimitCheck', async orig =>
  (await import('@server/generations/__test__/routeHarness')).apiKeyRateLimitCheckMock(orig)
);
vi.mock('@server/middlewares/rateLimit', async () =>
  (await import('@server/generations/__test__/routeHarness')).rateLimitMiddlewareMock()
);
vi.mock('@server/utils/userRateTier', async () =>
  (await import('@server/generations/__test__/routeHarness')).userRateTierMock()
);
vi.mock('@server/utils/orgAccess', async orig =>
  (await import('@server/generations/__test__/routeHarness')).orgAccessMock(orig)
);
vi.mock('@server/utils/analyticsLog', () => ({ logEvent: vi.fn().mockResolvedValue(undefined) }));
vi.mock('@bike4mind/services', async orig =>
  (await import('@server/generations/__test__/routeHarness')).servicesMock(orig)
);
vi.mock('@bike4mind/services/musicJobs', async orig =>
  (await import('@server/generations/__test__/routeHarness')).musicJobsServiceMock(orig)
);
vi.mock('@bike4mind/database', async orig =>
  (await import('@server/generations/__test__/routeHarness')).databaseMock(orig)
);
vi.mock('@server/generationJobs/wiring', async () =>
  (await import('@server/generations/__test__/routeHarness')).wiringMock()
);
vi.mock('@server/generations/signOutputUrl', async () =>
  (await import('@server/generations/__test__/routeHarness')).signOutputUrlMock()
);
vi.mock('@server/auth/auth', async orig => (await import('@server/generations/__test__/routeHarness')).authMock(orig));

import handler from '../music-generations/index';

const post = (body: Record<string, unknown>, headers: Record<string, string> = {}) =>
  fire({ method: 'POST', url: '/api/v1/music-generations', body, headers });

describe('POST /api/v1/music-generations', () => {
  beforeEach(resetHarness);

  it('rejects a key lacking ai:generate (403) before creating a job', async () => {
    validateWithScopes([ApiKeyScope.READ_FILES]);
    const { req, res } = post({ model: 'test-music', prompt: 'a calm piano piece' });
    await handler(req, res);
    expect(res._getStatusCode()).toBe(403);
    expect(res._getJSONData().error).toMatch(/insufficient/i);
    expect(h.createMusicJob).not.toHaveBeenCalled();
  });

  it("returns 202 and passes only the fields the caller sent (defaults are the domain's)", async () => {
    validateWithScopes([ApiKeyScope.AI_GENERATE]);
    h.createMusicJob.mockResolvedValue({ ok: true, job: musicJob(), created: true });
    const { req, res } = post({ model: 'test-music', prompt: 'a calm piano piece' });
    await handler(req, res);
    expect(res._getStatusCode()).toBe(202);
    expect(res._getJSONData()).toMatchObject({ id: JOB_ID, object: 'music_generation', state: 'pending' });
    expect(h.createMusicJob).toHaveBeenCalledWith(
      {
        user: { id: 'user-1', organizationId: null },
        source: 'api',
        request: { model: 'test-music', prompt: 'a calm piano piece' },
      },
      expect.anything()
    );
  });

  it('maps snake_case body fields onto the domain request', async () => {
    validateWithScopes([ApiKeyScope.AI_GENERATE]);
    h.createMusicJob.mockResolvedValue({ ok: true, job: musicJob(), created: true });
    const { req, res } = post({
      model: 'lyria-3.5',
      prompt: 'p',
      lyrics: 'la la la',
      instrumental: false,
      duration_seconds: 90,
    });
    await handler(req, res);
    expect(res._getStatusCode()).toBe(202);
    expect(h.createMusicJob.mock.calls[0][0].request).toEqual({
      model: 'lyria-3.5',
      prompt: 'p',
      lyrics: 'la la la',
      instrumental: false,
      durationSeconds: 90,
    });
  });

  it('labels a session (studio) caller studio and keeps its Idempotency-Key apart from API keys', async () => {
    h.createMusicJob.mockResolvedValue({
      ok: true,
      job: musicJob({ requestedBy: 'jwt-user', source: 'studio' }),
      created: true,
    });
    const { req, res } = fire({
      method: 'POST',
      url: '/api/v1/music-generations',
      apiKey: null,
      body: { model: 'test-music', prompt: 'p' },
      headers: { 'idempotency-key': 'ui-1' },
    });
    await handler(req, res);
    expect(res._getStatusCode()).toBe(202);
    expect(res._getJSONData()).toMatchObject({ source: 'studio' });
    expect(h.createMusicJob.mock.calls[0][0]).toMatchObject({
      source: 'studio',
      idempotencyKey: 'studio:jwt-user:ui-1',
    });
  });

  it('namespaces the Idempotency-Key per user and returns 202 on replay', async () => {
    validateWithScopes([ApiKeyScope.AI_GENERATE]);
    h.createMusicJob.mockResolvedValue({ ok: true, job: musicJob(), created: false });
    const { req, res } = post({ model: 'test-music', prompt: 'p' }, { 'idempotency-key': 'retry-1' });
    await handler(req, res);
    expect(res._getStatusCode()).toBe(202);
    expect(res._getJSONData()).toMatchObject({ id: JOB_ID });
    expect(h.createMusicJob.mock.calls[0][0].idempotencyKey).toBe('api:user-1:retry-1');
    expect(h.createMusicJob.mock.calls[0][0].source).toBe('api');
  });

  it('the same Idempotency-Key from two org members reaches the domain under different keys', async () => {
    h.createMusicJob.mockResolvedValue({ ok: true, job: musicJob(), created: true });
    for (const userId of ['member-a', 'member-b']) {
      validateWithScopes([ApiKeyScope.AI_GENERATE], userId);
      asUser(userId, 'org-1');
      const { req, res } = post({ model: 'test-music', prompt: 'p' }, { 'idempotency-key': 'shared' });
      await handler(req, res);
      expect(res._getStatusCode()).toBe(202);
    }
    expect(h.createMusicJob.mock.calls.map(call => call[0].idempotencyKey)).toEqual([
      'api:member-a:shared',
      'api:member-b:shared',
    ]);
  });

  it('bills the org that resolveBillingOrgId returns, passing organization_id through', async () => {
    validateWithScopes([ApiKeyScope.AI_GENERATE]);
    h.resolveBillingOrgId.mockResolvedValue('billing-org');
    h.createMusicJob.mockResolvedValue({ ok: true, job: musicJob(), created: true });
    const { req, res } = post({ model: 'test-music', prompt: 'p', organization_id: 'some-org' });
    await handler(req, res);
    expect(h.resolveBillingOrgId).toHaveBeenCalledWith(expect.anything(), 'some-org');
    expect(h.createMusicJob.mock.calls[0][0].user).toEqual({ id: 'user-1', organizationId: 'billing-org' });
  });

  it('bills personal credits when organization_id is explicitly null', async () => {
    validateWithScopes([ApiKeyScope.AI_GENERATE]);
    h.resolveBillingOrgId.mockResolvedValue(null);
    h.createMusicJob.mockResolvedValue({ ok: true, job: musicJob(), created: true });
    const { req, res } = post({ model: 'test-music', prompt: 'p', organization_id: null });
    await handler(req, res);
    expect(res._getStatusCode()).toBe(202);
    expect(h.resolveBillingOrgId).toHaveBeenCalledWith(expect.anything(), null);
    expect(h.createMusicJob.mock.calls[0][0].user).toEqual({ id: 'user-1', organizationId: null });
  });

  it.each(['', '   '])('rejects a blank organization_id %j (422) instead of billing personal', async orgId => {
    validateWithScopes([ApiKeyScope.AI_GENERATE]);
    const { req, res } = post({ model: 'test-music', prompt: 'p', organization_id: orgId });
    await handler(req, res);
    expect(res._getStatusCode()).toBe(422);
    expect(h.createMusicJob).not.toHaveBeenCalled();
  });

  describe('billing target (API key)', () => {
    const KEY_ORG = 'd'.repeat(24);
    const OTHER_ORG = 'b'.repeat(24);
    const HOME_ORG = 'c'.repeat(24);
    const base = { model: 'test-music', prompt: 'p' };
    const orgKey = () =>
      validateWithScopes([ApiKeyScope.AI_GENERATE], 'user-1', {
        billingOwnerType: CreditHolderType.Organization,
        organizationId: KEY_ORG,
      });

    beforeEach(() => {
      h.createMusicJob.mockResolvedValue({ ok: true, job: musicJob(), created: true });
    });

    it('bills the key org when the body names none', async () => {
      orgKey();
      const { req, res } = post(base);
      await handler(req, res);
      expect(res._getStatusCode()).toBe(202);
      expect(h.createMusicJob.mock.calls[0][0].user).toEqual({ id: 'user-1', organizationId: KEY_ORG });
    });

    it('bills the key org when the body names the same org', async () => {
      orgKey();
      const { req, res } = post({ ...base, organization_id: KEY_ORG });
      await handler(req, res);
      expect(res._getStatusCode()).toBe(202);
      expect(h.createMusicJob.mock.calls[0][0].user).toEqual({ id: 'user-1', organizationId: KEY_ORG });
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
      expect(h.createMusicJob).not.toHaveBeenCalled();
    });

    it('refuses an org-billed key whose org no longer exists (400) before the domain', async () => {
      orgKey();
      h.orgFindById.mockResolvedValue(null);
      const { req, res } = post(base);
      await handler(req, res);
      expect(res._getStatusCode()).toBe(400);
      expect(h.createMusicJob).not.toHaveBeenCalled();
    });

    describe('without an org-billed key', () => {
      beforeEach(async () => {
        asUser('user-1', HOME_ORG);
        const actual = await vi.importActual<typeof import('@server/utils/orgAccess')>('@server/utils/orgAccess');
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
        expect(h.createMusicJob.mock.calls[0][0].user).toEqual({ id: 'user-1', organizationId: HOME_ORG });
        expect(h.orgFindById).not.toHaveBeenCalled();
      });

      it('keeps a personal key on the org the body names', async () => {
        validateWithScopes([ApiKeyScope.AI_GENERATE]);
        const { req, res } = post({ ...base, organization_id: HOME_ORG });
        await handler(req, res);
        expect(res._getStatusCode()).toBe(202);
        expect(h.createMusicJob.mock.calls[0][0].user).toEqual({ id: 'user-1', organizationId: HOME_ORG });
      });

      it('keeps a session caller on the org the body names', async () => {
        const { req, res } = fire({
          method: 'POST',
          url: '/api/v1/music-generations',
          apiKey: null,
          body: { ...base, organization_id: HOME_ORG },
        });
        await handler(req, res);
        expect(res._getStatusCode()).toBe(202);
        expect(h.createMusicJob.mock.calls[0][0].user).toEqual({ id: 'jwt-user', organizationId: HOME_ORG });
        expect(h.orgFindById).not.toHaveBeenCalled();
      });
    });
  });

  it.each(['', 'x'.repeat(256), 'bad\u0001key'])('rejects Idempotency-Key %j with 422', async key => {
    validateWithScopes([ApiKeyScope.AI_GENERATE]);
    const { req, res } = post({ model: 'test-music', prompt: 'p' }, { 'idempotency-key': key });
    await handler(req, res);
    expect(res._getStatusCode()).toBe(422);
    expect(res._getJSONData()).toMatchObject({ errorCode: 'invalid_idempotency_key' });
    expect(h.createMusicJob).not.toHaveBeenCalled();
  });

  // Every service refusal but storage is a 422 (no 402); storage is a 400 like Files, tested below.
  it.each([
    [{ status: 422, code: 'unsupported_duration' }, 'unsupported_duration'],
    [{ status: 422, code: 'unsupported_lyrics' }, 'unsupported_lyrics'],
    [{ status: 422, code: 'unsupported_vocals' }, 'unsupported_vocals'],
    [{ status: 422, code: 'lyrics_with_instrumental' }, 'lyrics_with_instrumental'],
    [{ status: 422, code: 'lyrics_too_long' }, 'lyrics_too_long'],
    [{ status: 422, code: 'idempotency_key_reused' }, 'idempotency_key_reused'],
    [{ status: 422, code: 'model_unavailable' }, 'model_unavailable'],
    [{ status: 402, code: 'insufficient_credits' }, 'insufficient_credits'],
    [{ status: 403, code: 'model_disabled' }, 'model_disabled'],
    [{ status: 400, code: 'invalid_request' }, 'invalid_request'],
  ])('maps a %o refusal to 422 with errorCode %s', async (refusal, errorCode) => {
    validateWithScopes([ApiKeyScope.AI_GENERATE]);
    h.createMusicJob.mockResolvedValue({ ok: false, message: 'refused', ...refusal });
    const { req, res } = post({ model: 'test-music', prompt: 'p' });
    await handler(req, res);
    expect(res._getStatusCode()).toBe(422);
    expect(res._getJSONData()).toMatchObject({ errorCode });
  });

  it('maps a storage refusal to 400 storage_limit_exceeded with the quota detail, as the Files routes do', async () => {
    validateWithScopes([ApiKeyScope.AI_GENERATE]);
    const storage = {
      errorCode: 'storage_limit_exceeded',
      used_bytes: 900,
      limit_bytes: 1000,
      requested_bytes: 200_000,
      owner: 'user',
    };
    h.createMusicJob.mockResolvedValue({
      ok: false,
      status: 400,
      code: 'storage_quota_exceeded',
      message: 'full',
      storage,
    });
    const { req, res } = post({ model: 'test-music', prompt: 'p' });
    await handler(req, res);
    expect(res._getStatusCode()).toBe(400);
    expect(res._getJSONData()).toMatchObject(storage);
  });

  it('refuses an unknown model as model_unavailable before the domain', async () => {
    validateWithScopes([ApiKeyScope.AI_GENERATE]);
    const { req, res } = post({ model: 'suno-v5', prompt: 'p' });
    await handler(req, res);
    expect(res._getStatusCode()).toBe(422);
    expect(res._getJSONData()).toMatchObject({ errorCode: 'model_unavailable' });
    expect(h.createMusicJob).not.toHaveBeenCalled();
  });

  it('rejects a body without a prompt (422) before the domain', async () => {
    validateWithScopes([ApiKeyScope.AI_GENERATE]);
    const { req, res } = post({ model: 'test-music' });
    await handler(req, res);
    expect(res._getStatusCode()).toBe(422);
    expect(h.createMusicJob).not.toHaveBeenCalled();
  });

  it('rejects an unknown key (422), naming it', async () => {
    validateWithScopes([ApiKeyScope.AI_GENERATE]);
    const { req, res } = post({ model: 'test-music', prompt: 'p', callbackUrl: 'https://example.com/hook' });
    await handler(req, res);
    expect(res._getStatusCode()).toBe(422);
    expect(res._getJSONData()).toMatchObject({ error: expect.stringContaining('Unrecognized key: "callbackUrl"') });
    expect(h.createMusicJob).not.toHaveBeenCalled();
  });

  it('rejects camelCase field names (422) rather than silently applying the catalog default', async () => {
    validateWithScopes([ApiKeyScope.AI_GENERATE]);
    const { req, res } = post({ model: 'test-music', prompt: 'p', durationSeconds: 3 });
    await handler(req, res);
    expect(res._getStatusCode()).toBe(422);
    expect(h.createMusicJob).not.toHaveBeenCalled();
  });
});

describe('GET /api/v1/music-generations', () => {
  beforeEach(resetHarness);
  const id = (n: number) => `664f1c2b9a1e4d0012ab34${n.toString(16).padStart(2, '0')}`;
  const list = (query: Record<string, string> = {}) => fire({ url: '/api/v1/music-generations', query });
  const forgeCursor = (after: string, scope = 'v1.music-generations') =>
    Buffer.from(JSON.stringify({ v: 1, s: scope, after }), 'utf8').toString('base64url');

  it('rejects a key lacking ai:generate (403) before listing', async () => {
    validateWithScopes([ApiKeyScope.READ_FILES]);
    const { req, res } = list();
    await handler(req, res);
    expect(res._getStatusCode()).toBe(403);
    expect(res._getJSONData()).toMatchObject({
      error: expect.stringMatching(/insufficient/i),
      required_scopes: [ApiKeyScope.AI_GENERATE],
    });
    expect(h.listByRequester).not.toHaveBeenCalled();
  });

  it('pages newest first across two pages with an opaque cursor, asking only for music jobs', async () => {
    validateWithScopes([ApiKeyScope.AI_GENERATE]);
    h.listByRequester
      .mockResolvedValueOnce([musicJob({ id: id(3) }), musicJob({ id: id(2) }), musicJob({ id: id(1) })])
      .mockResolvedValueOnce([musicJob({ id: id(1) })]);

    const first = list({ limit: '2' });
    await handler(first.req, first.res);
    const page1 = first.res._getJSONData();
    expect(page1.data.map((job: { id: string }) => job.id)).toEqual([id(3), id(2)]);
    expect(page1.next_cursor).toEqual(expect.any(String));
    expect(h.listByRequester).toHaveBeenLastCalledWith({
      requestedBy: 'user-1',
      kind: 'music',
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

  it('422s a malformed cursor, a non-ObjectId cursor, a video-scoped cursor and an unknown state', async () => {
    validateWithScopes([ApiKeyScope.AI_GENERATE]);
    for (const query of [
      { cursor: 'garbage' },
      { cursor: forgeCursor('not-an-object-id') },
      { cursor: forgeCursor(id(1), 'v1.video-generations') },
      { state: 'done' },
    ]) {
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
