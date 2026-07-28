import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMocks } from 'node-mocks-http';

vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: () => {
    const handlers: Record<string, (req: unknown, res: unknown) => Promise<unknown>> = {};
    const chain = async (req: { method: string }, res: unknown) => handlers[req.method](req, res);
    chain.use = () => chain;
    chain.get = (fn: (typeof handlers)[string]) => {
      handlers.GET = fn;
      return chain;
    };
    return chain;
  },
}));

const mockFindSessionById = vi.fn();
const mockFindMetadataByIds = vi.fn();
const mockFindMetadataBySessionId = vi.fn();
const mockFindPageBySessionId = vi.fn();
const mockRecordAudit = vi.fn();
vi.mock('@bike4mind/database', () => ({
  sessionRepository: { findById: (...a: unknown[]) => mockFindSessionById(...a) },
  fabFileRepository: {
    findMetadataByIds: (...a: unknown[]) => mockFindMetadataByIds(...a),
    findMetadataBySessionId: (...a: unknown[]) => mockFindMetadataBySessionId(...a),
  },
  questRepository: { findPageBySessionId: (...a: unknown[]) => mockFindPageBySessionId(...a) },
  adminSupportAccessAuditLogRepository: { record: (...a: unknown[]) => mockRecordAudit(...a) },
}));

import sessionHandler from '../sessions/[id]/index';
import questsHandler from '../sessions/[id]/quests';

const SESSION = '6650000000000000000000aa';
const SUPPORT_CASE = 'ZD-4821';

type Handler = (req: unknown, res: unknown) => Promise<unknown>;

function call(handler: unknown, options: { isAdmin?: boolean; hasUser?: boolean; query?: object; headers?: object }) {
  const { req, res } = createMocks({
    method: 'GET',
    query: options.query ?? { id: SESSION, supportCase: SUPPORT_CASE },
    headers: options.headers ?? {},
  });
  if (options.hasUser !== false) {
    (req as unknown as { user: { isAdmin: boolean; id: string } }).user = {
      isAdmin: options.isAdmin ?? false,
      id: 'admin-1',
    };
  }
  return { req, res, run: () => (handler as Handler)(req, res) };
}

const session = {
  id: SESSION,
  userId: 'owner-9',
  name: 'A bad notebook',
  knowledgeIds: ['file-1'],
  // Server-owned: must not reach the support view.
  systemPromptText: 'proprietary prompt',
};

beforeEach(() => {
  vi.clearAllMocks();
  mockFindSessionById.mockResolvedValue(session);
  mockFindMetadataByIds.mockResolvedValue([
    { id: 'file-1', fileName: 'scan.pdf', mimeType: 'application/pdf', vectorized: false },
  ]);
  mockFindMetadataBySessionId.mockResolvedValue([]);
  mockFindPageBySessionId.mockResolvedValue({ data: [], hasMore: false });
  mockRecordAudit.mockResolvedValue({ id: 'audit-1' });
});

