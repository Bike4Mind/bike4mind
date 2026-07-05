import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock database repositories
const mockFindById = vi.fn();
const mockUpdate = vi.fn();
const mockFindOne = vi.fn();
const mockCreate = vi.fn();
const mockMcpUpdate = vi.fn();

vi.mock('@bike4mind/database', () => ({
  userRepository: {
    findById: (...args: unknown[]) => mockFindById(...args),
    findByIdWithNotionToken: (...args: unknown[]) => mockFindById(...args),
    update: (...args: unknown[]) => mockUpdate(...args),
  },
  mcpServerRepository: {
    findOne: (...args: unknown[]) => mockFindOne(...args),
    create: (...args: unknown[]) => mockCreate(...args),
    update: (...args: unknown[]) => mockMcpUpdate(...args),
  },
}));

// Mock @bike4mind/common - use importActual to preserve other exports
vi.mock('@bike4mind/common', async importOriginal => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    McpServerName: {
      ...((actual.McpServerName as object) || {}),
      Notion: 'notion',
    },
  };
});

// Mock token encryption
vi.mock('@server/security/tokenEncryption', () => ({
  decryptToken: vi.fn((token: string) => (token ? `decrypted-${token}` : null)),
  encryptEnvVariables: vi.fn((vars: Array<{ key: string; value: string }>) =>
    vars.map(v => ({ key: v.key, value: `encrypted-${v.value}` }))
  ),
}));

// Mock invokeMcpHandler
vi.mock('@server/utils/invokeMcpHandler', () => ({
  invokeMcpHandler: vi.fn().mockResolvedValue([
    { name: 'notion_search', description: 'Search Notion' },
    { name: 'notion_create_page', description: 'Create a page' },
    { name: 'notion_read_page', description: 'Read page content' },
  ]),
}));

// Mock fetch for token validation
const mockFetch = vi.fn();
global.fetch = mockFetch;

import { NotionTokenManager, NotionReconnectRequiredError } from './notionTokenManager';

