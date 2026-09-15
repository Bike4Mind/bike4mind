import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock the canonical @bike4mind/utils settings helpers (getSettingsMap fetches,
// getSettingsValue extracts). importActual preserves the rest of the utils surface.
const mockGetSettings = vi.fn();
const mockGetSettingsValue = vi.fn();

vi.mock('@bike4mind/utils', async importOriginal => ({
  ...(await importOriginal<typeof import('@bike4mind/utils')>()),
  getSettingsMap: (...args: unknown[]) => mockGetSettings(...args),
  getSettingsValue: (...args: unknown[]) => mockGetSettingsValue(...args),
}));

import {
  getNotionOAuthConfig,
  NOTION_OAUTH_AUTHORIZE_URL,
  NOTION_OAUTH_TOKEN_URL,
  NOTION_API_BASE_URL,
} from './notionConfig';

describe('notionConfig', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  describe('constants', () => {
    it('should export correct Notion OAuth URLs', () => {
      expect(NOTION_OAUTH_AUTHORIZE_URL).toBe('https://api.notion.com/v1/oauth/authorize');
      expect(NOTION_OAUTH_TOKEN_URL).toBe('https://api.notion.com/v1/oauth/token');
      expect(NOTION_API_BASE_URL).toBe('https://api.notion.com/v1');
    });
  });

  describe('getNotionOAuthConfig', () => {
    it('should return OAuth config from admin settings', async () => {
      mockGetSettings.mockResolvedValue([
        { key: 'notionClientId', value: 'test-client-id' },
        { key: 'notionClientSecret', value: 'test-client-secret' },
      ]);
      mockGetSettingsValue.mockReturnValueOnce('test-client-id').mockReturnValueOnce('test-client-secret');

      process.env.APP_URL = 'https://app.example.com';

      const config = await getNotionOAuthConfig();

      expect(config.clientId).toBe('test-client-id');
      expect(config.clientSecret).toBe('test-client-secret');
      expect(config.redirectUri).toBe('https://app.example.com/api/mcp-servers/notion/callback');
    });

    it('should construct redirect URI from APP_URL', async () => {
      mockGetSettings.mockResolvedValue([]);
      mockGetSettingsValue.mockReturnValue(undefined);
      process.env.APP_URL = 'https://custom-domain.com';

      const config = await getNotionOAuthConfig();

      expect(config.redirectUri).toBe('https://custom-domain.com/api/mcp-servers/notion/callback');
    });

    it('should remove trailing slash from APP_URL', async () => {
      mockGetSettings.mockResolvedValue([]);
      mockGetSettingsValue.mockReturnValue(undefined);
      process.env.APP_URL = 'https://app.example.com/';

      const config = await getNotionOAuthConfig();

      expect(config.redirectUri).toBe('https://app.example.com/api/mcp-servers/notion/callback');
    });

    it('should fallback to localhost when APP_URL is not set', async () => {
      mockGetSettings.mockResolvedValue([]);
      mockGetSettingsValue.mockReturnValue(undefined);
      delete process.env.APP_URL;

      const config = await getNotionOAuthConfig();

      expect(config.redirectUri).toBe('http://localhost:3000/api/mcp-servers/notion/callback');
    });

    it('should request correct settings keys', async () => {
      mockGetSettings.mockResolvedValue([]);
      mockGetSettingsValue.mockReturnValue(undefined);

      await getNotionOAuthConfig();

      expect(mockGetSettingsValue).toHaveBeenCalledWith('notionClientId', expect.anything());
      expect(mockGetSettingsValue).toHaveBeenCalledWith('notionClientSecret', expect.anything());
    });

    it('should return undefined for missing credentials', async () => {
      mockGetSettings.mockResolvedValue([]);
      mockGetSettingsValue.mockReturnValue(undefined);

      const config = await getNotionOAuthConfig();

      expect(config.clientId).toBeUndefined();
      expect(config.clientSecret).toBeUndefined();
    });
  });
});