describe('GET /api/admin/sessions/[id] — support read gate', () => {
  it('rejects a non-admin before touching the session', async () => {
    const { run } = call(sessionHandler, { isAdmin: false });
    await expect(run()).rejects.toThrow(/[Aa]dmin/);
    expect(mockFindSessionById).not.toHaveBeenCalled();
    expect(mockRecordAudit).not.toHaveBeenCalled();
  });

  it('rejects an unauthenticated caller', async () => {
    const { run } = call(sessionHandler, { hasUser: false });
    await expect(run()).rejects.toThrow(/[Aa]uthentication/);
    expect(mockFindSessionById).not.toHaveBeenCalled();
  });

  it('requires a support-case reference so the audit log is self-documenting', async () => {
    const { run } = call(sessionHandler, { isAdmin: true, query: { id: SESSION } });
    await expect(run()).rejects.toThrow();
    expect(mockFindSessionById).not.toHaveBeenCalled();
    expect(mockRecordAudit).not.toHaveBeenCalled();
  });

  it('404s a non-ObjectId id instead of casting it into a 500', async () => {
    const { run } = call(sessionHandler, { isAdmin: true, query: { id: 'not-an-id', supportCase: SUPPORT_CASE } });
    await expect(run()).rejects.toThrow(/not found/i);
    expect(mockFindSessionById).not.toHaveBeenCalled();
  });

  it('404s an unknown session without auditing', async () => {
    mockFindSessionById.mockResolvedValue(null);
    const { run } = call(sessionHandler, { isAdmin: true });
    await expect(run()).rejects.toThrow(/not found/i);
    expect(mockRecordAudit).not.toHaveBeenCalled();
  });

  it('returns the session with attachment metadata and audits the read', async () => {
    const { res, run } = call(sessionHandler, {
      isAdmin: true,
      headers: { 'x-forwarded-for': '1.1.1.1, 203.0.113.7', 'user-agent': 'b4m-admin/1.0' },
    });
    await run();

    expect(mockRecordAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'session.read',
        actorUserId: 'admin-1',
        targetUserId: 'owner-9',
        sessionId: SESSION,
        supportCase: SUPPORT_CASE,
        // Last XFF hop only - earlier entries are caller-controlled.
        actorIp: '203.0.113.7',
        actorUserAgent: 'b4m-admin/1.0',
      })
    );

    const body = res._getJSONData();
    expect(body.session.name).toBe('A bad notebook');
    expect(body.session.systemPromptText).toBeUndefined();
    expect(body.knowledge).toHaveLength(1);
    expect(body.knowledge[0]).toMatchObject({ fileName: 'scan.pdf', vectorized: false });
    // Metadata only: file bodies never leave the DB layer.
    expect(body.knowledge[0].content).toBeUndefined();
  });

  it('serves nothing when the read cannot be audited', async () => {
    mockRecordAudit.mockRejectedValue(new Error('mongo down'));
    const { res, run } = call(sessionHandler, { isAdmin: true });
    await expect(run()).rejects.toThrow(/mongo down/);
    expect(res._isEndCalled()).toBe(false);
  });
});

describe('GET /api/admin/sessions/[id]/quests — conversation read', () => {
  it('rejects a non-admin', async () => {
    const { run } = call(questsHandler, { isAdmin: false });
    await expect(run()).rejects.toThrow(/[Aa]dmin/);
    expect(mockFindPageBySessionId).not.toHaveBeenCalled();
  });

  it('returns prompts and replies for the requested page and audits what was read', async () => {
    mockFindPageBySessionId.mockResolvedValue({
      data: [
        {
          id: 'q-1',
          type: 'message',
          prompt: 'why cant you read my pdf',
          reply: 'I cannot see attachments.',
          fabFileIds: ['file-1'],
          promptMeta: { model: { name: 'some-vision-less-model' } },
          creditsUsed: 3,
        },
      ],
      hasMore: true,
    });

    const { res, run } = call(questsHandler, {
      isAdmin: true,
      query: { id: SESSION, supportCase: SUPPORT_CASE, page: '2', limit: '1' },
    });
    await run();

    expect(mockFindPageBySessionId).toHaveBeenCalledWith(SESSION, { page: 2, limit: 1, sort: 'asc' });
    expect(mockRecordAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'session.quests.read',
        targetUserId: 'owner-9',
        supportCase: SUPPORT_CASE,
        details: expect.objectContaining({ page: 2, limit: 1, returned: 1, hasMore: true }),
      })
    );

    const body = res._getJSONData();
    expect(body).toMatchObject({ sessionId: SESSION, page: 2, limit: 1, hasMore: true });
    expect(body.quests[0]).toMatchObject({
      id: 'q-1',
      prompt: 'why cant you read my pdf',
      reply: 'I cannot see attachments.',
      model: 'some-vision-less-model',
    });
  });

  it('defaults to the first page, oldest-first', async () => {
    const { run } = call(questsHandler, { isAdmin: true });
    await run();
    expect(mockFindPageBySessionId).toHaveBeenCalledWith(SESSION, { page: 1, limit: 25, sort: 'asc' });
  });

  it('rejects a limit above the page cap', async () => {
    const { run } = call(questsHandler, {
      isAdmin: true,
      query: { id: SESSION, supportCase: SUPPORT_CASE, limit: '5000' },
    });
    await expect(run()).rejects.toThrow();
    expect(mockFindPageBySessionId).not.toHaveBeenCalled();
  });

  it('serves nothing when the read cannot be audited', async () => {
    mockRecordAudit.mockRejectedValue(new Error('mongo down'));
    const { res, run } = call(questsHandler, { isAdmin: true });
    await expect(run()).rejects.toThrow(/mongo down/);
    expect(res._isEndCalled()).toBe(false);
  });
});
