// @vitest-environment node
/**
 * Integration test for POST and GET /api/v1/image-jobs through the real next-connect chain
 * (nextRouteForContract -> apiKeyAuth -> scope check -> validation -> handler). The domain (createImageJobs)
 * and the repository are mocked: their behaviour is covered in services and database.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ApiKeyScope,
  CreditHolderType,
  ForbiddenError,
  NotFoundError,
  UnprocessableEntityError,
  type IGenerationJobDocument,
} from '@bike4mind/common';
import { asUser, fire, h, JOB_ID, resetHarness, validateWithScopes } from '@server/generations/__test__/routeHarness';

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
vi.mock('@bike4mind/database', async orig =>
  (await import('@server/generations/__test__/routeHarness')).databaseMock(orig)
);
vi.mock('@bike4mind/server-utils/generationJobs/wiring', async () => ({
  ...(await import('@server/generations/__test__/routeHarness')).wiringMock(),
  getCreateImageJobsDeps: () => ({}),
}));
vi.mock('@bike4mind/server-utils/generations/signOutputUrl', async () =>
  (await import('@server/generations/__test__/routeHarness')).signOutputUrlMock()
);
vi.mock('@server/auth/auth', async orig => (await import('@server/generations/__test__/routeHarness')).authMock(orig));

const paidCallRun = vi.hoisted(() => ({
  resolve: vi.fn(async (_req: unknown, run: { runId: string } | undefined, _organizationId?: string | null) =>
    run ? { attribution: { ...run, purpose: 'tool' as const }, billingOrganizationId: null } : undefined
  ),
}));
vi.mock('@server/completionRuns/paidCallRun', () => ({ resolvePaidCallRun: paidCallRun.resolve }));

const { createImageJobs } = vi.hoisted(() => ({ createImageJobs: vi.fn() }));
vi.mock('@bike4mind/services/imageJobs', async orig => ({
  ...(await orig<Record<string, unknown>>()),
  createImageJobs: (...a: unknown[]) => createImageJobs(...a),
}));

import handler from '../image-jobs/index';

const GROUP_ID = 'g'.repeat(24);
const FILE_ID = 'a'.repeat(24);

const imageJob = (overrides: Partial<IGenerationJobDocument> = {}): IGenerationJobDocument =>
  ({
    id: JOB_ID,
    kind: 'image',
    ownerType: CreditHolderType.User,
    ownerId: 'user-1',
    requestedBy: 'user-1',
    source: 'api',
    state: 'pending',
    payload: {
      request: { model: 'test-image', mode: 'generate', prompt: 'a lighthouse' },
      providerId: 'test',
      groupId: GROUP_ID,
    },
    pollCount: 0,
    attempts: 0,
    cancelRequested: false,
    deadlineAt: new Date('2026-10-06T00:20:00Z'),
    creditHold: null,
    createdAt: new Date('2026-10-06T00:00:00Z'),
    updatedAt: new Date('2026-10-06T00:00:00Z'),
    ...overrides,
  }) as IGenerationJobDocument;

const okResult = (jobs = [imageJob()]) => ({ ok: true, groupId: GROUP_ID, jobs });
const base = { model: 'test-image', mode: 'generate', prompt: 'a lighthouse' };

const post = (body: Record<string, unknown>, headers: Record<string, string> = {}) =>
  fire({ method: 'POST', url: '/api/v1/image-jobs', body, headers });

describe('POST /api/v1/image-jobs', () => {
  beforeEach(resetHarness);

  it('rejects a key lacking ai:generate (403) before creating jobs', async () => {
    validateWithScopes([ApiKeyScope.READ_FILES]);
    const { req, res } = post(base);
    await handler(req, res);
    expect(res._getStatusCode()).toBe(403);
    expect(res._getJSONData().error).toMatch(/insufficient/i);
    expect(createImageJobs).not.toHaveBeenCalled();
  });

  it('returns 202 with {group_id, data} and passes only the sent fields, count defaulting to 1', async () => {
    validateWithScopes([ApiKeyScope.AI_GENERATE]);
    createImageJobs.mockResolvedValue(okResult());
    const { req, res } = post(base);
    await handler(req, res);
    expect(res._getStatusCode()).toBe(202);
    const json = res._getJSONData();
    expect(json.group_id).toBe(GROUP_ID);
    expect(json.data).toHaveLength(1);
    expect(json.data[0]).toMatchObject({
      id: JOB_ID,
      object: 'image_generation',
      state: 'pending',
      model: 'test-image',
      mode: 'generate',
      prompt: 'a lighthouse',
      group_id: GROUP_ID,
      source: 'api',
      output: null,
    });
    expect(createImageJobs).toHaveBeenCalledWith(
      {
        user: { id: 'user-1', organizationId: null, adminRoleWithheld: true },
        request: { model: 'test-image', mode: 'generate', prompt: 'a lighthouse' },
        count: 1,
        source: 'api',
        apiKeyId: 'k1',
      },
      expect.anything()
    );
  });

  it('maps snake_case body fields onto the camelCase domain request and passes an explicit count', async () => {
    validateWithScopes([ApiKeyScope.AI_GENERATE]);
    createImageJobs.mockResolvedValue(okResult([imageJob(), imageJob({ id: '7'.repeat(24) })]));
    const { req, res } = post({
      model: 'test-image',
      mode: 'edit',
      prompt: 'p',
      inputs: [{ role: 'edit_source', file_id: FILE_ID }],
      size: '1024x1024',
      aspect_ratio: '1:1',
      quality: 'high',
      output_format: 'png',
      transparent_background: true,
      seed: 7,
      edit_regions: [{ prompt: 'make it blue', bbox: [0, 0, 0.5, 0.5] }],
      count: 2,
    });
    await handler(req, res);
    expect(res._getStatusCode()).toBe(202);
    expect(res._getJSONData().data).toHaveLength(2);
    const arg = createImageJobs.mock.calls[0][0];
    expect(arg.count).toBe(2);
    expect(arg.request).toEqual({
      model: 'test-image',
      mode: 'edit',
      prompt: 'p',
      inputs: [{ role: 'edit_source', fileId: FILE_ID }],
      size: '1024x1024',
      aspectRatio: '1:1',
      quality: 'high',
      outputFormat: 'png',
      transparentBackground: true,
      seed: 7,
      editRegions: [{ prompt: 'make it blue', bbox: [0, 0, 0.5, 0.5] }],
    });
  });

  it('labels a session (studio) caller studio and scopes its Idempotency-Key by source and kind', async () => {
    createImageJobs.mockResolvedValue(okResult([imageJob({ requestedBy: 'jwt-user', source: 'studio' })]));
    const { req, res } = fire({
      method: 'POST',
      url: '/api/v1/image-jobs',
      apiKey: null,
      body: base,
      headers: { 'idempotency-key': 'ui-1' },
    });
    await handler(req, res);
    expect(res._getStatusCode()).toBe(202);
    expect(res._getJSONData().data[0]).toMatchObject({ source: 'studio' });
    expect(createImageJobs.mock.calls[0][0]).toMatchObject({
      source: 'studio',
      idempotencyKey: 'studio:image:jwt-user:ui-1',
    });
  });

  it('namespaces the Idempotency-Key per api source and user', async () => {
    createImageJobs.mockResolvedValue(okResult());
    for (const userId of ['member-a', 'member-b']) {
      validateWithScopes([ApiKeyScope.AI_GENERATE], userId);
      asUser(userId, 'org-1');
      const { req, res } = post(base, { 'idempotency-key': 'shared' });
      await handler(req, res);
      expect(res._getStatusCode()).toBe(202);
    }
    expect(createImageJobs.mock.calls.map(call => call[0].idempotencyKey)).toEqual([
      'api:image:member-a:shared',
      'api:image:member-b:shared',
    ]);
  });

  it('omits the idempotency key when none is sent', async () => {
    validateWithScopes([ApiKeyScope.AI_GENERATE]);
    createImageJobs.mockResolvedValue(okResult());
    const { req, res } = post(base);
    await handler(req, res);
    expect(createImageJobs.mock.calls[0][0]).not.toHaveProperty('idempotencyKey');
  });

  it.each(['', 'x'.repeat(256), 'bad\u0001key'])('rejects Idempotency-Key %j with 422', async key => {
    validateWithScopes([ApiKeyScope.AI_GENERATE]);
    const { req, res } = post(base, { 'idempotency-key': key });
    await handler(req, res);
    expect(res._getStatusCode()).toBe(422);
    expect(res._getJSONData()).toMatchObject({ errorCode: 'invalid_idempotency_key' });
    expect(createImageJobs).not.toHaveBeenCalled();
  });

  it('bills the org that resolveBillingOrgId returns, passing organization_id through', async () => {
    validateWithScopes([ApiKeyScope.AI_GENERATE]);
    h.resolveBillingOrgId.mockResolvedValue('billing-org');
    createImageJobs.mockResolvedValue(okResult());
    const { req, res } = post({ ...base, organization_id: 'some-org' });
    await handler(req, res);
    expect(res._getStatusCode()).toBe(202);
    expect(h.resolveBillingOrgId).toHaveBeenCalledWith(expect.anything(), 'some-org');
    expect(createImageJobs.mock.calls[0][0].user).toEqual({
      id: 'user-1',
      organizationId: 'billing-org',
      adminRoleWithheld: true,
    });
  });

  it('bills the key org of an org-billed API key when the body names none', async () => {
    const keyOrg = 'd'.repeat(24);
    validateWithScopes([ApiKeyScope.AI_GENERATE], 'user-1', {
      billingOwnerType: CreditHolderType.Organization,
      organizationId: keyOrg,
    });
    createImageJobs.mockResolvedValue(okResult());
    const { req, res } = post(base);
    await handler(req, res);
    expect(res._getStatusCode()).toBe(202);
    expect(createImageJobs.mock.calls[0][0].user.organizationId).toBe(keyOrg);
  });

  it('refuses another org on an org-billed key (403) before the domain', async () => {
    validateWithScopes([ApiKeyScope.AI_GENERATE], 'user-1', {
      billingOwnerType: CreditHolderType.Organization,
      organizationId: 'd'.repeat(24),
    });
    const { req, res } = post({ ...base, organization_id: 'b'.repeat(24) });
    await handler(req, res);
    expect(res._getStatusCode()).toBe(403);
    expect(res._getJSONData()).toMatchObject({ errorCode: 'billing_organization_mismatch' });
    expect(createImageJobs).not.toHaveBeenCalled();
  });

  it('refuses an unknown model as model_unavailable before the domain', async () => {
    validateWithScopes([ApiKeyScope.AI_GENERATE]);
    const { req, res } = post({ ...base, model: 'imagine-v99' });
    await handler(req, res);
    expect(res._getStatusCode()).toBe(422);
    expect(res._getJSONData()).toMatchObject({ errorCode: 'model_unavailable' });
    expect(createImageJobs).not.toHaveBeenCalled();
  });

  it('maps unsupported_by_model to 422 with the first failure code and every failure message', async () => {
    validateWithScopes([ApiKeyScope.AI_GENERATE]);
    createImageJobs.mockResolvedValue({
      ok: false,
      status: 422,
      code: 'unsupported_by_model',
      message: 'size not supported',
      failures: [
        { code: 'unsupported_size', reason: 'r1', message: 'size not supported' },
        { code: 'unsupported_quality', reason: 'r2', message: 'quality not supported' },
      ],
    });
    const { req, res } = post(base);
    await handler(req, res);
    expect(res._getStatusCode()).toBe(422);
    expect(res._getJSONData()).toMatchObject({
      errorCode: 'unsupported_size',
      error: 'size not supported; quality not supported',
    });
  });

  it.each([
    [{ status: 402, code: 'insufficient_credits' }, 'insufficient_credits'],
    [{ status: 422, code: 'model_unavailable' }, 'model_unavailable'],
    [{ status: 422, code: 'idempotency_key_reused' }, 'idempotency_key_reused'],
    [{ status: 422, code: 'input_image_not_found' }, 'input_image_not_found'],
    [{ status: 422, code: 'unsupported_input_image' }, 'unsupported_input_image'],
    [{ status: 400, code: 'invalid_count' }, 'invalid_request'],
  ])('maps a %o refusal to 422 with errorCode %s', async (refusal, errorCode) => {
    validateWithScopes([ApiKeyScope.AI_GENERATE]);
    createImageJobs.mockResolvedValue({ ok: false, message: 'refused', ...refusal });
    const { req, res } = post(base);
    await handler(req, res);
    expect(res._getStatusCode()).toBe(422);
    expect(res._getJSONData()).toMatchObject({ errorCode, error: 'refused' });
  });

  it('maps a storage refusal to 400 storage_limit_exceeded with the quota detail', async () => {
    validateWithScopes([ApiKeyScope.AI_GENERATE]);
    const storage = {
      errorCode: 'storage_limit_exceeded',
      used_bytes: 900,
      limit_bytes: 1000,
      requested_bytes: 200_000,
      owner: 'user',
    };
    createImageJobs.mockResolvedValue({
      ok: false,
      status: 400,
      code: 'storage_quota_exceeded',
      message: 'full',
      storage,
    });
    const { req, res } = post(base);
    await handler(req, res);
    expect(res._getStatusCode()).toBe(400);
    expect(res._getJSONData()).toMatchObject(storage);
  });

  it('rejects a body without a prompt (422) before the domain', async () => {
    validateWithScopes([ApiKeyScope.AI_GENERATE]);
    const { req, res } = post({ model: 'test-image', mode: 'generate' });
    await handler(req, res);
    expect(res._getStatusCode()).toBe(422);
    expect(createImageJobs).not.toHaveBeenCalled();
  });

  it.each([0, 5, 1.5])('rejects count %j (422) before the domain', async count => {
    validateWithScopes([ApiKeyScope.AI_GENERATE]);
    const { req, res } = post({ ...base, count });
    await handler(req, res);
    expect(res._getStatusCode()).toBe(422);
    expect(createImageJobs).not.toHaveBeenCalled();
  });

  it('rejects an unknown key (422), naming it', async () => {
    validateWithScopes([ApiKeyScope.AI_GENERATE]);
    const { req, res } = post({ ...base, callbackUrl: 'https://example.com/hook' });
    await handler(req, res);
    expect(res._getStatusCode()).toBe(422);
    expect(res._getJSONData()).toMatchObject({ error: expect.stringContaining('Unrecognized key: "callbackUrl"') });
    expect(createImageJobs).not.toHaveBeenCalled();
  });

  it('rejects camelCase field names (422) rather than silently dropping them', async () => {
    validateWithScopes([ApiKeyScope.AI_GENERATE]);
    const { req, res } = post({ ...base, aspectRatio: '1:1' });
    await handler(req, res);
    expect(res._getStatusCode()).toBe(422);
    expect(createImageJobs).not.toHaveBeenCalled();
  });
});

describe('GET /api/v1/image-jobs', () => {
  beforeEach(resetHarness);
  const id = (n: number) => `664f1c2b9a1e4d0012ab34${n.toString(16).padStart(2, '0')}`;
  const list = (query: Record<string, string> = {}) => fire({ url: '/api/v1/image-jobs', query });
  const forgeCursor = (after: string, scope = 'v1.image-jobs') =>
    Buffer.from(JSON.stringify({ v: 1, s: scope, after }), 'utf8').toString('base64url');

  it('rejects a key lacking ai:generate (403) before listing', async () => {
    validateWithScopes([ApiKeyScope.READ_FILES]);
    const { req, res } = list();
    await handler(req, res);
    expect(res._getStatusCode()).toBe(403);
    expect(h.listByRequester).not.toHaveBeenCalled();
  });

  it('pages newest first across two pages with an opaque cursor, asking only for image jobs', async () => {
    validateWithScopes([ApiKeyScope.AI_GENERATE]);
    h.listByRequester
      .mockResolvedValueOnce([imageJob({ id: id(3) }), imageJob({ id: id(2) }), imageJob({ id: id(1) })])
      .mockResolvedValueOnce([imageJob({ id: id(1) })]);

    const first = list({ limit: '2' });
    await handler(first.req, first.res);
    const page1 = first.res._getJSONData();
    expect(page1.data.map((job: { id: string }) => job.id)).toEqual([id(3), id(2)]);
    expect(page1.data[0].object).toBe('image_generation');
    expect(page1.next_cursor).toEqual(expect.any(String));
    expect(h.listByRequester).toHaveBeenLastCalledWith({
      requestedBy: 'user-1',
      kind: 'image',
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

  it('422s a malformed cursor, a non-ObjectId cursor, a music-scoped cursor and an unknown state', async () => {
    validateWithScopes([ApiKeyScope.AI_GENERATE]);
    for (const query of [
      { cursor: 'garbage' },
      { cursor: forgeCursor('not-an-object-id') },
      { cursor: forgeCursor(id(1), 'v1.music-generations') },
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

describe('POST /api/v1/image-jobs with a completion run', () => {
  beforeEach(resetHarness);
  const RUN_ID = '0b6f3c1e-8a52-4c4e-9d55-3f0a6f2c7d11';
  const runBody = { runId: RUN_ID, role: 'worker' as const, taskId: 'task-1' };
  const attribution = { ...runBody, purpose: 'tool' as const };

  it("bills the run's account and hands the run attribution to the domain", async () => {
    validateWithScopes([ApiKeyScope.AI_GENERATE]);
    paidCallRun.resolve.mockResolvedValueOnce({ attribution, billingOrganizationId: 'run-org' });
    createImageJobs.mockResolvedValue(okResult());
    const { req, res } = post({ ...base, run: runBody });
    await handler(req, res);
    expect(res._getStatusCode()).toBe(202);
    expect(paidCallRun.resolve).toHaveBeenCalledWith(expect.anything(), runBody, undefined);
    expect(h.resolveBillingOrgId).not.toHaveBeenCalled();
    const input = createImageJobs.mock.calls[0][0];
    expect(input.user).toMatchObject({ id: 'user-1', organizationId: 'run-org' });
    expect(input.run).toEqual(attribution);
  });

  it('passes organization_id to the run check, which refuses a different account (403)', async () => {
    validateWithScopes([ApiKeyScope.AI_GENERATE]);
    paidCallRun.resolve.mockRejectedValueOnce(
      new ForbiddenError('This run bills a different account', { errorCode: 'billing_organization_mismatch' })
    );
    const { req, res } = post({ ...base, run: runBody, organization_id: null });
    await handler(req, res);
    expect(res._getStatusCode()).toBe(403);
    expect(paidCallRun.resolve).toHaveBeenCalledWith(expect.anything(), runBody, null);
    expect(createImageJobs).not.toHaveBeenCalled();
  });

  it("refuses another caller's run (404) before creating a job", async () => {
    validateWithScopes([ApiKeyScope.AI_GENERATE]);
    paidCallRun.resolve.mockRejectedValueOnce(new NotFoundError('Run not found', { errorCode: 'run_not_found' }));
    const { req, res } = post({ ...base, run: runBody });
    await handler(req, res);
    expect(res._getStatusCode()).toBe(404);
    expect(res._getJSONData()).toMatchObject({ errorCode: 'run_not_found' });
    expect(createImageJobs).not.toHaveBeenCalled();
  });

  it('answers 422 run_budget_exhausted when the jobs do not fit the run', async () => {
    validateWithScopes([ApiKeyScope.AI_GENERATE]);
    createImageJobs.mockRejectedValue(
      new UnprocessableEntityError('run budget used up', { errorCode: 'run_budget_exhausted' })
    );
    const { req, res } = post({ ...base, run: runBody });
    await handler(req, res);
    expect(res._getStatusCode()).toBe(422);
    expect(res._getJSONData()).toMatchObject({ errorCode: 'run_budget_exhausted' });
  });

  it('sends no run to the domain when none is given', async () => {
    validateWithScopes([ApiKeyScope.AI_GENERATE]);
    createImageJobs.mockResolvedValue(okResult());
    const { req, res } = post(base);
    await handler(req, res);
    expect(res._getStatusCode()).toBe(202);
    expect(createImageJobs.mock.calls[0][0]).not.toHaveProperty('run');
  });
});
