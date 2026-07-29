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

/**
 * A session document carrying every field the whitelist must NOT pass through:
 * the server-owned prompt, and the three conversation-derived fields that belong
 * to the quests (content-read) action.
 */
const session = {
  id: SESSION,
  userId: 'owner-9',
  name: 'A bad notebook',
  knowledgeIds: ['file-1'],
  lastUsedModel: 'some-vision-less-model',
  users: [{ userId: 'colleague-3', permissions: ['read'], user: { email: 'nope@example.com' } }],
  groups: [{ groupId: 'group-7', permissions: ['read'] }],
  // Server-owned proprietary prompt.
  systemPromptText: 'proprietary prompt',
  // Conversation-derived: summaries OF the customer's conversation, and the
  // private ticket/repo titles it remembered.
  summary: 'The user is frustrated about their tax documents.',
  summaryAt: new Date('2026-01-02T00:00:00.000Z'),
  summaryModelId: 'summariser-model',
  contextSummary: 'Earlier turns concerned the Q3 filing.',
  conversationContext: { jira: { issues: [{ key: 'FIN-12', summary: 'Q3 filing blocked' }], projects: [] } },
};

/**
 * A FULL file document, as the repo layer actually returns it. The route's
 * whitelist is only meaningfully tested if the mock contains the fields it is
 * supposed to drop - a mock missing `content` makes the assertion vacuous.
 */
const fileDoc = {
  id: 'file-1',
  fileName: 'scan.pdf',
  mimeType: 'application/pdf',
  fileSize: 12345,
  type: 'pdf',
  status: 'complete',
  moderationStatus: 'clean',
  vectorized: false,
  chunkCount: 4,
  vectorizedChunkCount: 0,
  createdAt: new Date('2026-01-01T00:00:00.000Z'),
  // Must never reach the wire.
  content: 'THE ENTIRE DOCUMENT TEXT',
  presignedUrl: 'https://signed.example.com/scan.pdf?sig=abc',
  fileUrl: 'https://cdn.example.com/scan.pdf',
  userId: 'owner-9',
  notes: 'private note',
};

beforeEach(() => {
  vi.clearAllMocks();
  mockFindSessionById.mockResolvedValue(session);
  mockFindMetadataByIds.mockResolvedValue([fileDoc]);
  mockFindMetadataBySessionId.mockResolvedValue({ data: [], hasMore: false });
  mockFindPageBySessionId.mockResolvedValue({ data: [], hasMore: false });
  mockRecordAudit.mockResolvedValue({ id: 'audit-1' });
});

