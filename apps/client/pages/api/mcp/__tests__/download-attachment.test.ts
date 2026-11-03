// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMocks } from 'node-mocks-http';

const { mockFindById, mockInvoke } = vi.hoisted(() => ({
  mockFindById: vi.fn(),
  mockInvoke: vi.fn(),
}));

vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: () => {
    const h: Record<string, (req: unknown, res: unknown) => unknown> = {};
    const chain = Object.assign(
      (req: unknown, res: unknown) => h[(req as { method?: string }).method ?? 'GET']?.(req, res),
      {
        use: () => chain,
        get: (fn: (req: unknown, res: unknown) => unknown) => ((h.GET = fn), chain),
        post: (fn: (req: unknown, res: unknown) => unknown) => ((h.POST = fn), chain),
      }
    );
    return chain;
  },
}));

vi.mock('@server/integrations/slack/slackPackageInit', () => ({ initializeSlackPackage: vi.fn() }));
vi.mock('@bike4mind/database', () => ({ Session: { findById: (...a: unknown[]) => mockFindById(...a) } }));
vi.mock('@bike4mind/observability', () => ({
  Logger: class {
    info = vi.fn();
    error = vi.fn();
    warn = vi.fn();
  },
}));
vi.mock('@bike4mind/slack', () => ({
  JiraResource: class {
    getMcpEnvVariables = async () => [];
  },
  ConfluenceResource: class {
    getMcpEnvVariables = async () => [];
  },
}));
vi.mock('@bike4mind/utils/contentDisposition', () => ({ buildContentDisposition: (name: string) => name }));
// The EnableMCPServer gate itself is pinned by mcpServerFlagGate.test.ts.
vi.mock('@server/utils/mcpServerFlag', () => ({ assertMcpServerEnabled: vi.fn() }));
vi.mock('@bike4mind/server-utils/utils/objectId', () => ({ isValidObjectId: () => true }));
vi.mock('@bike4mind/server-utils/utils/invokeMcpHandler', () => ({
  invokeMcpHandler: (...a: unknown[]) => mockInvoke(...a),
}));
vi.mock('@server/utils/parseMcpResult', () => ({
  parseMcpResult: () => ({
    content: Buffer.from('data').toString('base64'),
    filename: 'a.txt',
    mimeType: 'text/plain',
  }),
}));

import handler from '../download-attachment';

const SESSION_ID = '507f1f77bcf86cd799439011';
const USER_ID = 'u1';

const run = async () => {
  const { req, res } = createMocks({
    method: 'POST',
    body: { sessionId: SESSION_ID, source: 'jira', attachmentId: 'att-1', filename: 'a.txt' },
  });
  (req as unknown as { user: { id: string } }).user = { id: USER_ID };
  await (handler as unknown as (r: unknown, s: unknown) => Promise<unknown>)(req, res);
  return res;
};

beforeEach(() => {
  vi.clearAllMocks();
  mockFindById.mockResolvedValue({ userId: USER_ID });
  mockInvoke.mockResolvedValue({});
});

describe('POST /api/mcp/download-attachment', () => {
  it("invokes the Atlassian MCP tool under the requesting user's tenant", async () => {
    await run();

    expect(mockInvoke).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'callTool', name: 'atlassian', userId: USER_ID })
    );
  });
});
