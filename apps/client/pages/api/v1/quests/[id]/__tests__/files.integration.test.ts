// @vitest-environment node
/**
 * GET /api/v1/quests/{id}/files through the REAL baseApi chain (apiKeyAuth included): the scope gate
 * (notebooks:read, ai:chat or ai:generate), the 404s, and the allowlist projection of each file.
 * fabFilesService.listFabFilesByQuest is mocked; its access rules are covered in b4m-core/services.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'events';
import { createMocks } from 'node-mocks-http';

const { mockValidate, mockFindUser, mockRateLimit, mockListByQuest } = vi.hoisted(() => ({
  mockValidate: vi.fn(),
  mockFindUser: vi.fn(),
  mockRateLimit: vi.fn(),
  mockListByQuest: vi.fn(),
}));

vi.mock('@server/utils/apiKeyRateLimitCheck', async orig => ({
  ...(await orig<Record<string, unknown>>()),
  checkApiKeyRateLimit: (...a: unknown[]) => mockRateLimit(...a),
}));
vi.mock('@server/utils/analyticsLog', () => ({
  logEvent: vi.fn().mockResolvedValue(undefined),
  logEventSafe: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('@server/utils/storage', () => ({ getFilesStorage: vi.fn() }));

vi.mock('@bike4mind/services', async orig => {
  const actual = await orig<Record<string, unknown>>();
  return {
    ...actual,
    userApiKeyService: {
      ...(actual.userApiKeyService as object),
      validateUserApiKey: (...a: unknown[]) => mockValidate(...a),
    },
    fabFilesService: {
      ...(actual.fabFilesService as object),
      listFabFilesByQuest: (...a: unknown[]) => mockListByQuest(...a),
    },
  };
});

vi.mock('@bike4mind/database', async orig => {
  const actual = await orig<Record<string, unknown>>();
  const RealUser = actual.User as Record<string, unknown>;
  return {
    ...actual,
    connectDB: vi.fn().mockResolvedValue(undefined),
    User: Object.assign(Object.create(RealUser), { findById: (...a: unknown[]) => mockFindUser(...a) }),
    userRepository: { findById: (...a: unknown[]) => mockFindUser(...a) },
  };
});

vi.mock('@server/auth/auth', async orig => ({
  ...(await orig<Record<string, unknown>>()),
  // any: node-mocks-http req/res aren't structurally the Express types this seam is typed for.
  auth: (_req: any, _res: any, next: any) => next(),
}));

import { ApiKeyScope, ListQuestFilesResponseSchema, NotFoundError } from '@bike4mind/common';
import handler from '../files';

const QUEST_ID = '65a000000000000000000001';
const FILE = {
  id: '65a000000000000000000002',
  fileName: 'chart.png',
  mimeType: 'image/png',
  fileSize: 10,
  moderationStatus: 'clean',
  fileUrl: 'https://cdn.example/chart.png?Signature=abc',
  fileUrlExpireAt: new Date('2026-10-09T13:00:00.000Z'),
  createdAt: new Date('2026-10-09T12:00:00.000Z'),
  // Must never reach the wire.
  userId: 'owner-1',
  users: [{ userId: 'u2', permissions: ['read'] }],
  filePath: 'private/key.png',
  tags: [{ name: 'secret' }],
};

function withScopes(scopes: ApiKeyScope[]) {
  mockValidate.mockResolvedValue({
    isValid: true,
    keyId: 'k1',
    userId: 'user-1',
    scopes,
    rateLimit: { requestsPerMinute: 60, requestsPerDay: 1000 },
  });
}

async function get(id = QUEST_ID) {
  const { req, res } = createMocks(
    {
      method: 'GET',
      url: `/api/v1/quests/${id}/files`,
      query: { id },
      headers: { 'x-api-key': 'sk-test-valid-key' },
    } as never,
    { eventEmitter: EventEmitter }
  );
  // any: the handler's Express-typed params vs node-mocks-http mocks.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await (handler as any)(req, res);
  return res;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockFindUser.mockResolvedValue({ id: 'user-1', _id: 'user-1', groups: [], isBanned: false, disputePending: false });
  mockRateLimit.mockResolvedValue({ allowed: true, retryAfter: undefined, headers: {} });
  mockListByQuest.mockResolvedValue([FILE]);
});

describe('GET /api/v1/quests/{id}/files', () => {
  it.each([[ApiKeyScope.READ_NOTEBOOKS], [ApiKeyScope.AI_CHAT], [ApiKeyScope.AI_GENERATE]])(
    'a %s key gets the allowlisted files',
    async scope => {
      withScopes([scope]);

      const res = await get();

      expect(res._getStatusCode()).toBe(200);
      const body = res._getJSONData();
      expect(ListQuestFilesResponseSchema.safeParse(body).success).toBe(true);
      expect(Object.keys(body)).toEqual(['files']);
      expect(Object.keys(body.files[0]).sort()).toEqual(
        [
          'created_at',
          'download_url',
          'download_url_expires_at',
          'file_name',
          'file_size',
          'id',
          'mime_type',
          'moderation_status',
        ].sort()
      );
      expect(body.files[0].download_url).toBe(FILE.fileUrl);
      expect(res.getHeader('Cache-Control')).toBe('private, no-store');
      // Part of the chat-reply poll: a read costs no daily slot.
      expect(mockRateLimit.mock.calls[0][3]).toMatchObject({ meterDailyLimit: false });
      expect(mockListByQuest).toHaveBeenCalledWith('user-1', { questId: QUEST_ID }, expect.anything());
    }
  );

  it('a key with none of the three scopes is refused (403)', async () => {
    withScopes([ApiKeyScope.READ_FILES]);

    expect((await get())._getStatusCode()).toBe(403);
    expect(mockListByQuest).not.toHaveBeenCalled();
  });

  it('an invalid key is refused (401)', async () => {
    mockValidate.mockResolvedValue({ isValid: false });

    expect((await get())._getStatusCode()).toBe(401);
  });

  it('a malformed id is a 404 without a lookup', async () => {
    withScopes([ApiKeyScope.READ_NOTEBOOKS]);

    expect((await get('not-an-id'))._getStatusCode()).toBe(404);
    expect(mockListByQuest).not.toHaveBeenCalled();
  });

  it("another user's quest is a 404", async () => {
    withScopes([ApiKeyScope.READ_NOTEBOOKS]);
    mockListByQuest.mockRejectedValue(new NotFoundError('Quest not found'));

    expect((await get())._getStatusCode()).toBe(404);
  });
});
