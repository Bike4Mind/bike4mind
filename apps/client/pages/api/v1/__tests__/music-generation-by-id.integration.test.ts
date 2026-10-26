// @vitest-environment node
/**
 * Integration test for GET /api/v1/music-generations/{id} and POST .../cancel through the real next-connect chain
 * (nextRouteForContract -> apiKeyAuth -> scope check -> validation -> handler). The repository and the
 * generation-job engine are mocked: their behaviour is covered in services and database.
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
  videoJob,
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

import getHandler from '../music-generations/[id]/index';
import cancelHandler from '../music-generations/[id]/cancel';

const get = (id: string) => fire({ url: `/api/v1/music-generations/${id}`, query: { id } });
const cancel = (id: string) =>
  fire({ method: 'POST', url: `/api/v1/music-generations/${id}/cancel`, query: { id }, body: {} });

const succeededJob = () =>
  musicJob({
    state: 'succeeded',
    payload: {
      ...musicJob().payload,
      output: {
        location: 'files',
        s3Key: 'k.mp3',
        fileId: 'f1',
        contentType: 'audio/mpeg',
        bytes: 1,
        durationSeconds: 5,
        lyrics: 'la la la',
      },
    },
  });

describe('GET /api/v1/music-generations/{id}', () => {
  beforeEach(() => {
    resetHarness();
    validateWithScopes([ApiKeyScope.AI_GENERATE]);
  });

  it('returns the caller own job', async () => {
    h.findById.mockResolvedValue(musicJob());
    const { req, res } = get(JOB_ID);
    await getHandler(req, res);
    expect(res._getStatusCode()).toBe(200);
    expect(res._getJSONData()).toMatchObject({
      id: JOB_ID,
      object: 'music_generation',
      state: 'pending',
      model: 'test-music',
      instrumental: false,
      output: null,
    });
  });

  it("404s another member's job in the same org", async () => {
    h.findById.mockResolvedValue(
      musicJob({ ownerType: CreditHolderType.Organization, ownerId: 'org-1', requestedBy: 'member-b' })
    );
    asUser('user-1', 'org-1');
    const { req, res } = get(JOB_ID);
    await getHandler(req, res);
    expect(res._getStatusCode()).toBe(404);
    expect(res._getJSONData()).not.toHaveProperty('prompt');
  });

  it('404s the id of a video job, even the caller own', async () => {
    h.findById.mockResolvedValue(videoJob());
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

  it('re-signs the output url on each read and returns the sung lyrics', async () => {
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
      content_type: 'audio/mpeg',
      lyrics: 'la la la',
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

describe('POST /api/v1/music-generations/{id}/cancel', () => {
  beforeEach(() => {
    resetHarness();
    validateWithScopes([ApiKeyScope.AI_GENERATE]);
  });

  it('requests cancellation of a pending job and returns it', async () => {
    h.findById.mockResolvedValue(musicJob({ state: 'pending' }));
    h.requestCancel.mockResolvedValue({
      status: 'requested',
      job: musicJob({ state: 'pending', cancelRequested: true }),
    });
    const { req, res } = cancel(JOB_ID);
    await cancelHandler(req, res);
    expect(res._getStatusCode()).toBe(200);
    expect(h.requestCancel).toHaveBeenCalledWith(expect.objectContaining({ id: JOB_ID, kind: 'music' }));
    expect(res._getJSONData()).toMatchObject({ id: JOB_ID, object: 'music_generation', state: 'pending' });
  });

  it('409s not_cancellable for a song already rendering at the provider', async () => {
    h.findById.mockResolvedValue(musicJob({ state: 'running' }));
    h.requestCancel.mockResolvedValue({ status: 'not_cancellable', job: musicJob({ state: 'running' }) });
    const { req, res } = cancel(JOB_ID);
    await cancelHandler(req, res);
    expect(res._getStatusCode()).toBe(409);
    expect(res._getJSONData()).toMatchObject({ error: expect.any(String), errorCode: 'not_cancellable' });
  });

  it('returns the job as read when the engine declines the cancel', async () => {
    h.findById.mockResolvedValue(musicJob({ state: 'storing', updatedAt: new Date('2026-10-06T00:05:00Z') }));
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

  it("404s cancel of another user's job and of a video job", async () => {
    for (const job of [musicJob({ requestedBy: 'someone-else' }), videoJob()]) {
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
