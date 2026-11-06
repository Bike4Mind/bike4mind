// @vitest-environment node
/**
 * /api/v1/projects/{id}/(members|invites|system-prompts) through the REAL baseApi chain (apiKeyAuth and
 * the error handler included), so each contract's scopes reach the gate and its statuses map as
 * documented. The shared write helpers are stubbed; their behavior is covered through the SPA routes'
 * tests (pages/api/projects/[id]/__tests__) and the services' own tests.
 * Same harness shape as projectContent.scopes.integration.test.ts.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'events';
import { createMocks } from 'node-mocks-http';

const {
  mockValidate,
  mockFindUser,
  mockRateLimit,
  mockFindShareAccessById,
  mockFindInvites,
  mockOutboundGate,
  mockRemoveMember,
  mockAddPrompts,
  mockRemovePrompts,
  mockSetPrompt,
  mockCreateInvite,
} = vi.hoisted(() => ({
  mockValidate: vi.fn(),
  mockFindUser: vi.fn(),
  mockRateLimit: vi.fn(),
  mockFindShareAccessById: vi.fn(),
  mockFindInvites: vi.fn(),
  mockOutboundGate: vi.fn(),
  mockRemoveMember: vi.fn(),
  mockAddPrompts: vi.fn(),
  mockRemovePrompts: vi.fn(),
  mockSetPrompt: vi.fn(),
  mockCreateInvite: vi.fn(),
}));

vi.mock('@server/utils/apiKeyTrust', () => ({
  resolveUntrustedKeyLimits: async (_owner: unknown, key: { rateLimit: unknown }) => ({
    rateLimit: key.rateLimit,
    ownerUntrusted: false,
  }),
}));
vi.mock('@server/utils/apiKeyRateLimitCheck', async orig => ({
  ...(await orig<Record<string, unknown>>()),
  checkApiKeyRateLimit: (...a: unknown[]) => mockRateLimit(...a),
}));
vi.mock('@bike4mind/server-utils/middlewares/rateLimit', () => ({
  rateLimit: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));
vi.mock('@bike4mind/server-utils/utils/analyticsLog', () => ({
  logEvent: vi.fn().mockResolvedValue(undefined),
  logEventSafe: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('@server/auth/assertOutboundActionAllowed', async orig => ({
  ...(await orig<Record<string, unknown>>()),
  assertOutboundActionAllowed: (...a: unknown[]) => mockOutboundGate(...a),
}));
vi.mock('@server/projects/projectSharingMutations', () => ({
  removeProjectMember: (...a: unknown[]) => mockRemoveMember(...a),
  addProjectSystemPrompts: (...a: unknown[]) => mockAddPrompts(...a),
  removeProjectSystemPrompts: (...a: unknown[]) => mockRemovePrompts(...a),
  setProjectSystemPrompt: (...a: unknown[]) => mockSetPrompt(...a),
  createProjectInvite: (...a: unknown[]) => mockCreateInvite(...a),
}));

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
    User: Object.assign(Object.create(RealUser), { findById: (...a: unknown[]) => mockFindUser(...a) }),
    userRepository: { findById: (...a: unknown[]) => mockFindUser(...a) },
    projectRepository: {
      shareable: { findShareAccessById: (...a: unknown[]) => mockFindShareAccessById(...a) },
    },
    inviteRepository: { findAllByDocumentId: (...a: unknown[]) => mockFindInvites(...a) },
  };
});

vi.mock('@server/auth/auth', async orig => ({
  ...(await orig<Record<string, unknown>>()),
  // any: node-mocks-http req/res aren't structurally the Express types this seam is typed for.
  auth: (_req: any, _res: any, next: any) => next(),
}));

import { ApiKeyScope, ForbiddenError, NotFoundError, UnauthorizedError } from '@bike4mind/common';
import { CreatedProjectInviteSchema, ProjectInviteSchema, ProjectSystemPromptsResponseSchema } from '@bike4mind/common';
import memberHandler from '../members/[user_id]';
import invitesHandler from '../invites';
import promptsHandler from '../system-prompts/index';
import promptHandler from '../system-prompts/[file_id]';
import { decodeCursor } from '@server/utils/cursorPagination';

const ME = 'user-1';
const PROJECT_ID = '65a000000000000000000001';
const OTHER_USER = '65c000000000000000000009';
const FILE_ID = '65b000000000000000000002';
const PROJECT = {
  id: PROJECT_ID,
  name: 'Research',
  userId: ME,
  systemPrompts: [
    { fileId: FILE_ID, enabled: false },
    { fileId: '65b000000000000000000001', enabled: true },
  ],
};

const invite = (id: string, overrides: Record<string, unknown> = {}) => ({
  id,
  type: 'Project',
  documentId: PROJECT_ID,
  permissions: ['read'],
  recipients: { pending: ['teammate@example.com'], accepted: [], refused: [] },
  typedRecipients: ['teammate@example.com'],
  inviterId: ME,
  isLinkOnly: false,
  token: 'secret-token',
  remaining: 1,
  createdAt: new Date('2026-01-01T00:00:00.000Z'),
  ...overrides,
});

function withScopes(scopes: ApiKeyScope[]) {
  mockValidate.mockResolvedValue({
    isValid: true,
    keyId: 'k1',
    userId: ME,
    scopes,
    rateLimit: { requestsPerMinute: 60, requestsPerDay: 1000 },
  });
}

type FireInit = { method: 'GET' | 'POST' | 'PATCH' | 'DELETE'; url: string; query?: object; body?: object };

// any: the handlers' Express-typed params vs node-mocks-http mocks.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function fire(handler: any, init: FireInit) {
  const { req, res } = createMocks(
    { ...init, headers: { 'x-api-key': 'sk-test-valid-key', 'content-type': 'application/json' } } as never,
    { eventEmitter: EventEmitter }
  );
  await handler(req, res);
  return res;
}

const base = `/api/v1/projects/${PROJECT_ID}`;
const calls = {
  removeMember: (userId = OTHER_USER, id = PROJECT_ID) =>
    fire(memberHandler, { method: 'DELETE', url: `${base}/members/${userId}`, query: { id, user_id: userId } }),
  listInvites: (query: Record<string, string> = {}) =>
    fire(invitesHandler, { method: 'GET', url: `${base}/invites`, query: { id: PROJECT_ID, ...query } }),
  createInvite: (body: object = { permissions: ['read'], recipients: ['teammate@example.com'] }) =>
    fire(invitesHandler, { method: 'POST', url: `${base}/invites`, query: { id: PROJECT_ID }, body }),
  addPrompts: (body: object = { file_ids: [FILE_ID] }) =>
    fire(promptsHandler, { method: 'POST', url: `${base}/system-prompts`, query: { id: PROJECT_ID }, body }),
  updatePrompt: (body: object = { enabled: true }) =>
    fire(promptHandler, {
      method: 'PATCH',
      url: `${base}/system-prompts/${FILE_ID}`,
      query: { id: PROJECT_ID, file_id: FILE_ID },
      body,
    }),
  removePrompt: () =>
    fire(promptHandler, {
      method: 'DELETE',
      url: `${base}/system-prompts/${FILE_ID}`,
      query: { id: PROJECT_ID, file_id: FILE_ID },
    }),
};

const READS = [() => calls.listInvites()];
const WRITES = [
  () => calls.removeMember(),
  () => calls.createInvite(),
  () => calls.addPrompts(),
  () => calls.updatePrompt(),
  () => calls.removePrompt(),
];
const WRITE_HELPERS = [mockRemoveMember, mockCreateInvite, mockAddPrompts, mockSetPrompt, mockRemovePrompts];

beforeEach(() => {
  vi.clearAllMocks();
  mockFindUser.mockResolvedValue({ id: ME, _id: ME, groups: [], isBanned: false, disputePending: false });
  mockRateLimit.mockResolvedValue({ allowed: true, retryAfter: undefined, headers: {} });
  mockFindShareAccessById.mockResolvedValue(PROJECT);
  mockFindInvites.mockResolvedValue([invite('65d000000000000000000001')]);
  mockOutboundGate.mockResolvedValue(undefined);
  mockRemoveMember.mockResolvedValue(PROJECT);
  mockAddPrompts.mockResolvedValue(PROJECT);
  mockRemovePrompts.mockResolvedValue(PROJECT);
  mockSetPrompt.mockResolvedValue(PROJECT);
  mockCreateInvite.mockImplementation(async () => {
    const { token: _token, typedRecipients: _typed, ...view } = invite('65d000000000000000000002');
    return { view, link: 'https://app.example.test/share/secret-token' };
  });
});

describe('scope enforcement', () => {
  it.each([[ApiKeyScope.READ_PROJECTS], [ApiKeyScope.WRITE_PROJECTS]])('a %s key can list invites', async scope => {
    withScopes([scope]);
    for (const read of READS) expect((await read())._getStatusCode()).toBe(200);
  });

  it('a read-only key cannot change anything (403) and no write helper runs', async () => {
    withScopes([ApiKeyScope.READ_PROJECTS]);
    for (const write of WRITES) {
      const res = await write();
      expect(res._getStatusCode()).toBe(403);
      expect(res._getJSONData().required_scopes).toEqual([ApiKeyScope.WRITE_PROJECTS]);
    }
    for (const helper of WRITE_HELPERS) expect(helper).not.toHaveBeenCalled();
  });

  it('a write key can make every change', async () => {
    withScopes([ApiKeyScope.WRITE_PROJECTS]);
    expect((await calls.removeMember())._getStatusCode()).toBe(204);
    expect((await calls.createInvite())._getStatusCode()).toBe(200);
    expect((await calls.addPrompts())._getStatusCode()).toBe(200);
    expect((await calls.updatePrompt())._getStatusCode()).toBe(200);
    expect((await calls.removePrompt())._getStatusCode()).toBe(204);
  });

  it('a key without a project scope can do none of it (403)', async () => {
    withScopes([ApiKeyScope.READ_NOTEBOOKS]);
    for (const call of [...READS, ...WRITES]) expect((await call())._getStatusCode()).toBe(403);
    expect(mockFindShareAccessById).not.toHaveBeenCalled();
    for (const helper of WRITE_HELPERS) expect(helper).not.toHaveBeenCalled();
  });

  it('an invalid key is refused (401) before any handler runs', async () => {
    mockValidate.mockResolvedValue({ isValid: false });
    for (const call of [...READS, ...WRITES]) expect((await call())._getStatusCode()).toBe(401);
    expect(mockFindShareAccessById).not.toHaveBeenCalled();
  });
});

describe('DELETE /api/v1/projects/{id}/members/{user_id}', () => {
  beforeEach(() => withScopes([ApiKeyScope.WRITE_PROJECTS]));

  it('removes another user as the owner', async () => {
    expect((await calls.removeMember(OTHER_USER))._getStatusCode()).toBe(204);
    expect(mockRemoveMember).toHaveBeenCalledWith(
      expect.objectContaining({ user: expect.anything() }),
      PROJECT_ID,
      OTHER_USER
    );
  });

  it('leaves the project when the caller names themselves', async () => {
    expect((await calls.removeMember(ME))._getStatusCode()).toBe(204);
    expect(mockRemoveMember).toHaveBeenCalledWith(expect.anything(), PROJECT_ID, undefined);
  });

  it("answers the service's 401 refusals as 403", async () => {
    mockRemoveMember.mockRejectedValue(new UnauthorizedError('Only project owner can remove members'));
    expect((await calls.removeMember())._getStatusCode()).toBe(403);
  });

  it('answers 404 for a project it cannot see, a non-member and a malformed id', async () => {
    mockRemoveMember.mockRejectedValue(new NotFoundError('User not found in project'));
    expect((await calls.removeMember())._getStatusCode()).toBe(404);
    expect((await calls.removeMember(OTHER_USER, 'not-an-id'))._getStatusCode()).toBe(404);
  });
});

describe('/api/v1/projects/{id}/invites', () => {
  beforeEach(() => withScopes([ApiKeyScope.WRITE_PROJECTS]));

  it('lists invites without the token, in the public shape', async () => {
    const res = await calls.listInvites();

    expect(res._getStatusCode()).toBe(200);
    const body = res._getJSONData();
    expect(body.next_cursor).toBeNull();
    expect(body.data).toHaveLength(1);
    expect(ProjectInviteSchema.strict().safeParse(body.data[0]).success).toBe(true);
    expect(body.data[0].recipients.pending).toEqual(['teammate@example.com']);
    expect(JSON.stringify(body)).not.toMatch(/secret-token|typedRecipients|inviterId/);
  });

  it('pages by id and filters by recipient status', async () => {
    mockFindInvites.mockResolvedValue([
      invite('65d000000000000000000002'),
      invite('65d000000000000000000001'),
      invite('65d000000000000000000003', { recipients: { pending: [], accepted: ['a@example.com'], refused: [] } }),
      invite('65d000000000000000000004', { type: 'Session' }),
    ]);

    const first = (await calls.listInvites({ limit: '1', status: 'pending' }))._getJSONData();
    expect(first.data.map((i: { id: string }) => i.id)).toEqual(['65d000000000000000000001']);
    expect(decodeCursor(first.next_cursor, 'v1.projects.invites')).toBe('65d000000000000000000001');

    const second = (
      await calls.listInvites({ limit: '1', status: 'pending', cursor: first.next_cursor })
    )._getJSONData();
    expect(second.data.map((i: { id: string }) => i.id)).toEqual(['65d000000000000000000002']);
    expect(second.next_cursor).toBeNull();
  });

  it('answers 404 for a project the caller cannot share, and 422 for an unknown status', async () => {
    mockFindShareAccessById.mockResolvedValue(null);
    expect((await calls.listInvites())._getStatusCode()).toBe(404);
    expect(mockFindInvites).not.toHaveBeenCalled();

    mockFindShareAccessById.mockResolvedValue(PROJECT);
    expect((await calls.listInvites({ status: 'refused' }))._getStatusCode()).toBe(422);
  });

  it('creates an invite and returns its link once', async () => {
    const res = await calls.createInvite({
      permissions: ['read', 'update'],
      recipients: ['teammate@example.com'],
      description: 'hello',
      expires_at: '2999-01-01T00:00:00.000Z',
    });

    expect(res._getStatusCode()).toBe(200);
    expect(CreatedProjectInviteSchema.strict().safeParse(res._getJSONData()).success).toBe(true);
    expect(mockOutboundGate).toHaveBeenCalledTimes(1);
    expect(mockCreateInvite).toHaveBeenCalledWith(expect.anything(), PROJECT_ID, {
      permissions: ['read', 'update'],
      recipients: ['teammate@example.com'],
      description: 'hello',
      expiresAt: new Date('2999-01-01T00:00:00.000Z'),
    });
  });

  it('refuses an account the outbound gate blocks (403) before creating anything', async () => {
    mockOutboundGate.mockRejectedValue(new ForbiddenError('Outbound actions are restricted'));
    expect((await calls.createInvite())._getStatusCode()).toBe(403);
    expect(mockCreateInvite).not.toHaveBeenCalled();
  });

  it('answers 422 for a past expiry, a camelCase field or no permissions', async () => {
    for (const body of [
      { permissions: ['read'], expires_at: '2000-01-01T00:00:00.000Z' },
      { permissions: ['read'], expiresAt: '2999-01-01T00:00:00.000Z' },
      { permissions: [] },
    ]) {
      expect((await calls.createInvite(body))._getStatusCode()).toBe(422);
    }
    expect(mockCreateInvite).not.toHaveBeenCalled();
  });
});

describe('/api/v1/projects/{id}/system-prompts', () => {
  beforeEach(() => withScopes([ApiKeyScope.WRITE_PROJECTS]));

  it('adds prompts and returns them in order', async () => {
    const res = await calls.addPrompts();

    expect(res._getStatusCode()).toBe(200);
    expect(ProjectSystemPromptsResponseSchema.strict().safeParse(res._getJSONData()).success).toBe(true);
    expect(res._getJSONData().system_prompts).toEqual([
      { file_id: FILE_ID, enabled: false },
      { file_id: '65b000000000000000000001', enabled: true },
    ]);
    expect(mockAddPrompts).toHaveBeenCalledWith(expect.anything(), PROJECT_ID, [FILE_ID]);
  });

  it('sets the enabled state rather than flipping it', async () => {
    expect((await calls.updatePrompt({ enabled: false }))._getStatusCode()).toBe(200);
    expect(mockSetPrompt).toHaveBeenCalledWith(expect.anything(), PROJECT_ID, FILE_ID, false);
  });

  it('removes one prompt', async () => {
    expect((await calls.removePrompt())._getStatusCode()).toBe(204);
    expect(mockRemovePrompts).toHaveBeenCalledWith(expect.anything(), PROJECT_ID, [FILE_ID]);
  });

  it('answers 404 for a file that is not a prompt', async () => {
    mockSetPrompt.mockRejectedValue(new NotFoundError('System prompt not found'));
    expect((await calls.updatePrompt())._getStatusCode()).toBe(404);
  });

  it('answers 422 for the SPA spelling or a missing state', async () => {
    expect((await calls.addPrompts({ fileIds: [FILE_ID] }))._getStatusCode()).toBe(422);
    expect((await calls.updatePrompt({}))._getStatusCode()).toBe(422);
    expect(mockAddPrompts).not.toHaveBeenCalled();
    expect(mockSetPrompt).not.toHaveBeenCalled();
  });
});
