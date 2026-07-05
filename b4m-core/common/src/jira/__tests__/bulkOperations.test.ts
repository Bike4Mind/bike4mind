import { describe, it, expect, vi, beforeEach } from 'vitest';
import { JiraApi } from '../api';
import type { JiraConfig } from '../api';

describe('JiraApi Bulk Operations', () => {
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
  });

  describe('bulkTransitionIssues', () => {
    describe('Input Validation', () => {
      it('should return early with empty message when issues array is empty', async () => {
        const result = await jiraApi.bulkTransitionIssues({ issues: [] });

        expect(result.taskId).toBe('');
        expect(result.message).toBe('No issues to transition');
        expect(result.issueCount).toBe(0);
      });

      it('should throw error when issues exceed 1000 limit', async () => {
        const issues = Array.from({ length: 1001 }, (_, i) => ({
          issueIdOrKey: `PROJ-${i}`,
          transitionId: '31',
        }));

        await expect(jiraApi.bulkTransitionIssues({ issues })).rejects.toThrow(
          'Bulk transition is limited to 1000 issues per request. Please split your request.'
        );
      });
    });

    describe('Valid Input Handling', () => {
      beforeEach(() => {
        global.fetch = vi.fn();
      });

      it('should call bulk transition endpoint with correct payload', async () => {
        const mockFetch = global.fetch as ReturnType<typeof vi.fn>;
        mockFetch.mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: async () => ({ taskId: 'task-123' }),
          text: async () => JSON.stringify({ taskId: 'task-123' }),
        } as Response);

        const result = await jiraApi.bulkTransitionIssues({
          issues: [
            { issueIdOrKey: 'PROJ-1', transitionId: '31' },
            { issueIdOrKey: 'PROJ-2', transitionId: '31' },
          ],
        });

        expect(mockFetch).toHaveBeenCalledTimes(1);
        const callArgs = mockFetch.mock.calls[0];
        expect(callArgs[0]).toContain('/bulk/issues/transition');
        expect(callArgs[1]?.method).toBe('POST');

        const body = JSON.parse(callArgs[1]?.body as string);
        expect(body.bulkTransitionInputs).toBeDefined();
        expect(body.bulkTransitionInputs[0].selectedIssueIdsOrKeys).toContain('PROJ-1');
        expect(body.bulkTransitionInputs[0].selectedIssueIdsOrKeys).toContain('PROJ-2');
        expect(body.bulkTransitionInputs[0].transitionId).toBe('31');

        expect(result.taskId).toBe('task-123');
        expect(result.issueCount).toBe(2);
      });

      it('should group issues by transitionId', async () => {
        const mockFetch = global.fetch as ReturnType<typeof vi.fn>;
        mockFetch.mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: async () => ({ taskId: 'task-456' }),
          text: async () => JSON.stringify({ taskId: 'task-456' }),
        } as Response);

        await jiraApi.bulkTransitionIssues({
          issues: [
            { issueIdOrKey: 'PROJ-1', transitionId: '31' },
            { issueIdOrKey: 'PROJ-2', transitionId: '41' },
            { issueIdOrKey: 'PROJ-3', transitionId: '31' },
          ],
        });

        const body = JSON.parse((mockFetch.mock.calls[0][1]?.body as string) || '{}');
        expect(body.bulkTransitionInputs).toHaveLength(2);

        const transition31 = body.bulkTransitionInputs.find((t: any) => t.transitionId === '31');
        const transition41 = body.bulkTransitionInputs.find((t: any) => t.transitionId === '41');

        expect(transition31.selectedIssueIdsOrKeys).toHaveLength(2);
        expect(transition31.selectedIssueIdsOrKeys).toContain('PROJ-1');
        expect(transition31.selectedIssueIdsOrKeys).toContain('PROJ-3');
        expect(transition41.selectedIssueIdsOrKeys).toHaveLength(1);
        expect(transition41.selectedIssueIdsOrKeys).toContain('PROJ-2');
      });

      it('should handle API error responses', async () => {
        const mockFetch = global.fetch as ReturnType<typeof vi.fn>;
        mockFetch.mockResolvedValueOnce({
          ok: false,
          status: 400,
          headers: new Headers({ 'content-type': 'application/json' }),
          text: async () => JSON.stringify({ errors: [{ message: 'Invalid transition' }] }),
        } as Response);

        await expect(
          jiraApi.bulkTransitionIssues({
            issues: [{ issueIdOrKey: 'PROJ-1', transitionId: 'invalid' }],
          })
        ).rejects.toThrow('Jira API error (400)');
      });
    });
  });

  describe('bulkUpdateIssues', () => {
    describe('Input Validation', () => {
      it('should return early with empty message when issues array is empty', async () => {
        const result = await jiraApi.bulkUpdateIssues({
          issueIdsOrKeys: [],
          labels: { values: ['test'], action: 'ADD' },
        });

        expect(result.taskId).toBe('');
        expect(result.message).toBe('No issues to update');
        expect(result.issueCount).toBe(0);
      });

      it('should throw error when issues exceed 1000 limit', async () => {
        const issueIdsOrKeys = Array.from({ length: 1001 }, (_, i) => `PROJ-${i}`);

        await expect(
          jiraApi.bulkUpdateIssues({
            issueIdsOrKeys,
            labels: { values: ['test'], action: 'ADD' },
          })
        ).rejects.toThrow('Bulk update is limited to 1000 issues per request. Please split your request.');
      });
    });

    describe('Valid Input Handling', () => {
      beforeEach(() => {
        global.fetch = vi.fn();
      });

      it('should call bulk update endpoint with correct payload for ADD action', async () => {
        const mockFetch = global.fetch as ReturnType<typeof vi.fn>;
        mockFetch.mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: async () => ({ taskId: 'task-789' }),
          text: async () => JSON.stringify({ taskId: 'task-789' }),
        } as Response);

        const result = await jiraApi.bulkUpdateIssues({
          issueIdsOrKeys: ['PROJ-1', 'PROJ-2', 'PROJ-3'],
          labels: { values: ['urgent', 'needs-review'], action: 'ADD' },
        });

        expect(mockFetch).toHaveBeenCalledTimes(1);
        const callArgs = mockFetch.mock.calls[0];
        expect(callArgs[0]).toContain('/bulk/issues/fields');
        expect(callArgs[1]?.method).toBe('POST');

        const body = JSON.parse(callArgs[1]?.body as string);
        expect(body.selectedActions).toContain('labels');
        expect(body.selectedIssueIdsOrKeys).toEqual(['PROJ-1', 'PROJ-2', 'PROJ-3']);
        expect(body.editedFieldsInput.labelsFields).toHaveLength(1);
        expect(body.editedFieldsInput.labelsFields[0].fieldId).toBe('labels');
        expect(body.editedFieldsInput.labelsFields[0].labels).toEqual([{ name: 'urgent' }, { name: 'needs-review' }]);
        expect(body.editedFieldsInput.labelsFields[0].bulkEditMultiSelectFieldOption).toBe('ADD');

        expect(result.taskId).toBe('task-789');
        expect(result.issueCount).toBe(3);
      });

      it('should handle REMOVE action correctly', async () => {
        const mockFetch = global.fetch as ReturnType<typeof vi.fn>;
        mockFetch.mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: async () => ({ taskId: 'task-remove' }),
          text: async () => JSON.stringify({ taskId: 'task-remove' }),
        } as Response);

        await jiraApi.bulkUpdateIssues({
          issueIdsOrKeys: ['PROJ-1'],
          labels: { values: ['old-label'], action: 'REMOVE' },
        });

        const body = JSON.parse((mockFetch.mock.calls[0][1]?.body as string) || '{}');
        expect(body.editedFieldsInput.labelsFields[0].bulkEditMultiSelectFieldOption).toBe('REMOVE');
      });

      it('should handle SET action correctly', async () => {
        const mockFetch = global.fetch as ReturnType<typeof vi.fn>;
        mockFetch.mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: async () => ({ taskId: 'task-set' }),
          text: async () => JSON.stringify({ taskId: 'task-set' }),
        } as Response);

        await jiraApi.bulkUpdateIssues({
          issueIdsOrKeys: ['PROJ-1'],
          labels: { values: ['only-this-label'], action: 'SET' },
        });

        const body = JSON.parse((mockFetch.mock.calls[0][1]?.body as string) || '{}');
        expect(body.editedFieldsInput.labelsFields[0].bulkEditMultiSelectFieldOption).toBe('SET');
      });

      it('should handle API error responses', async () => {
        const mockFetch = global.fetch as ReturnType<typeof vi.fn>;
        mockFetch.mockResolvedValueOnce({
          ok: false,
          status: 400,
          headers: new Headers({ 'content-type': 'application/json' }),
          text: async () =>
            JSON.stringify({ errors: [{ message: 'You are trying to perform an unavailable operation' }] }),
        } as Response);

        await expect(
          jiraApi.bulkUpdateIssues({
            issueIdsOrKeys: ['PROJ-1'],
            labels: { values: ['test'], action: 'ADD' },
          })
        ).rejects.toThrow('Jira API error (400)');
      });
    });
  });
});
