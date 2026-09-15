import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the client module
vi.mock('../../client.js', () => ({
  octokit: {
    orgs: {
      listIssueTypes: vi.fn(),
    },
  },
}));

import { registerIssueTypeTools } from '../../tools/issue-types.js';
import { octokit } from '../../client.js';
import { TOOL_LIST_ORG_ISSUE_TYPES } from '../../constants.js';
import { createMockServer, parseResponse, type RegisteredTool } from '../test-utils.js';

describe('Issue Type Tools', () => {
  let registeredTools: Map<string, RegisteredTool>;

  beforeEach(() => {
    vi.clearAllMocks();
    const mock = createMockServer();
    registeredTools = mock.registeredTools;
    registerIssueTypeTools(mock.server);
  });

  describe(TOOL_LIST_ORG_ISSUE_TYPES, () => {
    it('should register the tool', () => {
      expect(registeredTools.has(TOOL_LIST_ORG_ISSUE_TYPES)).toBe(true);
    });

    it('should return issue types on success', async () => {
      const mockIssueTypes = {
        data: [
          { id: 1, name: 'Bug', description: 'Something is broken' },
          { id: 2, name: 'Feature', description: 'New functionality' },
          { id: 3, name: 'Task', description: 'Work to be done' },
        ],
      };

      vi.mocked(octokit.orgs.listIssueTypes).mockResolvedValueOnce(mockIssueTypes as never);

      const tool = registeredTools.get(TOOL_LIST_ORG_ISSUE_TYPES);
      const result = await tool!.handler({ org: 'my-org' });

      expect(result.isError).toBeUndefined();
      const parsed = parseResponse(result);
      expect(parsed.success).toBe(true);
      expect(parsed.issue_types).toHaveLength(3);
      expect((parsed.issue_types as Array<{ name: string }>)[0].name).toBe('Bug');
    });

    it('should pass org parameter to API', async () => {
      vi.mocked(octokit.orgs.listIssueTypes).mockResolvedValueOnce({ data: [] } as never);

      const tool = registeredTools.get(TOOL_LIST_ORG_ISSUE_TYPES);
      await tool!.handler({ org: 'test-organization' });

      expect(octokit.orgs.listIssueTypes).toHaveBeenCalledWith({
        org: 'test-organization',
      });
    });

    it('should return error with hint for 404', async () => {
      const error = new Error('Not Found');
      (error as { status?: number }).status = 404;
      vi.mocked(octokit.orgs.listIssueTypes).mockRejectedValueOnce(error);

      const tool = registeredTools.get(TOOL_LIST_ORG_ISSUE_TYPES);
      const result = await tool!.handler({ org: 'nonexistent-org' });

      expect(result.isError).toBe(true);
      const parsed = parseResponse(result);
      expect(parsed.success).toBe(false);
      expect(parsed.status).toBe(404);
      expect(parsed.hint).toContain('Issue types may not be enabled');
    });

    it('should return error with permission hint for other errors', async () => {
      const error = new Error('Forbidden');
      (error as { status?: number }).status = 403;
      vi.mocked(octokit.orgs.listIssueTypes).mockRejectedValueOnce(error);

      const tool = registeredTools.get(TOOL_LIST_ORG_ISSUE_TYPES);
      const result = await tool!.handler({ org: 'private-org' });

      expect(result.isError).toBe(true);
      const parsed = parseResponse(result);
      expect(parsed.hint).toContain('permission');
    });

    it('should include organization name in error response', async () => {
      vi.mocked(octokit.orgs.listIssueTypes).mockRejectedValueOnce(new Error('Error'));

      const tool = registeredTools.get(TOOL_LIST_ORG_ISSUE_TYPES);
      const result = await tool!.handler({ org: 'my-org' });

      const parsed = parseResponse(result);
      expect(parsed.organization).toBe('my-org');
    });
  });
});
