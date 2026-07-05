import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the config module
vi.mock('../../config.js', () => ({
  githubToken: 'mock-token',
}));

// Mock the client module
vi.mock('../../client.js', () => ({
  octokit: {
    actions: {
      listWorkflowRunsForRepo: vi.fn(),
      getWorkflowRun: vi.fn(),
      listJobsForWorkflowRun: vi.fn(),
      downloadJobLogsForWorkflowRun: vi.fn(),
      downloadWorkflowRunLogs: vi.fn(),
    },
  },
}));

// Mock unzipper
vi.mock('unzipper', () => ({
  Open: {
    buffer: vi.fn(),
  },
}));

// Mock global fetch
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

import { registerWorkflowTools } from '../../tools/workflows.js';
import { octokit } from '../../client.js';
import {
  TOOL_LIST_WORKFLOW_RUNS,
  TOOL_GET_WORKFLOW_RUN_DETAILS,
  TOOL_GET_WORKFLOW_RUN_LOGS,
  TOOL_GET_JOB_LOGS,
} from '../../constants.js';
import * as unzipper from 'unzipper';
import { createMockServer, parseResponse, type RegisteredTool } from '../test-utils.js';

describe('Workflow Tools', () => {
  let registeredTools: Map<string, RegisteredTool>;

  beforeEach(() => {
    vi.resetAllMocks();
    const mock = createMockServer();
    registeredTools = mock.registeredTools;
    registerWorkflowTools(mock.server);
  });

  describe(TOOL_LIST_WORKFLOW_RUNS, () => {
    it('should register the tool', () => {
      expect(registeredTools.has(TOOL_LIST_WORKFLOW_RUNS)).toBe(true);
    });

    it('should return workflow runs on success', async () => {
      const mockRuns = {
        data: {
          total_count: 2,
          workflow_runs: [
            {
              id: 12345,
              name: 'CI',
              head_branch: 'main',
              head_sha: 'abc1234567890',
              status: 'completed',
              conclusion: 'success',
              event: 'push',
              run_number: 42,
              run_started_at: '2024-01-15T10:00:00Z',
              updated_at: '2024-01-15T10:05:00Z',
              html_url: 'https://github.com/owner/repo/actions/runs/12345',
              pull_requests: [],
            },
            {
              id: 12346,
              name: 'CI',
              head_branch: 'feature/test',
              head_sha: 'def7890123456',
              status: 'completed',
              conclusion: 'failure',
              event: 'pull_request',
              run_number: 43,
              run_started_at: '2024-01-15T11:00:00Z',
              updated_at: '2024-01-15T11:10:00Z',
              html_url: 'https://github.com/owner/repo/actions/runs/12346',
              pull_requests: [{ number: 123, url: 'https://api.github.com/repos/owner/repo/pulls/123' }],
            },
          ],
        },
      };

      vi.mocked(octokit.actions.listWorkflowRunsForRepo).mockResolvedValueOnce(mockRuns as never);

      const tool = registeredTools.get(TOOL_LIST_WORKFLOW_RUNS);
      const result = await tool!.handler({ owner: 'owner', repo: 'repo' });

      expect(result.isError).toBeUndefined();
      const parsed = parseResponse(result);
      expect(parsed.success).toBe(true);
      expect(parsed.total_count).toBe(2);
      expect(parsed.workflow_runs).toHaveLength(2);
      expect((parsed.workflow_runs as Array<{ id: number }>)[0].id).toBe(12345);
      expect((parsed.workflow_runs as Array<{ head_sha: string }>)[0].head_sha).toBe('abc1234');
    });

    it('should filter by branch', async () => {
      vi.mocked(octokit.actions.listWorkflowRunsForRepo).mockResolvedValueOnce({
        data: { total_count: 0, workflow_runs: [] },
      } as never);

      const tool = registeredTools.get(TOOL_LIST_WORKFLOW_RUNS);
      await tool!.handler({ owner: 'owner', repo: 'repo', branch: 'main' });

      expect(octokit.actions.listWorkflowRunsForRepo).toHaveBeenCalledWith(
        expect.objectContaining({
          branch: 'main',
        })
      );
    });

    it('should filter by status', async () => {
      vi.mocked(octokit.actions.listWorkflowRunsForRepo).mockResolvedValueOnce({
        data: { total_count: 0, workflow_runs: [] },
      } as never);

      const tool = registeredTools.get(TOOL_LIST_WORKFLOW_RUNS);
      await tool!.handler({ owner: 'owner', repo: 'repo', status: 'failure' });

      expect(octokit.actions.listWorkflowRunsForRepo).toHaveBeenCalledWith(
        expect.objectContaining({
          status: 'failure',
        })
      );
    });

    it('should filter by event', async () => {
      vi.mocked(octokit.actions.listWorkflowRunsForRepo).mockResolvedValueOnce({
        data: { total_count: 0, workflow_runs: [] },
      } as never);

      const tool = registeredTools.get(TOOL_LIST_WORKFLOW_RUNS);
      await tool!.handler({ owner: 'owner', repo: 'repo', event: 'pull_request' });

      expect(octokit.actions.listWorkflowRunsForRepo).toHaveBeenCalledWith(
        expect.objectContaining({
          event: 'pull_request',
        })
      );
    });

    it('should handle API errors', async () => {
      vi.mocked(octokit.actions.listWorkflowRunsForRepo).mockRejectedValueOnce(new Error('API Error'));

      const tool = registeredTools.get(TOOL_LIST_WORKFLOW_RUNS);
      const result = await tool!.handler({ owner: 'owner', repo: 'repo' });

      expect(result.isError).toBe(true);
      const parsed = parseResponse(result);
      expect(parsed.success).toBe(false);
    });

    it('should handle rate limit error with suggestion', async () => {
      const rateLimitError = new Error('API rate limit exceeded');
      (rateLimitError as Error & { status: number }).status = 403;
      vi.mocked(octokit.actions.listWorkflowRunsForRepo).mockRejectedValueOnce(rateLimitError);

      const tool = registeredTools.get(TOOL_LIST_WORKFLOW_RUNS);
      const result = await tool!.handler({ owner: 'owner', repo: 'repo' });

      expect(result.isError).toBe(true);
      const parsed = parseResponse(result);
      expect(parsed.suggestion).toContain('rate limit');
    });

    it('should use default per_page of 10', async () => {
      vi.mocked(octokit.actions.listWorkflowRunsForRepo).mockResolvedValueOnce({
        data: { total_count: 0, workflow_runs: [] },
      } as never);

      const tool = registeredTools.get(TOOL_LIST_WORKFLOW_RUNS);
      await tool!.handler({ owner: 'owner', repo: 'repo' });

      expect(octokit.actions.listWorkflowRunsForRepo).toHaveBeenCalledWith(
        expect.objectContaining({
          per_page: 10,
        })
      );
    });

    it('should support custom per_page parameter', async () => {
      vi.mocked(octokit.actions.listWorkflowRunsForRepo).mockResolvedValueOnce({
        data: { total_count: 0, workflow_runs: [] },
      } as never);

      const tool = registeredTools.get(TOOL_LIST_WORKFLOW_RUNS);
      await tool!.handler({ owner: 'owner', repo: 'repo', per_page: 50 });

      expect(octokit.actions.listWorkflowRunsForRepo).toHaveBeenCalledWith(
        expect.objectContaining({
          per_page: 50,
        })
      );
    });

    it('should support page parameter for pagination', async () => {
      vi.mocked(octokit.actions.listWorkflowRunsForRepo).mockResolvedValueOnce({
        data: { total_count: 0, workflow_runs: [] },
      } as never);

      const tool = registeredTools.get(TOOL_LIST_WORKFLOW_RUNS);
      await tool!.handler({ owner: 'owner', repo: 'repo', page: 3 });

      expect(octokit.actions.listWorkflowRunsForRepo).toHaveBeenCalledWith(
        expect.objectContaining({
          page: 3,
        })
      );
    });

    it('should support both per_page and page parameters together', async () => {
      vi.mocked(octokit.actions.listWorkflowRunsForRepo).mockResolvedValueOnce({
        data: { total_count: 0, workflow_runs: [] },
      } as never);

      const tool = registeredTools.get(TOOL_LIST_WORKFLOW_RUNS);
      await tool!.handler({ owner: 'owner', repo: 'repo', per_page: 25, page: 2 });

      expect(octokit.actions.listWorkflowRunsForRepo).toHaveBeenCalledWith(
        expect.objectContaining({
          per_page: 25,
          page: 2,
        })
      );
    });
  });

  describe(TOOL_GET_WORKFLOW_RUN_DETAILS, () => {
    const mockRun = {
      data: {
        id: 12345,
        name: 'CI',
        head_branch: 'main',
        head_sha: 'abc1234567890',
        status: 'completed',
        conclusion: 'failure',
        event: 'push',
        run_number: 42,
        run_attempt: 1,
        run_started_at: '2024-01-15T10:00:00Z',
        updated_at: '2024-01-15T10:05:00Z',
        html_url: 'https://github.com/owner/repo/actions/runs/12345',
        workflow_id: 999,
        head_commit: {
          message: 'Fix bug\n\nDetailed description',
          author: { name: 'Developer' },
        },
        pull_requests: [],
      },
    };

    const mockJobs = {
      data: {
        total_count: 2,
        jobs: [
          {
            id: 67890,
            name: 'build',
            status: 'completed',
            conclusion: 'success',
            started_at: '2024-01-15T10:00:00Z',
            completed_at: '2024-01-15T10:02:00Z',
            steps: [
              { name: 'Checkout', status: 'completed', conclusion: 'success', number: 1 },
              { name: 'Build', status: 'completed', conclusion: 'success', number: 2 },
            ],
          },
          {
            id: 67891,
            name: 'test',
            status: 'completed',
            conclusion: 'failure',
            started_at: '2024-01-15T10:02:00Z',
            completed_at: '2024-01-15T10:05:00Z',
            steps: [
              { name: 'Checkout', status: 'completed', conclusion: 'success', number: 1 },
              { name: 'Test', status: 'completed', conclusion: 'failure', number: 2 },
            ],
          },
        ],
      },
    };

    it('should register the tool', () => {
      expect(registeredTools.has(TOOL_GET_WORKFLOW_RUN_DETAILS)).toBe(true);
    });

    it('should return run details with jobs on success', async () => {
      vi.mocked(octokit.actions.getWorkflowRun).mockResolvedValueOnce(mockRun as never);
      vi.mocked(octokit.actions.listJobsForWorkflowRun).mockResolvedValueOnce(mockJobs as never);

      const tool = registeredTools.get(TOOL_GET_WORKFLOW_RUN_DETAILS);
      const result = await tool!.handler({ owner: 'owner', repo: 'repo', run_id: 12345 });

      expect(result.isError).toBeUndefined();
      const parsed = parseResponse(result);
      expect(parsed.success).toBe(true);
      expect((parsed.workflow_run as { id: number }).id).toBe(12345);
      expect((parsed.workflow_run as { head_sha: string }).head_sha).toBe('abc1234');
      expect(parsed.jobs).toHaveLength(2);
    });

    it('should include failure summary for failed runs', async () => {
      vi.mocked(octokit.actions.getWorkflowRun).mockResolvedValueOnce(mockRun as never);
      vi.mocked(octokit.actions.listJobsForWorkflowRun).mockResolvedValueOnce(mockJobs as never);

      const tool = registeredTools.get(TOOL_GET_WORKFLOW_RUN_DETAILS);
      const result = await tool!.handler({ owner: 'owner', repo: 'repo', run_id: 12345 });

      const parsed = parseResponse(result);
      expect(parsed.failure_summary).not.toBeNull();
      expect((parsed.failure_summary as Array<{ job: string }>)[0].job).toBe('test');
      expect((parsed.failure_summary as Array<{ failed_steps: string[] }>)[0].failed_steps).toContain('Test');
    });

    it('should truncate commit message to first line', async () => {
      vi.mocked(octokit.actions.getWorkflowRun).mockResolvedValueOnce(mockRun as never);
      vi.mocked(octokit.actions.listJobsForWorkflowRun).mockResolvedValueOnce(mockJobs as never);

      const tool = registeredTools.get(TOOL_GET_WORKFLOW_RUN_DETAILS);
      const result = await tool!.handler({ owner: 'owner', repo: 'repo', run_id: 12345 });

      const parsed = parseResponse(result);
      expect((parsed.workflow_run as { head_commit: { message: string } }).head_commit.message).toBe('Fix bug');
    });

    it('should handle API errors', async () => {
      vi.mocked(octokit.actions.getWorkflowRun).mockRejectedValueOnce(new Error('Not found'));

      const tool = registeredTools.get(TOOL_GET_WORKFLOW_RUN_DETAILS);
      const result = await tool!.handler({ owner: 'owner', repo: 'repo', run_id: 99999 });

      expect(result.isError).toBe(true);
      const parsed = parseResponse(result);
      expect(parsed.success).toBe(false);
    });

    it('should fetch run and jobs in parallel', async () => {
      vi.mocked(octokit.actions.getWorkflowRun).mockResolvedValueOnce(mockRun as never);
      vi.mocked(octokit.actions.listJobsForWorkflowRun).mockResolvedValueOnce(mockJobs as never);

      const tool = registeredTools.get(TOOL_GET_WORKFLOW_RUN_DETAILS);
      await tool!.handler({ owner: 'owner', repo: 'repo', run_id: 12345 });

      // Both should be called
      expect(octokit.actions.getWorkflowRun).toHaveBeenCalledTimes(1);
      expect(octokit.actions.listJobsForWorkflowRun).toHaveBeenCalledTimes(1);
    });
  });

  describe(TOOL_GET_JOB_LOGS, () => {
    it('should register the tool', () => {
      expect(registeredTools.has(TOOL_GET_JOB_LOGS)).toBe(true);
    });

    it('should return logs on success', async () => {
      const logContent = 'Line 1\nLine 2\nLine 3\n';
      vi.mocked(octokit.actions.downloadJobLogsForWorkflowRun).mockResolvedValueOnce({
        data: logContent,
      } as never);

      const tool = registeredTools.get(TOOL_GET_JOB_LOGS);
      const result = await tool!.handler({ owner: 'owner', repo: 'repo', job_id: 67890 });

      expect(result.isError).toBeUndefined();
      const parsed = parseResponse(result);
      expect(parsed.success).toBe(true);
      expect(parsed.job_id).toBe(67890);
      expect(typeof parsed.logs).toBe('string');
    });

    it('should filter to specific step when step_name provided', async () => {
      const logContent = `##[group]Run Checkout
Checkout step logs here
##[endgroup]
##[group]Run Test
Test step logs here
error: Test failed
##[endgroup]
##[group]Run Cleanup
Cleanup logs
##[endgroup]`;
      vi.mocked(octokit.actions.downloadJobLogsForWorkflowRun).mockResolvedValueOnce({
        data: logContent,
      } as never);

      const tool = registeredTools.get(TOOL_GET_JOB_LOGS);
      const result = await tool!.handler({
        owner: 'owner',
        repo: 'repo',
        job_id: 67890,
        step_name: 'Test',
      });

      const parsed = parseResponse(result);
      expect(parsed.success).toBe(true);
      expect(parsed.step_filter).toBe('Test');
      expect(parsed.logs as string).toContain('Test step logs');
      expect(parsed.logs as string).not.toContain('Checkout step logs');
    });

    it('should summarize errors by default', async () => {
      const logContent = `Starting build...
Installing dependencies...
Running tests...
error: Test suite failed
AssertionError: expected true to be false
  at TestCase.run (test.js:42)
Cleaning up...
Done.`;
      vi.mocked(octokit.actions.downloadJobLogsForWorkflowRun).mockResolvedValueOnce({
        data: logContent,
      } as never);

      const tool = registeredTools.get(TOOL_GET_JOB_LOGS);
      const result = await tool!.handler({ owner: 'owner', repo: 'repo', job_id: 67890 });

      const parsed = parseResponse(result);
      expect(parsed.success).toBe(true);
      // Should contain error context
      expect(parsed.logs as string).toContain('error:');
    });

    it('should return last N lines when summarize_errors is false', async () => {
      const logLines = Array.from({ length: 200 }, (_, i) => `Line ${i + 1}`).join('\n');
      vi.mocked(octokit.actions.downloadJobLogsForWorkflowRun).mockResolvedValueOnce({
        data: logLines,
      } as never);

      const tool = registeredTools.get(TOOL_GET_JOB_LOGS);
      const result = await tool!.handler({
        owner: 'owner',
        repo: 'repo',
        job_id: 67890,
        summarize_errors: false,
        tail_lines: 50,
      });

      const parsed = parseResponse(result);
      expect(parsed.success).toBe(true);
      expect(parsed.logs as string).toContain('Line 200');
      expect(parsed.logs as string).toContain('Line 151');
      expect(parsed.logs as string).not.toContain('Line 100');
    });

    it('should handle API errors', async () => {
      vi.mocked(octokit.actions.downloadJobLogsForWorkflowRun).mockRejectedValueOnce(new Error('Not found'));

      const tool = registeredTools.get(TOOL_GET_JOB_LOGS);
      const result = await tool!.handler({ owner: 'owner', repo: 'repo', job_id: 99999 });

      expect(result.isError).toBe(true);
      const parsed = parseResponse(result);
      expect(parsed.success).toBe(false);
    });

    it('should handle rate limit error with suggestion', async () => {
      const rateLimitError = new Error('API rate limit exceeded');
      (rateLimitError as Error & { status: number }).status = 403;
      vi.mocked(octokit.actions.downloadJobLogsForWorkflowRun).mockRejectedValueOnce(rateLimitError);

      const tool = registeredTools.get(TOOL_GET_JOB_LOGS);
      const result = await tool!.handler({ owner: 'owner', repo: 'repo', job_id: 67890 });

      expect(result.isError).toBe(true);
      const parsed = parseResponse(result);
      expect(parsed.suggestion).toContain('rate limit');
    });

    it('should handle ArrayBuffer log response', async () => {
      const logContent = 'Log content from ArrayBuffer';
      const encoder = new TextEncoder();
      const arrayBuffer = encoder.encode(logContent).buffer;

      vi.mocked(octokit.actions.downloadJobLogsForWorkflowRun).mockResolvedValueOnce({
        data: arrayBuffer,
      } as never);

      const tool = registeredTools.get(TOOL_GET_JOB_LOGS);
      const result = await tool!.handler({ owner: 'owner', repo: 'repo', job_id: 67890 });

      const parsed = parseResponse(result);
      expect(parsed.success).toBe(true);
      expect(parsed.logs as string).toContain('Log content');
    });

    it('should return step not found message for non-existent step', async () => {
      const logContent = `##[group]Run Checkout
Checkout logs
##[endgroup]`;
      vi.mocked(octokit.actions.downloadJobLogsForWorkflowRun).mockResolvedValueOnce({
        data: logContent,
      } as never);

      const tool = registeredTools.get(TOOL_GET_JOB_LOGS);
      const result = await tool!.handler({
        owner: 'owner',
        repo: 'repo',
        job_id: 67890,
        step_name: 'NonExistent',
      });

      const parsed = parseResponse(result);
      expect(parsed.success).toBe(true);
      expect(parsed.logs as string).toContain('not found');
    });
  });

  describe(TOOL_GET_WORKFLOW_RUN_LOGS, () => {
    const mockRun = {
      data: {
        id: 12345,
        name: 'CI',
        head_branch: 'main',
        head_sha: 'abc1234567890',
        status: 'completed',
        conclusion: 'failure',
        event: 'push',
        html_url: 'https://github.com/owner/repo/actions/runs/12345',
      },
    };

    const mockJobs = {
      data: {
        total_count: 2,
        jobs: [
          {
            id: 67890,
            name: 'build',
            status: 'completed',
            conclusion: 'success',
          },
          {
            id: 67891,
            name: 'test',
            status: 'completed',
            conclusion: 'failure',
          },
        ],
      },
    };

    beforeEach(() => {
      mockFetch.mockReset();
    });

    it('should register the tool', () => {
      expect(registeredTools.has(TOOL_GET_WORKFLOW_RUN_LOGS)).toBe(true);
    });

    it('should return summarized logs for failed run', async () => {
      vi.mocked(octokit.actions.getWorkflowRun).mockResolvedValueOnce(mockRun as never);
      vi.mocked(octokit.actions.listJobsForWorkflowRun).mockResolvedValueOnce(mockJobs as never);
      vi.mocked(octokit.actions.downloadWorkflowRunLogs).mockResolvedValueOnce({
        url: 'https://example.com/logs.zip',
      } as never);

      // Mock fetch for ZIP download
      const mockZipBuffer = Buffer.from('mock zip content');
      mockFetch.mockResolvedValueOnce({
        ok: true,
        arrayBuffer: () => Promise.resolve(mockZipBuffer),
      });

      // Mock unzipper
      vi.mocked(unzipper.Open.buffer).mockResolvedValueOnce({
        files: [
          {
            path: 'test/1_Checkout.txt',
            buffer: () => Promise.resolve(Buffer.from('Checkout logs\n')),
          },
          {
            path: 'test/2_Test.txt',
            buffer: () => Promise.resolve(Buffer.from('error: Test failed\nAssertionError: expected true\n')),
          },
        ],
      } as never);

      const tool = registeredTools.get(TOOL_GET_WORKFLOW_RUN_LOGS);
      const result = await tool!.handler({ owner: 'owner', repo: 'repo', run_id: 12345 });

      expect(result.isError).toBeUndefined();
      const parsed = parseResponse(result);
      expect(parsed.success).toBe(true);
      expect(parsed.run_id).toBe(12345);
      expect(parsed.conclusion).toBe('failure');
      expect(parsed.jobs_analyzed).toBe(1); // Only failed job
      expect(parsed.filtered_to_failed).toBe(true);
    });

    it('should return message when no failed jobs found with failed_only true', async () => {
      // Run that succeeded but user explicitly wants only failed jobs
      const successRun = {
        data: {
          ...mockRun.data,
          conclusion: 'success',
        },
      };
      const successJobs = {
        data: {
          total_count: 1,
          jobs: [
            {
              id: 67890,
              name: 'build',
              status: 'completed',
              conclusion: 'success',
            },
          ],
        },
      };

      vi.mocked(octokit.actions.getWorkflowRun).mockResolvedValueOnce(successRun as never);
      vi.mocked(octokit.actions.listJobsForWorkflowRun).mockResolvedValueOnce(successJobs as never);

      const tool = registeredTools.get(TOOL_GET_WORKFLOW_RUN_LOGS);
      // Explicitly request failed_only: true
      const result = await tool!.handler({ owner: 'owner', repo: 'repo', run_id: 12345, failed_only: true });

      const parsed = parseResponse(result);
      expect(parsed.success).toBe(true);
      expect(parsed.message).toContain('No failed jobs');
    });

    it('should include all jobs when failed_only is false', async () => {
      vi.mocked(octokit.actions.getWorkflowRun).mockResolvedValueOnce(mockRun as never);
      vi.mocked(octokit.actions.listJobsForWorkflowRun).mockResolvedValueOnce(mockJobs as never);
      vi.mocked(octokit.actions.downloadWorkflowRunLogs).mockResolvedValueOnce({
        url: 'https://example.com/logs.zip',
      } as never);

      const mockZipBuffer = Buffer.from('mock zip content');
      mockFetch.mockResolvedValueOnce({
        ok: true,
        arrayBuffer: () => Promise.resolve(mockZipBuffer),
      });

      vi.mocked(unzipper.Open.buffer).mockResolvedValueOnce({
        files: [
          {
            path: 'build/1_Build.txt',
            buffer: () => Promise.resolve(Buffer.from('Build successful\n')),
          },
          {
            path: 'test/1_Test.txt',
            buffer: () => Promise.resolve(Buffer.from('error: Test failed\n')),
          },
        ],
      } as never);

      const tool = registeredTools.get(TOOL_GET_WORKFLOW_RUN_LOGS);
      const result = await tool!.handler({
        owner: 'owner',
        repo: 'repo',
        run_id: 12345,
        failed_only: false,
      });

      const parsed = parseResponse(result);
      expect(parsed.success).toBe(true);
      expect(parsed.jobs_analyzed).toBe(2); // Both jobs
      expect(parsed.filtered_to_failed).toBe(false);
    });

    it('should handle API errors', async () => {
      vi.mocked(octokit.actions.getWorkflowRun).mockRejectedValueOnce(new Error('Not found'));

      const tool = registeredTools.get(TOOL_GET_WORKFLOW_RUN_LOGS);
      const result = await tool!.handler({ owner: 'owner', repo: 'repo', run_id: 99999 });

      expect(result.isError).toBe(true);
      const parsed = parseResponse(result);
      expect(parsed.success).toBe(false);
    });

    it('should handle fetch errors for ZIP download', async () => {
      vi.mocked(octokit.actions.getWorkflowRun).mockResolvedValueOnce(mockRun as never);
      vi.mocked(octokit.actions.listJobsForWorkflowRun).mockResolvedValueOnce(mockJobs as never);
      vi.mocked(octokit.actions.downloadWorkflowRunLogs).mockResolvedValueOnce({
        url: 'https://example.com/logs.zip',
      } as never);

      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 404,
        statusText: 'Not Found',
      });

      const tool = registeredTools.get(TOOL_GET_WORKFLOW_RUN_LOGS);
      const result = await tool!.handler({ owner: 'owner', repo: 'repo', run_id: 12345 });

      expect(result.isError).toBe(true);
      const parsed = parseResponse(result);
      expect(parsed.success).toBe(false);
      expect(parsed.error).toContain('Failed to download logs');
    });

    it('should handle rate limit error with suggestion', async () => {
      const rateLimitError = new Error('API rate limit exceeded');
      (rateLimitError as Error & { status: number }).status = 403;
      vi.mocked(octokit.actions.getWorkflowRun).mockRejectedValueOnce(rateLimitError);

      const tool = registeredTools.get(TOOL_GET_WORKFLOW_RUN_LOGS);
      const result = await tool!.handler({ owner: 'owner', repo: 'repo', run_id: 12345 });

      expect(result.isError).toBe(true);
      const parsed = parseResponse(result);
      expect(parsed.suggestion).toContain('rate limit');
    });

    it('should respect max_lines parameter for log summarization', async () => {
      vi.mocked(octokit.actions.getWorkflowRun).mockResolvedValueOnce(mockRun as never);
      vi.mocked(octokit.actions.listJobsForWorkflowRun).mockResolvedValueOnce(mockJobs as never);
      vi.mocked(octokit.actions.downloadWorkflowRunLogs).mockResolvedValueOnce({
        url: 'https://example.com/logs.zip',
      } as never);

      const mockZipBuffer = Buffer.from('mock zip content');
      mockFetch.mockResolvedValueOnce({
        ok: true,
        arrayBuffer: () => Promise.resolve(mockZipBuffer),
      });

      // Create log content with many lines including errors
      const longLogContent =
        Array.from({ length: 200 }, (_, i) => `Line ${i + 1}`).join('\n') +
        '\nerror: Test failed\n' +
        Array.from({ length: 50 }, (_, i) => `After error ${i + 1}`).join('\n');

      vi.mocked(unzipper.Open.buffer).mockResolvedValueOnce({
        files: [
          {
            path: 'test/1_Test.txt',
            buffer: () => Promise.resolve(Buffer.from(longLogContent)),
          },
        ],
      } as never);

      const tool = registeredTools.get(TOOL_GET_WORKFLOW_RUN_LOGS);
      const result = await tool!.handler({
        owner: 'owner',
        repo: 'repo',
        run_id: 12345,
        max_lines: 20,
      });

      const parsed = parseResponse(result);
      expect(parsed.success).toBe(true);
      // The summary should be limited
      const jobLogs = parsed.job_logs as Array<{ summary: string }>;
      expect(jobLogs).toHaveLength(1);
      // The summary should not contain all 250+ lines
      const summaryLines = jobLogs[0].summary.split('\n');
      expect(summaryLines.length).toBeLessThanOrEqual(25); // Allow some buffer for context
    });
  });
});
