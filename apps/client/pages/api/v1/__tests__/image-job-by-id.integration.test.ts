// @vitest-environment node
/**
 * Integration test for GET /api/v1/image-jobs/{id} and POST .../cancel through the real next-connect chain
 * (nextRouteForContract -> apiKeyAuth -> scope check -> validation -> handler). The repository and the
 * generation-job engine are mocked: their behaviour is covered in services and database.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiKeyScope, CreditHolderType, type IGenerationJobDocument } from '@bike4mind/common';
import {
  asUser,
  fire,
  h,
  JOB_ID,
  musicJob,
  resetHarness,
  validateWithScopes,
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

import getHandler from '../image-jobs/[id]/index';
import cancelHandler from '../image-jobs/[id]/cancel';

const GROUP_ID = 'g'.repeat(24);

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

const get = (id: string) => fire({ url: `/api/v1/image-jobs/${id}`, query: { id } });
const cancel = (id: string) =>
  fire({ method: 'POST', url: `/api/v1/image-jobs/${id}/cancel`, query: { id }, body: {} });

const succeededJob = () =>
  imageJob({
    state: 'succeeded',
    payload: {
      ...imageJob().payload,
      output: { location: 'files', s3Key: 'k.png', fileId: 'f1', contentType: 'image/png', bytes: 1 },
    } as IGenerationJobDocument['payload'],
  });

describe('GET /api/v1/image-jobs/{id}', () => {
  beforeEach(() => {
    resetHarness();
    validateWithScopes([ApiKeyScope.AI_GENERATE]);
  });

  it('returns the caller own job', async () => {
    h.findById.mockResolvedValue(imageJob());
    const { req, res } = get(JOB_ID);
    await getHandler(req, res);
    expect(res._getStatusCode()).toBe(200);
    expect(res._getJSONData()).toMatchObject({
      id: JOB_ID,
      object: 'image_generation',
      state: 'pending',
      model: 'test-image',
      mode: 'generate',
      group_id: GROUP_ID,
      output: null,
    });
  });

  it("404s another member's job in the same org", async () => {
    h.findById.mockResolvedValue(
      imageJob({ ownerType: CreditHolderType.Organization, ownerId: 'org-1', requestedBy: 'member-b' })
    );
    asUser('user-1', 'org-1');
    const { req, res } = get(JOB_ID);
    await getHandler(req, res);
    expect(res._getStatusCode()).toBe(404);
    expect(res._getJSONData()).not.toHaveProperty('prompt');
  });

  it('404s the id of a music job, even the caller own', async () => {
    h.findById.mockResolvedValue(musicJob());
    const { req, res } = get(JOB_ID);
    await getHandler(req, res);
    expect(res._getStatusCode()).toBe(404);
    expect(res._getJSONData()).not.toHaveProperty('prompt');
  });

  it('404s a missing job and a malformed id, the latter without querying', async () => {
    h.findById.mockResolvedValue(null);
    const missing = get(JOB_ID);
    await getHandler(missing.req, missing.res);
    expect(missing.res._getStatusCode()).toBe(404);

    h.findById.mockClear();
    const malformed = get('nope');
    await getHandler(malformed.req, malformed.res);
    expect(malformed.res._getStatusCode()).toBe(404);
    expect(h.findById).not.toHaveBeenCalled();
  });

  it('re-signs the output url on each read', async () => {
    h.findById.mockResolvedValue(succeededJob());
    let signCount = 0;
    h.sign.mockImplementation(async () => ({ availability: 'ready', url: `https://signed.example/${++signCount}` }));
    const first = get(JOB_ID);
    await getHandler(first.req, first.res);
    const second = get(JOB_ID);
    await getHandler(second.req, second.res);
    expect(first.res._getJSONData().output.url).not.toBe(second.res._getJSONData().output.url);
    expect(first.res._getJSONData().output).toMatchObject({
      availability: 'ready',
      content_type: 'image/png',
      file_id: 'f1',
    });
    expect(h.sign).toHaveBeenCalledTimes(2);
  });

  it('tells the client to stop polling once the output can never be served', async () => {
    h.findById.mockResolvedValue(succeededJob());
    h.sign.mockResolvedValue({ availability: 'unavailable' });
    const { req, res } = get(JOB_ID);
    await getHandler(req, res);
    expect(res._getStatusCode()).toBe(200);
    expect(res._getJSONData().output).toMatchObject({ availability: 'unavailable', url: null, expires_at: null });
  });

  it('403s a key without ai:generate', async () => {
    validateWithScopes([ApiKeyScope.READ_FILES]);
    const { req, res } = get(JOB_ID);
    await getHandler(req, res);
    expect(res._getStatusCode()).toBe(403);
    expect(h.findById).not.toHaveBeenCalled();
  });
});

describe('POST /api/v1/image-jobs/{id}/cancel', () => {
  beforeEach(() => {
    resetHarness();
    validateWithScopes([ApiKeyScope.AI_GENERATE]);
  });

  it('requests cancellation of a pending job and returns it', async () => {
    h.findById.mockResolvedValue(imageJob({ state: 'pending' }));
    h.requestCancel.mockResolvedValue({
      status: 'requested',
      job: imageJob({ state: 'pending', cancelRequested: true }),
    });
    const { req, res } = cancel(JOB_ID);
    await cancelHandler(req, res);
    expect(res._getStatusCode()).toBe(200);
    expect(h.requestCancel).toHaveBeenCalledWith(expect.objectContaining({ id: JOB_ID, kind: 'image' }));
    expect(res._getJSONData()).toMatchObject({ id: JOB_ID, object: 'image_generation', state: 'pending' });
  });

  it('409s not_cancellable for an image already rendering at the provider', async () => {
    h.findById.mockResolvedValue(imageJob({ state: 'running' }));
    h.requestCancel.mockResolvedValue({ status: 'not_cancellable', job: imageJob({ state: 'running' }) });
    const { req, res } = cancel(JOB_ID);
    await cancelHandler(req, res);
    expect(res._getStatusCode()).toBe(409);
    expect(res._getJSONData()).toMatchObject({ error: expect.any(String), errorCode: 'not_cancellable' });
  });

  it('returns the job as read when the engine declines the cancel', async () => {
    h.findById.mockResolvedValue(imageJob({ state: 'storing', updatedAt: new Date('2026-10-06T00:05:00Z') }));
    h.requestCancel.mockResolvedValue({ status: 'unchanged', job: null });
    const { req, res } = cancel(JOB_ID);
    await cancelHandler(req, res);
    expect(res._getStatusCode()).toBe(200);
    expect(res._getJSONData()).toMatchObject({
      id: JOB_ID,
      state: 'storing',
      error: null,
      updated_at: '2026-10-06T00:05:00.000Z',
    });
  });

  it('404s cancel of a malformed id without querying or cancelling', async () => {
    const { req, res } = cancel('nope');
    await cancelHandler(req, res);
    expect(res._getStatusCode()).toBe(404);
    expect(h.findById).not.toHaveBeenCalled();
    expect(h.requestCancel).not.toHaveBeenCalled();
  });

  it("404s cancel of another user's job and of a music job", async () => {
    for (const job of [imageJob({ requestedBy: 'someone-else' }), musicJob()]) {
      h.findById.mockResolvedValue(job);
      const { req, res } = cancel(JOB_ID);
      await cancelHandler(req, res);
      expect(res._getStatusCode()).toBe(404);
    }
    expect(h.requestCancel).not.toHaveBeenCalled();
  });

  it('403s a key without ai:generate', async () => {
    validateWithScopes([ApiKeyScope.READ_FILES]);
    const { req, res } = cancel(JOB_ID);
    await cancelHandler(req, res);
    expect(res._getStatusCode()).toBe(403);
    expect(h.requestCancel).not.toHaveBeenCalled();
  });
});
