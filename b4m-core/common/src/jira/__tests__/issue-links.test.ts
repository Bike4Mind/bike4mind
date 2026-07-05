import { describe, it, expect, vi, beforeEach } from 'vitest';
import { JiraApi, isValidIssueKey } from '../api';
import type { JiraConfig } from '../api';

describe('JiraApi Issue Link Operations', () => {
  let mockConfig: JiraConfig;
  let jiraApi: JiraApi;

  beforeEach(() => {
    mockConfig = {
      accessToken: 'test-token',
      cloudId: 'test-cloud-id',
      siteUrl: 'https://test.atlassian.net',
      webBaseUrl: 'https://test.atlassian.net/browse',
      apiBaseUrl: 'https://api.atlassian.com/ex/jira/test-cloud-id/rest/api/3',
      authHeader: 'Bearer test-token',
    };
    jiraApi = new JiraApi(mockConfig);
    global.fetch = vi.fn();
  });

  describe('isValidIssueKey', () => {
    it('should return true for valid issue keys', () => {
      expect(isValidIssueKey('PROJ-123')).toBe(true);
      expect(isValidIssueKey('ABC-1')).toBe(true);
      expect(isValidIssueKey('A1-999')).toBe(true);
      expect(isValidIssueKey('MYPROJECT-12345')).toBe(true);
    });

    it('should return false for invalid issue keys', () => {
      expect(isValidIssueKey('proj-123')).toBe(false); // lowercase
      expect(isValidIssueKey('PROJ123')).toBe(false); // missing dash
      expect(isValidIssueKey('PROJ-')).toBe(false); // missing number
      expect(isValidIssueKey('-123')).toBe(false); // missing project
      expect(isValidIssueKey('123-PROJ')).toBe(false); // reversed
      expect(isValidIssueKey('')).toBe(false); // empty
    });
  });

  describe('getIssueLinkTypes', () => {
    it('should call GET /issueLinkType and return formatted link types', async () => {
      const mockFetch = global.fetch as ReturnType<typeof vi.fn>;
      const mockResponse = {
        issueLinkTypes: [
          {
            id: '10000',
            name: 'Blocks',
            inward: 'is blocked by',
            outward: 'blocks',
            self: 'https://api.atlassian.com/...',
          },
          {
            id: '10001',
            name: 'Duplicate',
            inward: 'is duplicated by',
            outward: 'duplicates',
            self: 'https://api.atlassian.com/...',
          },
        ],
      };

      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => mockResponse,
      } as Response);

      const result = await jiraApi.getIssueLinkTypes();

      expect(mockFetch).toHaveBeenCalledTimes(1);
      const callArgs = mockFetch.mock.calls[0];
      expect(callArgs[0]).toContain('/issueLinkType');
      expect(callArgs[1]?.method).toBe('GET');

      // Should strip 'self' field
      expect(result).toEqual([
        { id: '10000', name: 'Blocks', inward: 'is blocked by', outward: 'blocks' },
        { id: '10001', name: 'Duplicate', inward: 'is duplicated by', outward: 'duplicates' },
      ]);
    });
  });

  describe('getIssueLinks', () => {
    it('should call GET /issue/{key}?fields=issuelinks', async () => {
      const mockFetch = global.fetch as ReturnType<typeof vi.fn>;
      const mockResponse = {
        fields: {
          issuelinks: [
            {
              id: '10100',
              type: { id: '10000', name: 'Blocks', inward: 'is blocked by', outward: 'blocks' },
              outwardIssue: {
                id: '10001',
                key: 'PROJ-2',
                fields: { summary: 'Blocked Issue', status: { id: '1', name: 'Open' } },
              },
            },
          ],
        },
      };

      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => mockResponse,
      } as Response);

      const result = await jiraApi.getIssueLinks({ issueKey: 'PROJ-1' });

      expect(mockFetch).toHaveBeenCalledTimes(1);
      const callArgs = mockFetch.mock.calls[0];
      expect(callArgs[0]).toContain('/issue/PROJ-1');
      expect(callArgs[0]).toContain('fields=issuelinks');
      expect(callArgs[1]?.method).toBe('GET');

      expect(result).toHaveLength(1);
      expect(result[0].id).toBe('10100');
      expect(result[0].outwardIssue?.key).toBe('PROJ-2');
      expect(result[0].outwardIssue?.link).toBe('https://test.atlassian.net/browse/PROJ-2');
    });

    it('should handle issue with no links (empty array)', async () => {
      const mockFetch = global.fetch as ReturnType<typeof vi.fn>;
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ fields: { issuelinks: [] } }),
      } as Response);

      const result = await jiraApi.getIssueLinks({ issueKey: 'PROJ-1' });

      expect(result).toEqual([]);
    });

    it('should throw error for invalid issue key format', async () => {
      await expect(jiraApi.getIssueLinks({ issueKey: 'invalid' })).rejects.toThrow('Invalid issue key format: invalid');
    });
  });

  describe('createIssueLink', () => {
    beforeEach(() => {
      // First call returns link types for validation
      const mockFetch = global.fetch as ReturnType<typeof vi.fn>;
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          issueLinkTypes: [{ id: '10000', name: 'Blocks', inward: 'is blocked by', outward: 'blocks' }],
        }),
      } as Response);
    });

    it('should map sourceIssue to outwardIssue and targetIssue to inwardIssue', async () => {
      const mockFetch = global.fetch as ReturnType<typeof vi.fn>;
      // Second call creates the link
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 201,
        json: async () => ({}),
      } as Response);

      await jiraApi.createIssueLink({
        linkType: 'Blocks',
        sourceIssue: 'PROJ-1',
        targetIssue: 'PROJ-2',
      });

      expect(mockFetch).toHaveBeenCalledTimes(2);
      const createCallArgs = mockFetch.mock.calls[1];
      expect(createCallArgs[0]).toContain('/issueLink');
      expect(createCallArgs[1]?.method).toBe('POST');

      const body = JSON.parse(createCallArgs[1]?.body as string);
      expect(body.type.name).toBe('Blocks');
      expect(body.outwardIssue.key).toBe('PROJ-1'); // sourceIssue -> outwardIssue
      expect(body.inwardIssue.key).toBe('PROJ-2'); // targetIssue -> inwardIssue
    });

    it('should match link type case-insensitively', async () => {
      const mockFetch = global.fetch as ReturnType<typeof vi.fn>;
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 201,
        json: async () => ({}),
      } as Response);

      await jiraApi.createIssueLink({
        linkType: 'blocks', // lowercase
        sourceIssue: 'PROJ-1',
        targetIssue: 'PROJ-2',
      });

      const body = JSON.parse(mockFetch.mock.calls[1][1]?.body as string);
      expect(body.type.name).toBe('Blocks'); // Should use correct casing from API
    });

    it('should throw error for invalid source issue key format', async () => {
      await expect(
        jiraApi.createIssueLink({ linkType: 'Blocks', sourceIssue: 'invalid', targetIssue: 'PROJ-2' })
      ).rejects.toThrow('Invalid source issue key format');
    });

    it('should throw error for invalid target issue key format', async () => {
      await expect(
        jiraApi.createIssueLink({ linkType: 'Blocks', sourceIssue: 'PROJ-1', targetIssue: 'invalid' })
      ).rejects.toThrow('Invalid target issue key format');
    });

    it('should throw error for invalid link type', async () => {
      await expect(
        jiraApi.createIssueLink({ linkType: 'InvalidType', sourceIssue: 'PROJ-1', targetIssue: 'PROJ-2' })
      ).rejects.toThrow('Invalid link type: "InvalidType"');
    });
  });

  describe('deleteIssueLink', () => {
    it('should call DELETE /issueLink/{linkId}', async () => {
      const mockFetch = global.fetch as ReturnType<typeof vi.fn>;
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 204,
        text: async () => '',
      } as Response);

      await jiraApi.deleteIssueLink({ linkId: '10100' });

      expect(mockFetch).toHaveBeenCalledTimes(1);
      const callArgs = mockFetch.mock.calls[0];
      expect(callArgs[0]).toContain('/issueLink/10100');
      expect(callArgs[1]?.method).toBe('DELETE');
    });
  });

  describe('findIssueLink', () => {
    it('should find link by searching outward links', async () => {
      const mockFetch = global.fetch as ReturnType<typeof vi.fn>;
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          fields: {
            issuelinks: [
              {
                id: '10100',
                type: { name: 'Blocks', inward: 'is blocked by', outward: 'blocks' },
                outwardIssue: { key: 'PROJ-2', fields: { summary: 'Test', status: { name: 'Open' } } },
              },
            ],
          },
        }),
      } as Response);

      const linkId = await jiraApi.findIssueLink({
        issueKey: 'PROJ-1',
        linkedIssueKey: 'PROJ-2',
        linkType: 'Blocks',
      });

      expect(linkId).toBe('10100');
    });

    it('should find link by searching inward links (bidirectional)', async () => {
      const mockFetch = global.fetch as ReturnType<typeof vi.fn>;
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          fields: {
            issuelinks: [
              {
                id: '10101',
                type: { name: 'Blocks', inward: 'is blocked by', outward: 'blocks' },
                inwardIssue: { key: 'PROJ-3', fields: { summary: 'Test', status: { name: 'Open' } } },
              },
            ],
          },
        }),
      } as Response);

      const linkId = await jiraApi.findIssueLink({
        issueKey: 'PROJ-1',
        linkedIssueKey: 'PROJ-3',
        linkType: 'Blocks',
      });

      expect(linkId).toBe('10101');
    });

    it('should match link type case-insensitively', async () => {
      const mockFetch = global.fetch as ReturnType<typeof vi.fn>;
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          fields: {
            issuelinks: [
              {
                id: '10100',
                type: { name: 'Blocks', inward: 'is blocked by', outward: 'blocks' },
                outwardIssue: { key: 'PROJ-2', fields: { summary: 'Test', status: { name: 'Open' } } },
              },
            ],
          },
        }),
      } as Response);

      const linkId = await jiraApi.findIssueLink({
        issueKey: 'PROJ-1',
        linkedIssueKey: 'PROJ-2',
        linkType: 'blocks', // lowercase
      });

      expect(linkId).toBe('10100');
    });

    it('should return null when no matching link found', async () => {
      const mockFetch = global.fetch as ReturnType<typeof vi.fn>;
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          fields: {
            issuelinks: [
              {
                id: '10100',
                type: { name: 'Duplicate', inward: 'is duplicated by', outward: 'duplicates' },
                outwardIssue: { key: 'PROJ-2', fields: { summary: 'Test', status: { name: 'Open' } } },
              },
            ],
          },
        }),
      } as Response);

      const linkId = await jiraApi.findIssueLink({
        issueKey: 'PROJ-1',
        linkedIssueKey: 'PROJ-2',
        linkType: 'Blocks', // Different type
      });

      expect(linkId).toBeNull();
    });

    it('should throw error for invalid issue key format', async () => {
      await expect(
        jiraApi.findIssueLink({ issueKey: 'invalid', linkedIssueKey: 'PROJ-2', linkType: 'Blocks' })
      ).rejects.toThrow('Invalid issue key format');
    });

    it('should throw error for invalid linked issue key format', async () => {
      await expect(
        jiraApi.findIssueLink({ issueKey: 'PROJ-1', linkedIssueKey: 'invalid', linkType: 'Blocks' })
      ).rejects.toThrow('Invalid linked issue key format');
    });
  });

  describe('Error Handling', () => {
    it('should handle 400 error from API', async () => {
      const mockFetch = global.fetch as ReturnType<typeof vi.fn>;
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 400,
        headers: new Headers({ 'content-type': 'application/json' }),
        text: async () => 'Bad Request: Invalid link type',
      } as Response);

      await expect(jiraApi.getIssueLinkTypes()).rejects.toThrow('Jira API error (400)');
    });

    it('should handle 403 permission denied', async () => {
      const mockFetch = global.fetch as ReturnType<typeof vi.fn>;
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 403,
        headers: new Headers({ 'content-type': 'application/json' }),
        text: async () => 'Forbidden: Insufficient permissions',
      } as Response);

      await expect(jiraApi.getIssueLinkTypes()).rejects.toThrow('Jira API error (403)');
    });

    it('should handle 404 issue not found', async () => {
      const mockFetch = global.fetch as ReturnType<typeof vi.fn>;
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 404,
        headers: new Headers({ 'content-type': 'application/json' }),
        text: async () => 'Issue not found: PROJ-999',
      } as Response);

      await expect(jiraApi.getIssueLinks({ issueKey: 'PROJ-999' })).rejects.toThrow('Jira API error (404)');
    });
  });
});
