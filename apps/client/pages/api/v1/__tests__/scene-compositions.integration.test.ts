// @vitest-environment node
/**
 * Integration test for POST and GET /api/v1/scene-compositions through the real next-connect chain
 * (nextRouteForContract -> apiKeyAuth -> scope check -> validation -> handler). The domain
 * (createSceneCompositionJob) and the repository are mocked: their behaviour is covered in services and database.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiKeyScope } from '@bike4mind/common';
import {
  asUser,
  fire,
  h,
  JOB_ID,
  resetHarness,
  sceneJob,
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
vi.mock('@bike4mind/services/sceneJobs', async orig =>
  (await import('@server/generations/__test__/routeHarness')).sceneJobsServiceMock(orig)
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

import handler from '../scene-compositions/index';

const VIDEO_ID = 'a'.repeat(24);
const AUDIO_ID = 'b'.repeat(24);

const post = (body: Record<string, unknown>, headers: Record<string, string> = {}) =>
  fire({ method: 'POST', url: '/api/v1/scene-compositions', body, headers });

describe('POST /api/v1/scene-compositions', () => {
  beforeEach(resetHarness);

  it('rejects a key lacking ai:generate (403) before creating a job', async () => {
    validateWithScopes([ApiKeyScope.READ_FILES]);
    const { req, res } = post({ video_file_id: VIDEO_ID, audio_file_id: AUDIO_ID });
    await handler(req, res);
    expect(res._getStatusCode()).toBe(403);
    expect(h.createSceneCompositionJob).not.toHaveBeenCalled();
  });

  it('returns 202 with the job and passes only the fields the caller sent', async () => {
    validateWithScopes([ApiKeyScope.AI_GENERATE]);
    h.createSceneCompositionJob.mockResolvedValue({ ok: true, job: sceneJob(), created: true });
    const { req, res } = post({ video_file_id: VIDEO_ID, audio_file_id: AUDIO_ID });
    await handler(req, res);
    expect(res._getStatusCode()).toBe(202);
    expect(res._getJSONData()).toMatchObject({
      id: JOB_ID,
      object: 'scene_composition',
      state: 'pending',
      video_file_id: VIDEO_ID,
      audio_file_id: AUDIO_ID,
      cover_file_id: null,
      title: null,
      audio: { fit: 'trim', fade_in_seconds: 0, fade_out_seconds: 1.5 },
      output: null,
    });
    expect(h.createSceneCompositionJob).toHaveBeenCalledWith(
      {
        user: { id: 'user-1', organizationId: null },
        source: 'api',
        request: { videoFileId: VIDEO_ID, audioFileId: AUDIO_ID },
        apiKeyId: 'k1',
      },
      expect.anything()
    );
  });

  it('maps snake_case fields onto the domain request and lowercases the file ids', async () => {
    validateWithScopes([ApiKeyScope.AI_GENERATE]);
    h.createSceneCompositionJob.mockResolvedValue({ ok: true, job: sceneJob(), created: true });
    const { req, res } = post({
      video_file_id: 'A'.repeat(24),
      audio_file_id: AUDIO_ID,
      cover_file_id: 'C'.repeat(24),
      audio: { fit: 'loop', fade_in_seconds: 1, fade_out_seconds: 2.5 },
      title: 'Sunrise',
    });
    await handler(req, res);
    expect(res._getStatusCode()).toBe(202);
    expect(h.createSceneCompositionJob.mock.calls[0][0].request).toEqual({
      videoFileId: VIDEO_ID,
      audioFileId: AUDIO_ID,
      coverFileId: 'c'.repeat(24),
      audio: { fit: 'loop', fadeInSeconds: 1, fadeOutSeconds: 2.5 },
      title: 'Sunrise',
    });
  });

  it('namespaces the Idempotency-Key per source and user', async () => {
    validateWithScopes([ApiKeyScope.AI_GENERATE]);
    h.createSceneCompositionJob.mockResolvedValue({ ok: true, job: sceneJob(), created: false });
    const { req, res } = post({ video_file_id: VIDEO_ID, audio_file_id: AUDIO_ID }, { 'idempotency-key': 'retry-1' });
    await handler(req, res);
    expect(res._getStatusCode()).toBe(202);
    expect(h.createSceneCompositionJob.mock.calls[0][0].idempotencyKey).toBe('api:user-1:retry-1');
  });

  it('labels a session caller studio', async () => {
    h.createSceneCompositionJob.mockResolvedValue({
      ok: true,
      job: sceneJob({ requestedBy: 'jwt-user', source: 'studio' }),
      created: true,
    });
    const { req, res } = fire({
      method: 'POST',
      url: '/api/v1/scene-compositions',
      apiKey: null,
      body: { video_file_id: VIDEO_ID, audio_file_id: AUDIO_ID },
      headers: { 'idempotency-key': 'ui-1' },
    });
    await handler(req, res);
    expect(res._getStatusCode()).toBe(202);
    expect(h.createSceneCompositionJob.mock.calls[0][0]).toMatchObject({
      source: 'studio',
      idempotencyKey: 'studio:jwt-user:ui-1',
    });
  });

  it('maps an unreadable input to 404 input_file_not_found', async () => {
    validateWithScopes([ApiKeyScope.AI_GENERATE]);
    h.createSceneCompositionJob.mockResolvedValue({
      ok: false,
      status: 404,
      code: 'input_file_not_found',
      message: 'Input file not found (audio)',
      slot: 'audio',
    });
    const { req, res } = post({ video_file_id: VIDEO_ID, audio_file_id: AUDIO_ID });
    await handler(req, res);
    expect(res._getStatusCode()).toBe(404);
    expect(res._getJSONData()).toMatchObject({ errorCode: 'input_file_not_found' });
  });

  it.each(['unsupported_input', 'limit_exceeded', 'idempotency_key_reused'] as const)(
    'maps a %s refusal to 422 with its code',
    async code => {
      validateWithScopes([ApiKeyScope.AI_GENERATE]);
      h.createSceneCompositionJob.mockResolvedValue({ ok: false, status: 422, code, message: 'no' });
      const { req, res } = post({ video_file_id: VIDEO_ID, audio_file_id: AUDIO_ID });
      await handler(req, res);
      expect(res._getStatusCode()).toBe(422);
      expect(res._getJSONData()).toMatchObject({ errorCode: code });
    }
  );

  it('maps a storage refusal to 400 with the quota detail', async () => {
    validateWithScopes([ApiKeyScope.AI_GENERATE]);
    const storage = {
      errorCode: 'storage_limit_exceeded',
      used_bytes: 900,
      limit_bytes: 1000,
      requested_bytes: 200_000,
      owner: 'user',
    };
    h.createSceneCompositionJob.mockResolvedValue({
      ok: false,
      status: 400,
      code: 'storage_quota_exceeded',
      message: 'full',
      storage,
    });
    const { req, res } = post({ video_file_id: VIDEO_ID, audio_file_id: AUDIO_ID });
    await handler(req, res);
    expect(res._getStatusCode()).toBe(400);
    expect(res._getJSONData()).toMatchObject(storage);
  });

  it.each([
    ['a missing audio_file_id', { video_file_id: VIDEO_ID }],
    ['a malformed file id', { video_file_id: 'nope', audio_file_id: AUDIO_ID }],
    ['an unknown fit', { video_file_id: VIDEO_ID, audio_file_id: AUDIO_ID, audio: { fit: 'stretch' } }],
    ['a fade over 10 seconds', { video_file_id: VIDEO_ID, audio_file_id: AUDIO_ID, audio: { fade_out_seconds: 11 } }],
    ['camelCase field names', { videoFileId: VIDEO_ID, audioFileId: AUDIO_ID }],
  ])('rejects %s (422) before the domain', async (_label, body) => {
    validateWithScopes([ApiKeyScope.AI_GENERATE]);
    const { req, res } = post(body);
    await handler(req, res);
    expect(res._getStatusCode()).toBe(422);
    expect(h.createSceneCompositionJob).not.toHaveBeenCalled();
  });
});

describe('GET /api/v1/scene-compositions', () => {
  beforeEach(resetHarness);
  const id = (n: number) => `664f1c2b9a1e4d0012ab34${n.toString(16).padStart(2, '0')}`;
  const list = (query: Record<string, string> = {}) => fire({ url: '/api/v1/scene-compositions', query });
  const forgeCursor = (after: string, scope: string) =>
    Buffer.from(JSON.stringify({ v: 1, s: scope, after }), 'utf8').toString('base64url');

  it('rejects a key lacking ai:generate (403) before listing', async () => {
    validateWithScopes([ApiKeyScope.READ_FILES]);
    const { req, res } = list();
    await handler(req, res);
    expect(res._getStatusCode()).toBe(403);
    expect(h.listByRequester).not.toHaveBeenCalled();
  });

  it('pages newest first, asking only for the caller compose jobs', async () => {
    validateWithScopes([ApiKeyScope.AI_GENERATE]);
    h.listByRequester.mockResolvedValueOnce([
      sceneJob({ id: id(3) }),
      sceneJob({ id: id(2) }),
      sceneJob({ id: id(1) }),
    ]);
    const { req, res } = list({ limit: '2' });
    await handler(req, res);
    const page = res._getJSONData();
    expect(page.data.map((job: { id: string }) => job.id)).toEqual([id(3), id(2)]);
    expect(page.next_cursor).toEqual(expect.any(String));
    expect(h.listByRequester).toHaveBeenLastCalledWith({
      requestedBy: 'user-1',
      kind: 'compose',
      state: undefined,
      source: undefined,
      beforeId: undefined,
      limit: 3,
    });
  });

  it('422s a cursor minted for another resource', async () => {
    validateWithScopes([ApiKeyScope.AI_GENERATE]);
    const { req, res } = list({ cursor: forgeCursor(id(1), 'v1.music-generations') });
    await handler(req, res);
    expect(res._getStatusCode()).toBe(422);
    expect(h.listByRequester).not.toHaveBeenCalled();
  });

  it("never returns another member's jobs", async () => {
    validateWithScopes([ApiKeyScope.AI_GENERATE], 'member-a');
    asUser('member-a', 'org-1');
    h.listByRequester.mockResolvedValue([]);
    const { req, res } = list();
    await handler(req, res);
    expect(h.listByRequester).toHaveBeenCalledWith(expect.objectContaining({ requestedBy: 'member-a' }));
  });
});