describe('GET /api/admin/sessions/[id] - support read gate', () => {
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

  it('returns the session with attachment metadata and audits the read exactly', async () => {
    const { res, run } = call(sessionHandler, {
      isAdmin: true,
      headers: {
        // CloudFront overwrites this one; the client cannot set it. XFF is present
        // and different precisely to prove the resolver does not prefer it.
        'cloudfront-viewer-address': '203.0.113.7:51234',
        'x-forwarded-for': '9.9.9.9, 8.8.8.8',
        'user-agent': 'b4m-admin/1.0',
      },
    });
    await run();

    // The whole audit row is pinned, not a subset - `details` IS the forensic value,
    // so dropping a field from it must fail a test.
    expect(mockRecordAudit).toHaveBeenCalledWith({
      action: 'session.read',
      actorUserId: 'admin-1',
      targetUserId: 'owner-9',
      sessionId: SESSION,
      supportCase: SUPPORT_CASE,
      actorIp: '203.0.113.7',
      actorUserAgent: 'b4m-admin/1.0',
      actorApiKeyId: undefined,
      details: {
        knowledgeIdCount: 1,
        knowledgeFound: 1,
        sessionFileCount: 0,
        sessionFilesTruncated: false,
      },
    });

    const body = res._getJSONData();
    expect(body.session.name).toBe('A bad notebook');
    expect(body.session.lastUsedModel).toBe('some-vision-less-model');
    expect(body.knowledge).toHaveLength(1);
    expect(body.knowledge[0]).toMatchObject({ fileName: 'scan.pdf', vectorized: false, fileSize: 12345 });
  });

  it('records the API key when the read is made with one', async () => {
    const { req, run } = call(sessionHandler, { isAdmin: true });
    (req as unknown as { apiKeyInfo: { keyId: string } }).apiKeyInfo = { keyId: 'key-abc' };
    await run();
    expect(mockRecordAudit).toHaveBeenCalledWith(expect.objectContaining({ actorApiKeyId: 'key-abc' }));
  });

  it('never serves file contents or download URLs, given a full file document', async () => {
    const { res, run } = call(sessionHandler, { isAdmin: true });
    await run();

    const [file] = res._getJSONData().knowledge;
    // The mock DID carry all three - see `fileDoc` - so these assertions bite.
    expect(file.content).toBeUndefined();
    expect(file.presignedUrl).toBeUndefined();
    expect(file.fileUrl).toBeUndefined();
    expect(file.notes).toBeUndefined();
    expect(JSON.stringify(file)).not.toContain('THE ENTIRE DOCUMENT TEXT');
    expect(JSON.stringify(file)).not.toContain('signed.example.com');
  });

  it('serves no conversation-derived field under the settings-only action', async () => {
    const { res, run } = call(sessionHandler, { isAdmin: true });
    await run();

    const { session: served } = res._getJSONData();
    // Summaries are OF the conversation - they belong to the quests action.
    expect(served.summary).toBeUndefined();
    expect(served.contextSummary).toBeUndefined();
    expect(served.conversationContext).toBeUndefined();
    // Server-owned prompt text.
    expect(served.systemPromptText).toBeUndefined();
    // Their metadata is diagnostics, so it stays - as presence flags, not text.
    expect(served.hasSummary).toBe(true);
    expect(served.hasContextSummary).toBe(true);
    expect(served.summaryModelId).toBe('summariser-model');

    const serialized = JSON.stringify(res._getJSONData().session);
    expect(serialized).not.toContain('frustrated');
    expect(serialized).not.toContain('Q3 filing');
    expect(serialized).not.toContain('proprietary prompt');
  });

  it('exposes the share list as ids and permissions, never a joined user profile', async () => {
    const { res, run } = call(sessionHandler, { isAdmin: true });
    await run();

    const { session: served } = res._getJSONData();
    expect(served.sharedWith).toEqual([{ userId: 'colleague-3', permissions: ['read'] }]);
    expect(served.sharedWithGroups).toEqual([{ groupId: 'group-7', permissions: ['read'] }]);
    expect(JSON.stringify(served)).not.toContain('nope@example.com');
  });

  it('reports truncation when a session holds more files than the row cap', async () => {
    mockFindMetadataBySessionId.mockResolvedValue({ data: [fileDoc], hasMore: true });
    const { res, run } = call(sessionHandler, { isAdmin: true });
    await run();

    expect(res._getJSONData().sessionFilesTruncated).toBe(true);
    expect(mockRecordAudit).toHaveBeenCalledWith(
      expect.objectContaining({ details: expect.objectContaining({ sessionFilesTruncated: true }) })
    );
  });

  it('serves nothing when the read cannot be audited', async () => {
    mockRecordAudit.mockRejectedValue(new Error('mongo down'));
    const { res, run } = call(sessionHandler, { isAdmin: true });
    await expect(run()).rejects.toThrow(/mongo down/);
    expect(res._isEndCalled()).toBe(false);
  });
});

describe('GET /api/admin/sessions/[id]/quests - conversation read', () => {
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
    // Full audit row pinned - every `details` key is part of the record.
    expect(mockRecordAudit).toHaveBeenCalledWith({
      action: 'session.quests.read',
      actorUserId: 'admin-1',
      targetUserId: 'owner-9',
      sessionId: SESSION,
      supportCase: SUPPORT_CASE,
      actorIp: expect.any(String),
      actorUserAgent: undefined,
      actorApiKeyId: undefined,
      details: {
        page: 2,
        limit: 1,
        sort: 'asc',
        returned: 1,
        hasMore: true,
        disclosedSummary: true,
        disclosedContextSummary: true,
        disclosedConversationContext: true,
      },
    });

    const body = res._getJSONData();
    expect(body).toMatchObject({ sessionId: SESSION, page: 2, limit: 1, hasMore: true });
    expect(body.quests[0]).toMatchObject({
      id: 'q-1',
      prompt: 'why cant you read my pdf',
      reply: 'I cannot see attachments.',
      model: 'some-vision-less-model',
    });
  });

  it('serves the conversation-derived session fields here, under the content-read action', async () => {
    const { res, run } = call(questsHandler, { isAdmin: true });
    await run();

    expect(res._getJSONData().sessionContext).toEqual({
      summary: 'The user is frustrated about their tax documents.',
      contextSummary: 'Earlier turns concerned the Q3 filing.',
      conversationContext: { jira: { issues: [{ key: 'FIN-12', summary: 'Q3 filing blocked' }], projects: [] } },
    });
  });

  it('records which conversation-derived fields a session actually had', async () => {
    mockFindSessionById.mockResolvedValue({ id: SESSION, userId: 'owner-9', name: 'Bare' });
    const { run } = call(questsHandler, { isAdmin: true });
    await run();

    expect(mockRecordAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        details: expect.objectContaining({
          disclosedSummary: false,
          disclosedContextSummary: false,
          disclosedConversationContext: false,
        }),
      })
    );
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

  it('rejects a page number large enough to become a pathological skip', async () => {
    const { run } = call(questsHandler, {
      isAdmin: true,
      query: { id: SESSION, supportCase: SUPPORT_CASE, page: '100000000' },
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
