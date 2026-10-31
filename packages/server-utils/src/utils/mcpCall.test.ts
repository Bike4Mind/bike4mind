import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const h = vi.hoisted(() => {
  class McpServerConfigError extends Error {
    readonly missingKeys: string[];
    constructor(serverName: string, missingKeys: string[]) {
      super(`The ${serverName} integration is missing ${missingKeys.join(', ')}. Reconnect it in Settings.`);
      this.name = 'McpServerConfigError';
      this.missingKeys = missingKeys;
    }
  }
  return {
    fetch: vi.fn(),
    rateLimitLine: '{"type":"RATE_LIMIT_WARNING","integration":"github","usagePercent":95}',
    // Replaces the default connect for one test; it is handed the client's stderr callback.
    connect: undefined as ((onStderrLine: (line: string) => void) => Promise<void>) | undefined,
    McpServerConfigError,
  };
});

vi.mock('@bike4mind/mcp', () => ({
  McpServerConfigError: h.McpServerConfigError,
  MCPClient: class {
    private readonly onStderrLine: (line: string) => void;
    tools = [];

    constructor(options: { onStderrLine: (line: string) => void }) {
      this.onStderrLine = options.onStderrLine;
    }

    async connectToServer(): Promise<void> {
      await h.connect?.(this.onStderrLine);
    }

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

  it('hands the events back on the result when the ingest route rejects them', async () => {
    h.fetch.mockResolvedValue(
      new Response(JSON.stringify({ error: 'events array and tenantKey required' }), { status: 400 })
    );
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

describe('mcpCall connect failures', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });

  afterEach(() => {
    h.connect = undefined;
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('refuses a misconfigured server once, at warn, without retrying', async () => {
    const connect = vi.fn(async () => {
      throw new h.McpServerConfigError('github', ['GITHUB_ACCESS_TOKEN']);
    });
    h.connect = connect;
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await expect(handler({ name: 'github', action: 'getTools', envVariables: [] })).rejects.toMatchObject({
      name: 'McpServerConfigError',
    });

    expect(connect).toHaveBeenCalledTimes(1);
    expect(error).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('GITHUB_ACCESS_TOKEN'));
  });

  it("logs the child's own stderr when it closes the connection on every attempt", async () => {
    h.connect = async onStderrLine => {
      onStderrLine(h.rateLimitLine);
      onStderrLine('Error: something the server could not survive');
      throw new Error('MCP error -32000: Connection closed');
    };
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    await expect(handler({ name: 'github', action: 'getTools', envVariables: [] })).rejects.toThrow(
      'Connection closed'
    );

    const logged = error.mock.calls.flat().map(String).join(' ');
    expect(logged).toContain('something the server could not survive');
    expect(logged).not.toContain('RATE_LIMIT_WARNING');
  });
});
