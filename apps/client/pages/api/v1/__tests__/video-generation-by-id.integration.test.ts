// @vitest-environment node
/**
 * Integration test for GET /api/v1/video-generations/{id} and POST .../cancel through the real next-connect chain
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
vi.mock('@bike4mind/database', async orig =>
  (await import('@server/videoGenerations/__test__/routeHarness')).databaseMock(orig)
);
vi.mock('@server/generationJobs/wiring', async () =>
  (await import('@server/videoGenerations/__test__/routeHarness')).wiringMock()
);
vi.mock('@server/videoGenerations/signOutputUrl', async () =>
  (await import('@server/videoGenerations/__test__/routeHarness')).signOutputUrlMock()
);
vi.mock('@server/auth/auth', async orig =>
  (await import('@server/videoGenerations/__test__/routeHarness')).authMock(orig)
);

import getHandler from '../video-generations/[id]/index';
import cancelHandler from '../video-generations/[id]/cancel';

const get = (id: string) => fire({ url: `/api/v1/video-generations/${id}`, query: { id } });
const cancel = (id: string) =>
  fire({ method: 'POST', url: `/api/v1/video-generations/${id}/cancel`, query: { id }, body: {} });

describe('GET /api/v1/video-generations/{id}', () => {
  beforeEach(() => {
    resetHarness();
    validateWithScopes([ApiKeyScope.AI_GENERATE]);
  });

  it('returns the caller own job', async () => {
    h.findById.mockResolvedValue(videoJob());
    const { req, res } = get(JOB_ID);
    await getHandler(req, res);
    expect(res._getStatusCode()).toBe(200);
    expect(res._getJSONData()).toMatchObject({ id: JOB_ID, state: 'pending', output: null });
  });

  it("404s another member's job in the same org", async () => {
    h.findById.mockResolvedValue(
      videoJob({ ownerType: CreditHolderType.Organization, ownerId: 'org-1', requestedBy: 'member-b' })
    );
    asUser('user-1', 'org-1');
    const { req, res } = get(JOB_ID);
    await getHandler(req, res);
    expect(res._getStatusCode()).toBe(404);
    expect(res._getJSONData()).not.toHaveProperty('prompt');
  });

  it('404s a malformed id without querying', async () => {
    const { req, res } = get('nope');
    await getHandler(req, res);
    expect(res._getStatusCode()).toBe(404);
    expect(h.findById).not.toHaveBeenCalled();
  });

  it('re-signs the output url on each read', async () => {
    const done = videoJob({
      state: 'succeeded',
      payload: {
        ...videoJob().payload,
        output: {
          location: 'files',
          s3Key: 'k.mp4',
          fileId: 'f1',
          contentType: 'video/mp4',
          bytes: 1,
          durationSeconds: 6,
        },
      },
    });
    h.findById.mockResolvedValue(done);
    let signCount = 0;
    h.sign.mockImplementation(async () => `https://signed.example/${++signCount}`);
    const first = get(JOB_ID);
    await getHandler(first.req, first.res);
    const second = get(JOB_ID);
    await getHandler(second.req, second.res);
    expect(first.res._getJSONData().output.url).not.toBe(second.res._getJSONData().output.url);
    expect(h.sign).toHaveBeenCalledTimes(2);
  });

  it('403s a key without ai:generate', async () => {
    validateWithScopes([ApiKeyScope.READ_FILES]);
    const { req, res } = get(JOB_ID);
    await getHandler(req, res);
    expect(res._getStatusCode()).toBe(403);
  });
});

describe('POST /api/v1/video-generations/{id}/cancel', () => {
  beforeEach(() => {
    resetHarness();
    validateWithScopes([ApiKeyScope.AI_GENERATE]);
  });

  it('requests cancellation of a running job and returns it', async () => {
    h.findById.mockResolvedValue(videoJob({ state: 'running' }));
    h.requestCancel.mockResolvedValue(videoJob({ state: 'running', cancelRequested: true }));
    const { req, res } = cancel(JOB_ID);
    await cancelHandler(req, res);
    expect(res._getStatusCode()).toBe(200);
    expect(h.requestCancel).toHaveBeenCalledWith(JOB_ID);
    expect(res._getJSONData()).toMatchObject({ id: JOB_ID, state: 'running' });
  });

  it('cancel during storing returns 200 with the job as-is and does not mark cancelRequested', async () => {
    const storing = videoJob({ state: 'storing' });
    h.findById.mockResolvedValue(storing);
    h.requestCancel.mockResolvedValue(null);
    const { req, res } = cancel(JOB_ID);
    await cancelHandler(req, res);
    expect(res._getStatusCode()).toBe(200);
    expect(res._getJSONData()).toMatchObject({ state: 'storing', error: null });
    expect(h.requestCancel).toHaveBeenCalledTimes(1);
    expect(storing.cancelRequested).toBe(false);
  });

  it("404s cancel of another user's job", async () => {
    h.findById.mockResolvedValue(videoJob({ requestedBy: 'someone-else' }));
    const { req, res } = cancel(JOB_ID);
    await cancelHandler(req, res);
    expect(res._getStatusCode()).toBe(404);
    expect(h.requestCancel).not.toHaveBeenCalled();
  });
});
