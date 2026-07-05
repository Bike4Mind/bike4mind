/**
 * Unit tests for Confluence page restriction operations.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { formatPageRestrictions } from '../format';
import { ConfluenceApi } from '../api';
import type { ConfluenceConfig } from '../api';

const mockFetch = vi.fn();
global.fetch = mockFetch;

describe('Confluence Page Restrictions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });
  describe('formatPageRestrictions', () => {
    const pageId = '12345';

    it('should return empty restrictions when response is null', () => {
      const result = formatPageRestrictions(null, pageId);

      expect(result).toEqual({
        pageId,
        hasRestrictions: false,
        restrictions: [],
      });
    });

    it('should return empty restrictions when response is undefined', () => {
      const result = formatPageRestrictions(undefined, pageId);

      expect(result).toEqual({
        pageId,
        hasRestrictions: false,
        restrictions: [],
      });
    });

    it('should return empty restrictions when response has error', () => {
      const result = formatPageRestrictions({ error: 'Something went wrong' }, pageId);

      expect(result).toEqual({
        pageId,
        hasRestrictions: false,
        restrictions: [],
      });
    });

    it('should parse read restrictions with users', () => {
      const apiResponse = {
        read: {
          restrictions: {
            user: {
              results: [
                { accountId: 'user-123', displayName: 'John Doe' },
                { accountId: 'user-456', displayName: 'Jane Smith' },
              ],
            },
          },
        },
      };

      const result = formatPageRestrictions(apiResponse, pageId);

      expect(result.hasRestrictions).toBe(true);
      expect(result.restrictions).toHaveLength(1);
      expect(result.restrictions[0].operation).toBe('read');
      expect(result.restrictions[0].subjects).toHaveLength(2);
      expect(result.restrictions[0].subjects[0]).toEqual({
        type: 'user',
        identifier: 'user-123',
        displayName: 'John Doe',
      });
    });

    it('should parse update restrictions with groups', () => {
      const apiResponse = {
        update: {
          restrictions: {
            group: {
              results: [
                { name: 'developers', id: 'group-1' },
                { name: 'admins', id: 'group-2' },
              ],
            },
          },
        },
      };

      const result = formatPageRestrictions(apiResponse, pageId);

      expect(result.hasRestrictions).toBe(true);
      expect(result.restrictions).toHaveLength(1);
      expect(result.restrictions[0].operation).toBe('update');
      expect(result.restrictions[0].subjects).toHaveLength(2);
      expect(result.restrictions[0].subjects[0]).toEqual({
        type: 'group',
        identifier: 'developers',
        displayName: 'developers',
      });
    });

    it('should parse both read and update restrictions', () => {
      const apiResponse = {
        read: {
          restrictions: {
            user: {
              results: [{ accountId: 'user-123', displayName: 'John Doe' }],
            },
          },
        },
        update: {
          restrictions: {
            group: {
              results: [{ name: 'editors', id: 'group-1' }],
            },
          },
        },
      };

      const result = formatPageRestrictions(apiResponse, pageId);

      expect(result.hasRestrictions).toBe(true);
      expect(result.restrictions).toHaveLength(2);

      const readRestriction = result.restrictions.find(r => r.operation === 'read');
      const updateRestriction = result.restrictions.find(r => r.operation === 'update');

      expect(readRestriction?.subjects).toHaveLength(1);
      expect(readRestriction?.subjects[0].type).toBe('user');

      expect(updateRestriction?.subjects).toHaveLength(1);
      expect(updateRestriction?.subjects[0].type).toBe('group');
    });

    it('should handle mixed users and groups in same operation', () => {
      const apiResponse = {
        read: {
          restrictions: {
            user: {
              results: [{ accountId: 'user-123', displayName: 'John Doe' }],
            },
            group: {
              results: [{ name: 'viewers', id: 'group-1' }],
            },
          },
        },
      };

      const result = formatPageRestrictions(apiResponse, pageId);

      expect(result.hasRestrictions).toBe(true);
      expect(result.restrictions).toHaveLength(1);
      expect(result.restrictions[0].subjects).toHaveLength(2);

      const userSubject = result.restrictions[0].subjects.find(s => s.type === 'user');
      const groupSubject = result.restrictions[0].subjects.find(s => s.type === 'group');

      expect(userSubject?.identifier).toBe('user-123');
      expect(groupSubject?.identifier).toBe('viewers');
    });

    it('should handle empty restrictions object', () => {
      const apiResponse = {
        read: {
          restrictions: {
            user: { results: [] },
            group: { results: [] },
          },
        },
      };

      const result = formatPageRestrictions(apiResponse, pageId);

      expect(result.hasRestrictions).toBe(false);
      expect(result.restrictions).toHaveLength(0);
    });

    it('should handle alternative user field formats', () => {
      const apiResponse = {
        read: {
          restrictions: {
            user: [
              { username: 'olduser', publicName: 'Old User' },
              { key: 'keyuser', displayName: 'Key User' },
            ],
          },
        },
      };

      const result = formatPageRestrictions(apiResponse, pageId);

      expect(result.hasRestrictions).toBe(true);
      expect(result.restrictions[0].subjects[0].identifier).toBe('olduser');
      expect(result.restrictions[0].subjects[0].displayName).toBe('Old User');
      expect(result.restrictions[0].subjects[1].identifier).toBe('keyuser');
    });

    it('should handle group without results wrapper', () => {
      const apiResponse = {
        update: {
          restrictions: {
            group: [{ name: 'direct-group', id: 'g-1' }],
          },
        },
      };

      const result = formatPageRestrictions(apiResponse, pageId);

      expect(result.hasRestrictions).toBe(true);
      expect(result.restrictions[0].subjects[0].identifier).toBe('direct-group');
    });

    it('should parse array format response (actual Confluence API v1 format)', () => {
      // This is the actual format returned by GET /content/{id}/restriction
      const apiResponse = {
        results: [
          {
            operation: 'read',
            restrictions: {
              user: {
                results: [
                  {
                    type: 'known',
                    accountId: '712020:89d4daa3-05d6-413a-82be-4b36a33bafe2',
                    accountType: 'atlassian',
                    email: 'user@example.com',
                    publicName: 'Test User',
                    displayName: 'Test User',
                  },
                ],
                start: 0,
                limit: 100,
                size: 1,
              },
              group: {
                results: [],
                start: 0,
                limit: 100,
                size: 0,
              },
            },
          },
          {
            operation: 'update',
            restrictions: {
              user: {
                results: [],
                start: 0,
                limit: 100,
                size: 0,
              },
              group: {
                results: [],
                start: 0,
                limit: 100,
                size: 0,
              },
            },
          },
        ],
        start: 0,
        limit: 100,
        size: 2,
      };

      const result = formatPageRestrictions(apiResponse, pageId);

      expect(result.hasRestrictions).toBe(true);
      expect(result.restrictions).toHaveLength(1);
      expect(result.restrictions[0].operation).toBe('read');
      expect(result.restrictions[0].subjects).toHaveLength(1);
      expect(result.restrictions[0].subjects[0]).toEqual({
        type: 'user',
        identifier: '712020:89d4daa3-05d6-413a-82be-4b36a33bafe2',
        displayName: 'Test User',
      });
    });

    it('should handle array format with both read and update restrictions', () => {
      const apiResponse = {
        results: [
          {
            operation: 'read',
            restrictions: {
              user: {
                results: [{ accountId: 'user-1', displayName: 'User One' }],
              },
              group: {
                results: [{ name: 'viewers', id: 'group-1' }],
              },
            },
          },
          {
            operation: 'update',
            restrictions: {
              user: {
                results: [{ accountId: 'user-2', displayName: 'User Two' }],
              },
              group: {
                results: [],
              },
            },
          },
        ],
      };

      const result = formatPageRestrictions(apiResponse, pageId);

      expect(result.hasRestrictions).toBe(true);
      expect(result.restrictions).toHaveLength(2);

      const readRestriction = result.restrictions.find(r => r.operation === 'read');
      const updateRestriction = result.restrictions.find(r => r.operation === 'update');

      expect(readRestriction?.subjects).toHaveLength(2);
      expect(updateRestriction?.subjects).toHaveLength(1);
    });

    it('should return empty restrictions for array format with no actual restrictions', () => {
      const apiResponse = {
        results: [
          {
            operation: 'read',
            restrictions: {
              user: { results: [] },
              group: { results: [] },
            },
          },
          {
            operation: 'update',
            restrictions: {
              user: { results: [] },
              group: { results: [] },
            },
          },
        ],
      };

      const result = formatPageRestrictions(apiResponse, pageId);

      expect(result.hasRestrictions).toBe(false);
      expect(result.restrictions).toHaveLength(0);
    });
  });

  describe('ConfluenceApi validation methods', () => {
    const mockConfig: ConfluenceConfig = {
      accessToken: 'test-token',
      cloudId: 'test-cloud-id',
      siteUrl: 'https://test.atlassian.net/wiki',
      webBaseUrl: 'https://test.atlassian.net/wiki',
      apiBaseUrlV1: 'https://test.atlassian.net/wiki/rest/api',
      apiBaseUrlV2: 'https://test.atlassian.net/wiki/api/v2',
      authHeader: 'Bearer test-token',
    };

    let api: ConfluenceApi;

    beforeEach(() => {
      api = new ConfluenceApi(mockConfig);
      mockFetch.mockReset();
    });

    describe('validateUserExists', () => {
      it('should return user info when user exists', async () => {
        const responseData = { accountId: 'user-123', displayName: 'John Doe' };
        mockFetch.mockResolvedValueOnce({
          ok: true,
          status: 200,
          headers: { get: (key: string) => (key === 'content-type' ? 'application/json' : null) },
          text: async () => JSON.stringify(responseData),
        });

        const result = await api.validateUserExists('user-123');

        expect(result).toEqual({
          accountId: 'user-123',
          displayName: 'John Doe',
        });
      });

      it('should use publicName as fallback for displayName', async () => {
        const responseData = { accountId: 'user-123', publicName: 'Johnny D' };
        mockFetch.mockResolvedValueOnce({
          ok: true,
          status: 200,
          headers: { get: (key: string) => (key === 'content-type' ? 'application/json' : null) },
          text: async () => JSON.stringify(responseData),
        });

        const result = await api.validateUserExists('user-123');

        expect(result.displayName).toBe('Johnny D');
      });

      it('should throw error when user not found (404)', async () => {
        mockFetch.mockResolvedValueOnce({
          ok: false,
          status: 404,
          statusText: 'Not Found',
          headers: { get: (key: string) => (key === 'content-type' ? 'application/json' : null) },
          text: async () => JSON.stringify({ message: 'User not found' }),
        });

        await expect(api.validateUserExists('nonexistent-user')).rejects.toThrow(/User.*not found/i);
      });

      it('should throw error when API returns error object', async () => {
        const responseData = { error: 'Invalid user' };
        mockFetch.mockResolvedValueOnce({
          ok: true,
          status: 200,
          headers: { get: (key: string) => (key === 'content-type' ? 'application/json' : null) },
          text: async () => JSON.stringify(responseData),
        });

        await expect(api.validateUserExists('bad-user')).rejects.toThrow('User with account ID "bad-user" not found.');
      });
    });

    describe('validateGroupExists', () => {
      it('should return group info when group exists', async () => {
        const responseData = { name: 'developers', id: 'group-123' };
        mockFetch.mockResolvedValueOnce({
          ok: true,
          status: 200,
          headers: { get: (key: string) => (key === 'content-type' ? 'application/json' : null) },
          text: async () => JSON.stringify(responseData),
        });

        const result = await api.validateGroupExists('developers');

        expect(result).toEqual({ name: 'developers' });
      });

      it('should throw error when group not found (404)', async () => {
        mockFetch.mockResolvedValueOnce({
          ok: false,
          status: 404,
          statusText: 'Not Found',
          headers: { get: (key: string) => (key === 'content-type' ? 'application/json' : null) },
          text: async () => JSON.stringify({ message: 'Group not found' }),
        });

        await expect(api.validateGroupExists('nonexistent-group')).rejects.toThrow(/Group.*not found/i);
      });

      it('should throw error when API returns error object', async () => {
        const responseData = { error: 'Invalid group' };
        mockFetch.mockResolvedValueOnce({
          ok: true,
          status: 200,
          headers: { get: (key: string) => (key === 'content-type' ? 'application/json' : null) },
          text: async () => JSON.stringify(responseData),
        });

        await expect(api.validateGroupExists('bad-group')).rejects.toThrow('Group "bad-group" not found.');
      });

      it('should encode group name in URL', async () => {
        const responseData = { name: 'Team Members' };
        mockFetch.mockResolvedValueOnce({
          ok: true,
          status: 200,
          headers: { get: (key: string) => (key === 'content-type' ? 'application/json' : null) },
          text: async () => JSON.stringify(responseData),
        });

        await api.validateGroupExists('Team Members');

        expect(mockFetch).toHaveBeenCalledWith(expect.stringContaining('/group/Team%20Members'), expect.any(Object));
      });
    });
  });
});
