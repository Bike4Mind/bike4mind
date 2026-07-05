// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMocks } from 'node-mocks-http';

type HandlerFn = (req: unknown, res: unknown) => Promise<unknown>;

// baseApi: capture the GET handler to invoke it directly. The real route chains
// .get(...).post(...), so the mock must return `this` from each. vi.hoisted so the
// holder exists before the mock factory runs at import.
const captured = vi.hoisted(() => ({ getHandler: undefined as HandlerFn | undefined }));
vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: () => {
    const chain = {
      use() {
        return this;
      },
      get(fn: HandlerFn) {
        captured.getHandler = fn;
        return this;
      },
      post() {
        return this;
      },
    };
    return chain;
  },
}));

vi.mock('@server/utils/errors', () => ({
  ForbiddenError: class ForbiddenError extends Error {},
}));

const mockFind = vi.fn();
const mockGetActiveContent = vi.fn();
vi.mock('@bike4mind/database', () => ({
  systemPromptRepository: {
    find: (...args: unknown[]) => mockFind(...args),
    getActiveContent: (...args: unknown[]) => mockGetActiveContent(...args),
  },
}));

const mockGetDefaults = vi.fn();
vi.mock('@server/utils/systemPrompts/defaults', () => ({
  getDefaultSystemPrompts: () => mockGetDefaults(),
}));

import '../index';

const codeDefault = (promptId: string, content: string) => ({
  promptId,
  name: promptId,
  description: 'd',
  content,
  category: 'optihashi',
  tags: [],
  variables: [],
  enabled: true,
  createdBy: 'system',
  lastUpdatedBy: 'system',
  lastUpdatedByName: 'System Default',
});

const dbOverride = (promptId: string, content: string, activeVersion = 1, version = activeVersion) => ({
  ...codeDefault(promptId, content),
  version,
  activeVersion,
  usageCount: 0,
  successCount: 0,
  errorCount: 0,
  lastUsedAt: null,
});

function makeReq() {
  const { req, res } = createMocks({ method: 'GET' });
  (req as Record<string, unknown>).user = { id: 'admin-1', isAdmin: true };
  (req as Record<string, unknown>).query = {};
  return { req: req as Parameters<HandlerFn>[0], res };
}

const byId = (res: ReturnType<typeof createMocks>['res']) =>
  new Map((res._getJSONData().data as { promptId: string }[]).map(p => [p.promptId, p]));

describe('GET /api/admin/system-prompts — code-default divergence flag', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('flags an override whose latest active content has drifted from the code default (no re-query)', async () => {
    mockGetDefaults.mockReturnValue([codeDefault('opti_optimizer', 'NEW default content')]);
    // activeVersion === version (latest): resolved from the already-loaded doc.
    mockFind.mockResolvedValue([dbOverride('opti_optimizer', 'STALE override content')]);

    const { req, res } = makeReq();
    await captured.getHandler!(req, res);

    const prompt = byId(res).get('opti_optimizer') as Record<string, unknown>;
    expect(prompt.divergesFromCodeDefault).toBe(true);
    // Common case short-circuits: no extra Mongo roundtrip via getActiveContent.
    expect(mockGetActiveContent).not.toHaveBeenCalled();
  });

  it('does NOT flag when the app uses the code default (activeVersion 0), without a re-query', async () => {
    mockGetDefaults.mockReturnValue([codeDefault('opti_optimizer', 'same content')]);
    mockFind.mockResolvedValue([dbOverride('opti_optimizer', 'overridden but inactive', 0)]);

    const { req, res } = makeReq();
    await captured.getHandler!(req, res);

    const prompt = byId(res).get('opti_optimizer') as Record<string, unknown>;
    expect(prompt.divergesFromCodeDefault).toBe(false);
    expect(mockGetActiveContent).not.toHaveBeenCalled();
  });

  it('resolves a historical active version via getActiveContent, passing the code default as fallback', async () => {
    mockGetDefaults.mockReturnValue([codeDefault('opti_optimizer', 'NEW default content')]);
    // activeVersion (1) is an older version than the latest stored (3), needs history lookup.
    mockFind.mockResolvedValue([dbOverride('opti_optimizer', 'latest v3 content', 1, 3)]);
    mockGetActiveContent.mockResolvedValue('historical v1 content');

    const { req, res } = makeReq();
    await captured.getHandler!(req, res);

    const prompt = byId(res).get('opti_optimizer') as Record<string, unknown>;
    expect(prompt.divergesFromCodeDefault).toBe(true);
    expect(mockGetActiveContent).toHaveBeenCalledWith('opti_optimizer', { content: 'NEW default content' });
  });

  it('never flags a code-source prompt with no DB override', async () => {
    mockGetDefaults.mockReturnValue([codeDefault('opti_sales_intelligence', 'content')]);
    mockFind.mockResolvedValue([]);

    const { req, res } = makeReq();
    await captured.getHandler!(req, res);

    const prompt = byId(res).get('opti_sales_intelligence') as Record<string, unknown>;
    expect(prompt.source).toBe('code');
    expect(prompt.divergesFromCodeDefault).toBe(false);
    expect(mockGetActiveContent).not.toHaveBeenCalled();
  });

  it('does not flag a DB-only prompt that has no code default to diverge from', async () => {
    mockGetDefaults.mockReturnValue([]);
    mockFind.mockResolvedValue([dbOverride('custom_db_only', 'content')]);

    const { req, res } = makeReq();
    await captured.getHandler!(req, res);

    const prompt = byId(res).get('custom_db_only') as Record<string, unknown>;
    expect(prompt.divergesFromCodeDefault).toBe(false);
  });
});
