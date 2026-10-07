// @vitest-environment node
/**
 * The integrator flow editImageContract's description documents, end to end across the real
 * route handlers and the API-key chain nextRouteForContract assembles: upload the mask and a reference with POST /api/v1/files,
 * poll GET /api/v1/files/{id} to `clean`, pass the ids (and the source's `download_url`) to
 * POST /api/v1/image-edits, then read the output from `files[].url` on GET /api/v1/quests/{id}.
 *
 * Only the service seams are stubbed (presign, FabFile lookup, the edit queue, the quest and
 * session reads); each has its own coverage. What this pins is that the published shapes chain:
 * the ids one contract returns are accepted where the next one documents them.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import { createMocks } from 'node-mocks-http';
import { ApiKeyScope } from '@bike4mind/common';

const {
  mockValidate,
  mockUserFindById,
  mockRateLimit,
  mockCreatePresignedUpload,
  mockLoadAccessibleFabFile,
  mockInvoke,
  mockQuestFindById,
  mockSessionFindById,
} = vi.hoisted(() => ({
  mockValidate: vi.fn(),
  mockUserFindById: vi.fn(),
  mockRateLimit: vi.fn(),
  mockCreatePresignedUpload: vi.fn(),
  mockLoadAccessibleFabFile: vi.fn(),
  mockInvoke: vi.fn(),
  mockQuestFindById: vi.fn(),
  mockSessionFindById: vi.fn(),
}));

vi.mock('@server/utils/apiKeyRateLimitCheck', async orig => ({
  ...(await orig<Record<string, unknown>>()),
  checkApiKeyRateLimit: (...a: unknown[]) => mockRateLimit(...a),
}));
vi.mock('@server/utils/analyticsLog', () => ({ logEvent: vi.fn().mockResolvedValue(undefined) }));
vi.mock('@server/middlewares/rateLimit', () => ({
  rateLimit: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));
vi.mock('@server/utils/userRateTier', () => ({ resolveUserRateLimitPerMin: () => 60 }));

vi.mock('@bike4mind/services', async orig => {
  const actual = await orig<Record<string, unknown>>();
  return {
    ...actual,
    userApiKeyService: {
      ...(actual.userApiKeyService as object),
      validateUserApiKey: (...a: unknown[]) => mockValidate(...a),
    },
  };
});

vi.mock('@bike4mind/database', async orig => {
  const actual = await orig<Record<string, unknown>>();
  const RealUser = actual.User as Record<string, unknown>;
  return {
    ...actual,
    connectDB: vi.fn().mockResolvedValue(undefined),
    User: Object.assign(Object.create(RealUser), { findById: (...a: unknown[]) => mockUserFindById(...a) }),
    questRepository: {
      ...(actual.questRepository as object),
      findById: (...a: unknown[]) => mockQuestFindById(...a),
      settleIfUnfinished: vi.fn(),
    },
    sessionRepository: {
      ...(actual.sessionRepository as object),
      findById: (...a: unknown[]) => mockSessionFindById(...a),
    },
  };
});

vi.mock('@server/files/createPresignedUpload', () => ({
  createPresignedUpload: mockCreatePresignedUpload,
  PRESIGNED_UPLOAD_EXPIRES_IN: 600,
}));
vi.mock('@server/files/loadAccessibleFabFile', () => ({ loadAccessibleFabFile: mockLoadAccessibleFabFile }));
vi.mock('@server/managers/sessionManager', () => ({ getOrCreateSession: vi.fn().mockResolvedValue({}) }));
vi.mock('@server/utils/orgAccess', () => ({ resolveBillingOrgId: vi.fn().mockResolvedValue(undefined) }));
vi.mock('@server/queueHandlers/imageEdit', () => ({ getImageEdit: () => ({ invoke: mockInvoke }) }));

import uploadHandler from '../files/index';
import getFileHandler from '../files/[id]/index';
import imageEditHandler from '../image-edits';
import questHandler from '../quests/[id]/index';

const API_KEY = 'b4m_live_test';
const USER_ID = 'user-1';
const SESSION_ID = '664f1c2b9a1e4d0012ab34aa';
const QUEST_ID = '664f1c2b9a1e4d0012ab34cd';
const MASK_ID = '664f1c2b9a1e4d0012ab34bb';
const REFERENCE_ID = '664f1c2b9a1e4d0012ab34ee';
const CDN_URL = 'https://cdn.example';
const OUTPUT_NAME = '3f6c1a52-9d1e-4b7a-8c2f-5e0d4a9b1c7e.png';

type Call = { method: 'GET' | 'POST'; url: string; query?: Record<string, string>; body?: unknown };

async function call(handler: (req: unknown, res: unknown) => unknown, { method, url, query, body }: Call) {
  const { req, res } = createMocks(
    { method, url, query, body, headers: { 'x-api-key': API_KEY } },
    { eventEmitter: EventEmitter }
  );
  await handler(req, res);
  return { status: res._getStatusCode(), json: res._getJSONData() };
}

const uploadFile = (fileName: string) =>
  call(uploadHandler, {
    method: 'POST',
    url: '/api/v1/files',
    body: { file_name: fileName, mime_type: 'image/png', file_size: 482133 },
  });

const getFile = (id: string) => call(getFileHandler, { method: 'GET', url: `/api/v1/files/${id}`, query: { id } });

function fabFile(id: string, moderationStatus: 'pending' | 'clean') {
  return {
    id,
    fileName: `${id}.png`,
    mimeType: 'image/png',
    fileSize: 482133,
    moderationStatus,
    fileUrl: `${CDN_URL}/${id}.png?Signature=abc`,
    fileUrlExpireAt: new Date(Date.now() + 60_000),
    createdAt: new Date('2026-09-29T12:00:00.000Z'),
  };
}

describe('image edit from uploaded files (upload -> edit -> poll quest)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv('NEXT_PUBLIC_CDN_URL', CDN_URL);
    mockValidate.mockResolvedValue({
      isValid: true,
      keyId: 'k1',
      userId: USER_ID,
      scopes: [ApiKeyScope.WRITE_FILES, ApiKeyScope.READ_FILES, ApiKeyScope.AI_GENERATE],
      rateLimit: { requestsPerMinute: 60, requestsPerDay: 1000 },
    });
    // The real auth chain runs here (no auth stub), so the key's user must clear the AUP/ToS gate.
    mockUserFindById.mockResolvedValue({
      id: USER_ID,
      _id: USER_ID,
      isBanned: false,
      disputePending: false,
      aupAcceptedVersion: '2025-01-01',
    });
    mockRateLimit.mockResolvedValue({ allowed: true, retryAfter: undefined, headers: {} });
    mockCreatePresignedUpload
      .mockResolvedValueOnce({ url: 'https://s3.example/mask?sig', fileId: MASK_ID, fileKey: 'mask' })
      .mockResolvedValueOnce({ url: 'https://s3.example/ref?sig', fileId: REFERENCE_ID, fileKey: 'ref' });
    mockLoadAccessibleFabFile.mockImplementation(async (_req: unknown, id: string) => fabFile(id, 'clean'));
    mockInvoke.mockResolvedValue({ id: QUEST_ID, sessionId: SESSION_ID, status: 'pending', type: 'message' });
    mockSessionFindById.mockResolvedValue({ id: SESSION_ID, userId: USER_ID, users: [{ userId: USER_ID }] });
    mockQuestFindById.mockResolvedValue({
      id: QUEST_ID,
      sessionId: SESSION_ID,
      status: 'done',
      type: 'message',
      images: [OUTPUT_NAME],
      reply: {},
      replies: [],
      promptMeta: {},
    });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('chains the ids and URL each published contract hands back into the next call', async () => {
    const mask = await uploadFile('mask.png');
    const reference = await uploadFile('reference.png');
    expect([mask.status, reference.status]).toEqual([201, 201]);

    // Moderation still running: no download_url yet, so the caller keeps polling.
    mockLoadAccessibleFabFile.mockResolvedValueOnce(fabFile(mask.json.id, 'pending'));
    const pendingPoll = await getFile(mask.json.id);
    expect(pendingPoll.json).toMatchObject({ moderation_status: 'pending', download_url: null });

    const cleanMask = await getFile(mask.json.id);
    expect(cleanMask.json.moderation_status).toBe('clean');
    const cleanReference = await getFile(reference.json.id);
    expect(cleanReference.json.download_url).toEqual(expect.any(String));

    const edit = await call(imageEditHandler, {
      method: 'POST',
      url: '/api/v1/image-edits',
      body: {
        prompt: 'replace the sky with a starry night',
        model: 'gpt-image-1',
        sessionId: SESSION_ID,
        image: cleanReference.json.download_url,
        fabFileIds: [mask.json.id],
        referenceImageFabFileIds: [reference.json.id],
      },
    });
    expect(edit.status).toBe(200);
    expect(mockInvoke).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: USER_ID,
        body: expect.objectContaining({
          image: cleanReference.json.download_url,
          fabFileIds: [MASK_ID],
          referenceImageFabFileIds: [REFERENCE_ID],
        }),
      })
    );

    const poll = await call(questHandler, {
      method: 'GET',
      url: `/api/v1/quests/${edit.json.id}`,
      query: { id: edit.json.id },
    });
    expect(poll.status).toBe(200);
    expect(mockQuestFindById).toHaveBeenCalledWith(QUEST_ID);
    // The output is a generated CDN file, not a FabFile id to read back via GET /api/v1/files/{id}.
    expect(poll.json).toMatchObject({
      status: 'done',
      type: 'message',
      images: [OUTPUT_NAME],
      files: [{ name: OUTPUT_NAME, url: `${CDN_URL}/generated/${OUTPUT_NAME}`, isImage: true }],
    });
  });
});
