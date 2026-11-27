// @vitest-environment node
/**
 * Integration test for GET /api/v1/scene-compositions/{id} and POST .../cancel through the real next-connect chain
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
  sceneJob,
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
vi.mock('@bike4mind/database', async orig =>
  (await import('@server/generations/__test__/routeHarness')).databaseMock(orig)
);
vi.mock('@bike4mind/server-utils/generationJobs/wiring', async () =>
  (await import('@server/generations/__test__/routeHarness')).wiringMock()
);
vi.mock('@bike4mind/server-utils/generations/signOutputUrl', async () =>
  (await import('@server/generations/__test__/routeHarness')).signOutputUrlMock()
);
vi.mock('@server/auth/auth', async orig => (await import('@server/generations/__test__/routeHarness')).authMock(orig));

import getHandler from '../scene-compositions/[id]/index';
import cancelHandler from '../scene-compositions/[id]/cancel';

const get = (id: string) => fire({ url: `/api/v1/scene-compositions/${id}`, query: { id } });
const cancel = (id: string) =>
  fire({ method: 'POST', url: `/api/v1/scene-compositions/${id}/cancel`, query: { id }, body: {} });

const succeededJob = () =>
  sceneJob({
    state: 'succeeded',
    payload: {
      ...sceneJob().payload,
      output: {
        location: 'files',
        s3Key: 'k.mp4',
        fileId: 'f1',
        contentType: 'video/mp4',
        bytes: 1,
        durationSeconds: 12.5,
      },
    },
  });

describe('GET /api/v1/scene-compositions/{id}', () => {
  beforeEach(() => {
    resetHarness();
    validateWithScopes([ApiKeyScope.AI_GENERATE]);
  });

  it('returns the caller own job', async () => {
    h.findById.mockResolvedValue(sceneJob());
    const { req, res } = get(JOB_ID);
    await getHandler(req, res);
    expect(res._getStatusCode()).toBe(200);
    expect(res._getJSONData()).toMatchObject({
      id: JOB_ID,
      object: 'scene_composition',
      state: 'pending',
      video_file_id: 'a'.repeat(24),
      output: null,
    });
  });

  it("404s another member's job in the same org", async () => {
    h.findById.mockResolvedValue(
      sceneJob({ ownerType: CreditHolderType.Organization, ownerId: 'org-1', requestedBy: 'member-b' })
    );
    asUser('user-1', 'org-1');
    const { req, res } = get(JOB_ID);
    await getHandler(req, res);
    expect(res._getStatusCode()).toBe(404);
    expect(res._getJSONData()).not.toHaveProperty('video_file_id');
  });

  it('404s the id of a video job, even the caller own', async () => {
    h.findById.mockResolvedValue(videoJob());
    const { req, res } = get(JOB_ID);
    await getHandler(req, res);
    expect(res._getStatusCode()).toBe(404);
  });

  it('404s a malformed id without querying', async () => {
    const { req, res } = get('nope');
    await getHandler(req, res);
    expect(res._getStatusCode()).toBe(404);
    expect(h.findById).not.toHaveBeenCalled();
  });

  it('signs the rendered Scene and reports its length and file', async () => {
    h.findById.mockResolvedValue(succeededJob());
    const { req, res } = get(JOB_ID);
    await getHandler(req, res);
    expect(res._getJSONData().output).toMatchObject({
      availability: 'ready',
      url: 'https://signed.example/k.mp4',
      content_type: 'video/mp4',
      duration_seconds: 12.5,
      files_skip_reason: null,
      file_id: 'f1',
    });
  });

  it('says why a Scene stored outside Files has no file', async () => {
    const job = succeededJob();
    h.findById.mockResolvedValue({
      ...job,
      payload: {
        ...job.payload,
        output: {
          location: 'generated',
          s3Key: 'k.mp4',
          contentType: 'video/mp4',
          bytes: 1,
          durationSeconds: 12.5,
          filesSkipReason: 'file_too_large',
        },
      },
    });
    const { req, res } = get(JOB_ID);
    await getHandler(req, res);
    expect(res._getJSONData().output).toMatchObject({ files_skip_reason: 'file_too_large', file_id: null });
  });

  it('renders a failure with the fixed Scene copy, never the stored message', async () => {
    h.findById.mockResolvedValue(
      sceneJob({ state: 'failed', error: { code: 'unsupported_input', message: '/tmp/b4m-scene-x/video: moov atom' } })
    );
    const { req, res } = get(JOB_ID);
    await getHandler(req, res);
    const { error } = res._getJSONData();
    expect(error.code).toBe('unsupported_input');
    expect(error.message).not.toContain('/tmp');
  });

  it('403s a key without ai:generate', async () => {
    validateWithScopes([ApiKeyScope.READ_FILES]);
    const { req, res } = get(JOB_ID);
    await getHandler(req, res);
    expect(res._getStatusCode()).toBe(403);
    expect(h.findById).not.toHaveBeenCalled();
  });
});

describe('POST /api/v1/scene-compositions/{id}/cancel', () => {
  beforeEach(() => {
    resetHarness();
    validateWithScopes([ApiKeyScope.AI_GENERATE]);
  });

  it('requests cancellation of a pending job and returns it', async () => {
    h.findById.mockResolvedValue(sceneJob({ state: 'pending' }));
    h.requestCancel.mockResolvedValue({
      status: 'requested',
      job: sceneJob({ state: 'pending', cancelRequested: true }),
    });
    const { req, res } = cancel(JOB_ID);
    await cancelHandler(req, res);
    expect(res._getStatusCode()).toBe(200);
    expect(h.requestCancel).toHaveBeenCalledWith(expect.objectContaining({ id: JOB_ID, kind: 'compose' }));
    expect(res._getJSONData()).toMatchObject({ id: JOB_ID, object: 'scene_composition', state: 'pending' });
  });

  it('409s not_cancellable for a Scene already rendering', async () => {
    h.findById.mockResolvedValue(sceneJob({ state: 'running' }));
    h.requestCancel.mockResolvedValue({ status: 'not_cancellable', job: sceneJob({ state: 'running' }) });
    const { req, res } = cancel(JOB_ID);
    await cancelHandler(req, res);
    expect(res._getStatusCode()).toBe(409);
    expect(res._getJSONData()).toMatchObject({ errorCode: 'not_cancellable' });
  });

  it("404s cancel of another user's job and of a video job", async () => {
    for (const job of [sceneJob({ requestedBy: 'someone-else' }), videoJob()]) {
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
