// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMocks } from 'node-mocks-http';
import { ApiKeyScope } from '@bike4mind/common';

const { mockRunQuestNode, mockGetNodes } = vi.hoisted(() => ({
  mockRunQuestNode: vi.fn(),
  mockGetNodes: vi.fn(),
}));

vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: () => {
    const chain: Record<string, unknown> = {};
    chain.use = () => chain;
    chain.post =
      (...handlers: ((req: unknown, res: unknown, next: () => void) => unknown)[]) =>
      async (req: unknown, res: unknown) => {
        for (const handler of handlers) {
          let advanced = false;
          await handler(req, res, () => {
            advanced = true;
          });
          if (!advanced) return;
        }
      };
    return chain;
  },
}));
vi.mock('@server/middlewares/rateLimit', () => ({
  rateLimit: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));
vi.mock('@server/middlewares/csrfProtection', () => ({
  csrfProtection: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));
vi.mock('@server/middlewares/requireUser', () => ({ requireUser: vi.fn() }));
vi.mock('@server/middlewares/requireExperimentalFeature', () => ({ requireExperimentalFeature: () => vi.fn() }));
vi.mock('@server/utils/respond', () => ({
  respond: (
    res: { status: (c: number) => { json: (b: unknown) => void } },
    _schema: unknown,
    body: unknown,
    code: number
  ) => res.status(code).json(body),
}));
vi.mock('@server/questmaster/v5/questGraphAccess', () => ({
  requireOwnedNode: async () => ({ node: { id: 'n1', dependsOn: [] }, graph: { id: 'g1' } }),
}));
vi.mock('@server/questmaster/v5/runQuestNode', () => ({ runQuestNode: mockRunQuestNode }));
vi.mock('@server/questmaster/v5/wire', () => ({
  QuestNodeRunResponseSchema: {},
  toQuestNodeWire: (node: unknown) => node,
}));
vi.mock('@bike4mind/database', () => ({
  isNodeReady: () => true,
  isNodeRunnable: () => true,
  questNodeRepository: { getNodes: mockGetNodes },
}));

const { default: handler } = await import('../[id]/run');

function run(body: Record<string, unknown>, apiKeyInfo?: Record<string, unknown>) {
  const { req, res } = createMocks({ method: 'POST', query: { id: 'n1' }, body });
  Object.assign(req, { user: { id: 'u1' }, ...(apiKeyInfo ? { apiKeyInfo } : {}) });
  return { req, res };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockGetNodes.mockResolvedValue([]);
  mockRunQuestNode.mockResolvedValue({ executionId: 'exec1', node: { id: 'n1' } });
});

describe('POST /api/quest-nodes/{id}/run credential forwarding', () => {
  it('hands the authenticating API key to runQuestNode', async () => {
    const keyInfo = { keyId: 'k1', scopes: [ApiKeyScope.AI_CHAT] };
    const { req, res } = run({ model: 'm' }, keyInfo);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (handler as any)(req, res);

    expect(mockRunQuestNode).toHaveBeenCalledTimes(1);
    expect(mockRunQuestNode.mock.calls[0][0].apiKeyInfo).toBe(keyInfo);
  });

  it('passes no credential for a session caller', async () => {
    const { req, res } = run({ model: 'm' });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (handler as any)(req, res);

    expect(mockRunQuestNode.mock.calls[0][0].apiKeyInfo).toBeUndefined();
  });

  it('ignores an apiKeyId or scopeDeniedTools sent in the body', async () => {
    const { req, res } = run({
      model: 'm',
      apiKeyId: 'spoofed',
      scopeDeniedTools: [],
      apiKeyInfo: { keyId: 'spoofed', scopes: Object.values(ApiKeyScope) },
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (handler as any)(req, res);

    const args = mockRunQuestNode.mock.calls[0][0];
    expect(args.apiKeyInfo).toBeUndefined();
    expect(args).not.toHaveProperty('apiKeyId');
    expect(args).not.toHaveProperty('scopeDeniedTools');
  });
});
