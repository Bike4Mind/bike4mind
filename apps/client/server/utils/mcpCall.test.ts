import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const h = vi.hoisted(() => ({
  fetch: vi.fn(),
  rateLimitLine: '{"type":"RATE_LIMIT_WARNING","integration":"github","usagePercent":95}',
}));

vi.mock('@bike4mind/mcp', () => ({
  MCPClient: class {
    private readonly onStderrLine: (line: string) => void;
    tools = [];

    constructor(options: { onStderrLine: (line: string) => void }) {
      this.onStderrLine = options.onStderrLine;
    }

    async connectToServer(): Promise<void> {}

    async callTool(): Promise<{ content: unknown[] }> {
      this.onStderrLine(h.rateLimitLine);
      return { content: [] };
    }

    async disconnect(): Promise<void> {}
  },
}));

vi.mock('sst', () => ({ Resource: { RATE_LIMIT_INGEST_TOKEN: { value: 'ingest-token' } } }));

import { handler } from './mcpCall';
import { UNATTRIBUTED_MCP_TENANT } from './mcpTenantKey';

function postedBody(): { events: unknown[]; tenantKey: string } {
  const [, init] = h.fetch.mock.calls[0] as [string, RequestInit];
  return JSON.parse(String(init.body));
}

describe('mcpCall rate-limit ingest', () => {
  beforeEach(() => {
    h.fetch.mockReset().mockResolvedValue(new Response(JSON.stringify({ persisted: 1 }), { status: 200 }));
    vi.stubGlobal('fetch', h.fetch);
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("posts captured rate-limit events under the calling user's tenant", async () => {
    await handler({ name: 'github', action: 'callTool', toolName: 'get_issue', userId: 'user-1', envVariables: [] });

    expect(postedBody()).toEqual({ events: [JSON.parse(h.rateLimitLine)], tenantKey: 'user-1' });
  });

  it('hands the events back on the result when the ingest route rejects them (old route during a deploy)', async () => {
    h.fetch.mockResolvedValue(new Response('tenantKey unexpected', { status: 400 }));
    vi.spyOn(console, 'error').mockImplementation(() => {});

    const result = await handler({
      name: 'github',
      action: 'callTool',
      toolName: 'get_issue',
      userId: 'user-1',
      envVariables: [],
    });

    expect(result).toEqual({ content: [], _rateLimitEvents: [JSON.parse(h.rateLimitLine)] });
  });

  it('posts events from a call with no user under the unattributed tenant', async () => {
    await handler({ name: 'github', action: 'callTool', toolName: 'get_issue', envVariables: [] });

    expect(postedBody().tenantKey).toBe(UNATTRIBUTED_MCP_TENANT);
  });
});
