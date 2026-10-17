import { describe, expect, it } from 'vitest';
import {
  MCP_API_KEY_VALUE_MAX_LENGTH,
  MCP_TOOLS_REDISCOVERY_TTL_MS,
  mcpApiKeyHeaderNameProblem,
  mcpApiKeyValueProblem,
  shouldRediscoverMcpTools,
  toMcpApiKeyLast4,
} from './McpConnectionRules';

describe('mcpApiKeyHeaderNameProblem', () => {
  it.each(['Authorization', 'X-Api-Key', 'api-key', 'PRIVATE-TOKEN', 'x'])('accepts %j', name => {
    expect(mcpApiKeyHeaderNameProblem(name)).toBeNull();
  });

  it.each([
    'Host',
    'cookie',
    'Content-Length',
    'Transfer-Encoding',
    'Connection',
    'Mcp-Session-Id',
    'MCP-PROTOCOL-VERSION',
    'X-Forwarded-For',
    'x-forwarded-host',
    'Forwarded',
    'Proxy-Authorization',
    'Content-Type',
    'Accept',
  ])('denies %j', name => {
    expect(mcpApiKeyHeaderNameProblem(name)).toMatch(/cannot carry/);
  });

  it.each(['', '1abc', '-x', 'has space', 'x_y', 'x:y', 'a'.repeat(65), 'Authorization\r\nX-Evil'])(
    'rejects the malformed %j',
    name => {
      expect(mcpApiKeyHeaderNameProblem(name)).toMatch(/must start with a letter/);
    }
  );
});

describe('mcpApiKeyValueProblem', () => {
  it('accepts an ordinary key', () => {
    expect(mcpApiKeyValueProblem('lin_api_0123456789abcdef')).toBeNull();
  });

  it.each([
    ['', /required/],
    ['k'.repeat(MCP_API_KEY_VALUE_MAX_LENGTH + 1), /longer/],
    ['abc\r\nX-Evil: 1', /control/],
    ['abc\u0000', /control/],
    [' padded', /whitespace/],
  ])('rejects %j', (value, problem) => {
    expect(mcpApiKeyValueProblem(value)).toMatch(problem);
  });
});

describe('toMcpApiKeyLast4', () => {
  it('shows the tail of a long key and nothing of a short one', () => {
    expect(toMcpApiKeyLast4('lin_api_0123456789abcd')).toBe('abcd');
    expect(toMcpApiKeyLast4('short-key')).toBe('****');
  });
});

describe('shouldRediscoverMcpTools', () => {
  const now = Date.UTC(2026, 9, 17);

  it('fetches a connected connection that was never fetched or is past the TTL', () => {
    expect(shouldRediscoverMcpTools({ status: 'connected' }, now)).toBe(true);
    expect(
      shouldRediscoverMcpTools(
        { status: 'connected', toolsFetchedAt: new Date(now - MCP_TOOLS_REDISCOVERY_TTL_MS) },
        now
      )
    ).toBe(true);
  });

  it('leaves a fresh list alone, even an empty one', () => {
    expect(
      shouldRediscoverMcpTools(
        { status: 'connected', toolsFetchedAt: new Date(now - MCP_TOOLS_REDISCOVERY_TTL_MS + 1) },
        now
      )
    ).toBe(false);
  });

  it('never fetches for a connection that needs the user first', () => {
    for (const status of ['pending_auth', 'needs_reconnect', 'error'] as const) {
      expect(shouldRediscoverMcpTools({ status }, now)).toBe(false);
    }
  });
});