describe('NotionTokenManager', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFetch.mockReset();
  });

  describe('NotionReconnectRequiredError', () => {
    it('should create error with default message', () => {
      const error = new NotionReconnectRequiredError();
      expect(error.name).toBe('NotionReconnectRequiredError');
      expect(error.message).toBe('Your Notion connection has been revoked. Please reconnect your account.');
    });

    it('should create error with custom message', () => {
      const error = new NotionReconnectRequiredError('Custom message');
      expect(error.message).toBe('Custom message');
    });
  });

  describe('getValidTokens', () => {
    it('should return null when user not found', async () => {
      mockFindById.mockResolvedValue(null);

      const result = await NotionTokenManager.getValidTokens('user-123');

      expect(result).toBeNull();
    });

    it('should return null when notionConnect is not set', async () => {
      mockFindById.mockResolvedValue({ id: 'user-123', notionConnect: null });

      const result = await NotionTokenManager.getValidTokens('user-123');

      expect(result).toBeNull();
    });

    it('should throw NotionReconnectRequiredError when status is needs_reconnect', async () => {
      mockFindById.mockResolvedValue({
        id: 'user-123',
        notionConnect: {
          status: 'needs_reconnect',
          accessToken: 'encrypted-token',
          workspaceId: 'ws-123',
          workspaceName: 'My Workspace',
        },
      });

      await expect(NotionTokenManager.getValidTokens('user-123')).rejects.toThrow(NotionReconnectRequiredError);
    });

    it('should return tokens when token is valid', async () => {
      mockFindById.mockResolvedValue({
        id: 'user-123',
        notionConnect: {
          status: 'connected',
          accessToken: 'valid-token',
          workspaceId: 'ws-123',
          workspaceName: 'My Workspace',
        },
      });

      mockFetch.mockResolvedValue({ ok: true });

      const result = await NotionTokenManager.getValidTokens('user-123');

      expect(result).toEqual({
        accessToken: 'decrypted-valid-token',
        workspaceId: 'ws-123',
        workspaceName: 'My Workspace',
      });
    });

    it('should mark connection as needs_reconnect when token is invalid', async () => {
      mockFindById.mockResolvedValue({
        id: 'user-123',
        notionConnect: {
          status: 'connected',
          accessToken: 'invalid-token',
          workspaceId: 'ws-123',
          workspaceName: 'My Workspace',
        },
      });

      mockFetch.mockResolvedValue({ ok: false, status: 401 });

      await expect(NotionTokenManager.getValidTokens('user-123')).rejects.toThrow(NotionReconnectRequiredError);

      expect(mockUpdate).toHaveBeenCalledWith({
        id: 'user-123',
        notionConnect: expect.objectContaining({
          status: 'needs_reconnect',
          disconnectReason: expect.any(String),
        }),
      });
    });

    it('should validate token against Notion API', async () => {
      mockFindById.mockResolvedValue({
        id: 'user-123',
        notionConnect: {
          status: 'connected',
          accessToken: 'test-token',
          workspaceId: 'ws-123',
          workspaceName: 'My Workspace',
        },
      });

      mockFetch.mockResolvedValue({ ok: true });

      await NotionTokenManager.getValidTokens('user-123');

      expect(mockFetch).toHaveBeenCalledWith(
        'https://api.notion.com/v1/users/me',
        expect.objectContaining({
          method: 'GET',
          headers: expect.objectContaining({
            Authorization: 'Bearer decrypted-test-token',
            'Notion-Version': '2022-06-28',
          }),
        })
      );
    });
  });

  describe('ensureValidToken', () => {
    it('should return access token when valid', async () => {
      mockFindById.mockResolvedValue({
        id: 'user-123',
        notionConnect: {
          status: 'connected',
          accessToken: 'valid-token',
          workspaceId: 'ws-123',
          workspaceName: 'My Workspace',
        },
      });

      mockFetch.mockResolvedValue({ ok: true });

      const token = await NotionTokenManager.ensureValidToken('user-123');

      expect(token).toBe('decrypted-valid-token');
    });

    it('should throw error when tokens cannot be retrieved', async () => {
      mockFindById.mockResolvedValue(null);

      await expect(NotionTokenManager.ensureValidToken('user-123')).rejects.toThrow(
        'Failed to get valid Notion tokens'
      );
    });
  });

  describe('syncMcpServer', () => {
    it('should create new MCP server when none exists', async () => {
      mockFindOne.mockResolvedValue(null);
      mockCreate.mockResolvedValue({ id: 'mcp-123' });

      await NotionTokenManager.syncMcpServer('user-123', 'access-token', 'ws-123');

      expect(mockCreate).toHaveBeenCalledWith({
        userId: 'user-123',
        name: 'notion',
        envVariables: expect.arrayContaining([
          expect.objectContaining({ key: 'NOTION_ACCESS_TOKEN' }),
          expect.objectContaining({ key: 'NOTION_WORKSPACE_ID' }),
        ]),
        enabled: true,
        tools: [],
      });
    });

    it('should update existing MCP server', async () => {
      mockFindOne.mockResolvedValue({ id: 'mcp-123', name: 'notion' });

      await NotionTokenManager.syncMcpServer('user-123', 'access-token', 'ws-123');

      expect(mockMcpUpdate).toHaveBeenCalledWith({
        id: 'mcp-123',
        envVariables: expect.arrayContaining([
          expect.objectContaining({ key: 'NOTION_ACCESS_TOKEN' }),
          expect.objectContaining({ key: 'NOTION_WORKSPACE_ID' }),
        ]),
        enabled: true,
      });
    });

    it('should fetch and store MCP tools', async () => {
      mockFindOne.mockResolvedValue({ id: 'mcp-123', name: 'notion' });

      await NotionTokenManager.syncMcpServer('user-123', 'access-token', 'ws-123');

      // Should update with tools after initial update
      expect(mockMcpUpdate).toHaveBeenCalledWith(
        expect.objectContaining({
          id: 'mcp-123',
          tools: ['notion_search', 'notion_create_page', 'notion_read_page'],
          toolSchemas: expect.arrayContaining([
            expect.objectContaining({ name: 'notion_search' }),
            expect.objectContaining({ name: 'notion_create_page' }),
            expect.objectContaining({ name: 'notion_read_page' }),
          ]),
        })
      );
    });
  });
});
