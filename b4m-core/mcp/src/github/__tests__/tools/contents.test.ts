import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the config module
vi.mock('../../config.js', () => ({
  githubToken: 'mock-token',
}));

// Mock the client module
vi.mock('../../client.js', () => ({
  octokit: {
    repos: {
      getContent: vi.fn(),
      createOrUpdateFileContents: vi.fn(),
    },
  },
}));

import { registerContentsTools } from '../../tools/contents.js';
import { octokit } from '../../client.js';
import { TOOL_CREATE_OR_UPDATE_FILE } from '../../constants.js';
import { createMockServer, parseResponse, type RegisteredTool } from '../test-utils.js';

describe('Contents Tools', () => {
  let registeredTools: Map<string, RegisteredTool>;

  beforeEach(() => {
    vi.clearAllMocks();
    const mock = createMockServer();
    registeredTools = mock.registeredTools;
    registerContentsTools(mock.server);
  });

  describe(TOOL_CREATE_OR_UPDATE_FILE, () => {
    const baseParams = {
      owner: 'owner',
      repo: 'repo',
      path: 'src/index.ts',
      content: 'console.log("Hello, World!");',
      message: 'Add index file',
    };

    it('should register the tool', () => {
      expect(registeredTools.has(TOOL_CREATE_OR_UPDATE_FILE)).toBe(true);
    });

    describe('Preview Mode', () => {
      it('should return preview for new file creation', async () => {
        // File doesn't exist - returns 404
        vi.mocked(octokit.repos.getContent).mockRejectedValueOnce({ status: 404 });

        const tool = registeredTools.get(TOOL_CREATE_OR_UPDATE_FILE);
        const result = await tool!.handler(baseParams);

        expect(result.isError).toBeUndefined();
        const parsed = parseResponse(result);
        expect(parsed.action).toBe('preview');
        expect(parsed.message).toContain('Created');
        expect(parsed.file).toMatchObject({
          action: 'create',
          path: 'src/index.ts',
          message: 'Add index file',
        });
      });

      it('should return preview for file update with auto-detected SHA', async () => {
        // File exists
        vi.mocked(octokit.repos.getContent).mockResolvedValueOnce({
          data: {
            type: 'file',
            sha: 'existing-sha-123',
            name: 'index.ts',
            path: 'src/index.ts',
          },
        } as never);

        const tool = registeredTools.get(TOOL_CREATE_OR_UPDATE_FILE);
        const result = await tool!.handler(baseParams);

        expect(result.isError).toBeUndefined();
        const parsed = parseResponse(result);
        expect(parsed.action).toBe('preview');
        expect(parsed.message).toContain('Updated');
        expect(parsed.file).toMatchObject({
          action: 'update',
          existing_sha: 'existing-sha-123',
        });
      });

      it('should include content preview truncated for long content', async () => {
        vi.mocked(octokit.repos.getContent).mockRejectedValueOnce({ status: 404 });

        const longContent = 'x'.repeat(1000);
        const tool = registeredTools.get(TOOL_CREATE_OR_UPDATE_FILE);
        const result = await tool!.handler({ ...baseParams, content: longContent });

        const parsed = parseResponse(result);
        expect(parsed.file.content_preview).toContain('...');
        expect(parsed.file.content_length).toBe(1000);
      });
    });

    describe('Execute Mode', () => {
      it('should create a new file when executed', async () => {
        // File doesn't exist
        vi.mocked(octokit.repos.getContent).mockRejectedValueOnce({ status: 404 });

        // Create succeeds
        vi.mocked(octokit.repos.createOrUpdateFileContents).mockResolvedValueOnce({
          data: {
            commit: {
              sha: 'commit-sha-123',
              html_url: 'https://github.com/owner/repo/commit/commit-sha-123',
              message: 'Add index file',
            },
            content: {
              sha: 'content-sha-456',
              html_url: 'https://github.com/owner/repo/blob/main/src/index.ts',
              download_url: 'https://raw.githubusercontent.com/owner/repo/main/src/index.ts',
            },
          },
        } as never);

        const tool = registeredTools.get(TOOL_CREATE_OR_UPDATE_FILE);
        const result = await tool!.handler({ ...baseParams, _executeFromButton: true });

        expect(result.isError).toBeUndefined();
        const parsed = parseResponse(result);
        expect(parsed.success).toBe(true);
        expect(parsed.action).toBe('create');
        expect(parsed.commit.sha).toBe('commit-sha-123');

        // Verify API was called with base64 encoded content
        expect(octokit.repos.createOrUpdateFileContents).toHaveBeenCalledWith({
          owner: 'owner',
          repo: 'repo',
          path: 'src/index.ts',
          message: 'Add index file',
          content: Buffer.from('console.log("Hello, World!");').toString('base64'),
        });
      });

      it('should update an existing file when executed', async () => {
        // File exists
        vi.mocked(octokit.repos.getContent).mockResolvedValueOnce({
          data: {
            type: 'file',
            sha: 'existing-sha-123',
          },
        } as never);

        // Update succeeds
        vi.mocked(octokit.repos.createOrUpdateFileContents).mockResolvedValueOnce({
          data: {
            commit: {
              sha: 'commit-sha-456',
              html_url: 'https://github.com/owner/repo/commit/commit-sha-456',
              message: 'Update index file',
            },
            content: {
              sha: 'content-sha-789',
              html_url: 'https://github.com/owner/repo/blob/main/src/index.ts',
              download_url: 'https://raw.githubusercontent.com/owner/repo/main/src/index.ts',
            },
          },
        } as never);

        const tool = registeredTools.get(TOOL_CREATE_OR_UPDATE_FILE);
        const result = await tool!.handler({
          ...baseParams,
          message: 'Update index file',
          _executeFromButton: true,
        });

        expect(result.isError).toBeUndefined();
        const parsed = parseResponse(result);
        expect(parsed.success).toBe(true);
        expect(parsed.action).toBe('update');

        // Verify API was called with SHA
        expect(octokit.repos.createOrUpdateFileContents).toHaveBeenCalledWith(
          expect.objectContaining({
            sha: 'existing-sha-123',
          })
        );
      });

      it('should use provided branch parameter', async () => {
        vi.mocked(octokit.repos.getContent).mockRejectedValueOnce({ status: 404 });
        vi.mocked(octokit.repos.createOrUpdateFileContents).mockResolvedValueOnce({
          data: {
            commit: { sha: 'abc', html_url: 'url', message: 'msg' },
            content: { sha: 'def', html_url: 'url', download_url: 'url' },
          },
        } as never);

        const tool = registeredTools.get(TOOL_CREATE_OR_UPDATE_FILE);
        await tool!.handler({
          ...baseParams,
          branch: 'feature-branch',
          _executeFromButton: true,
        });

        expect(octokit.repos.getContent).toHaveBeenCalledWith({
          owner: 'owner',
          repo: 'repo',
          path: 'src/index.ts',
          ref: 'feature-branch',
        });

        expect(octokit.repos.createOrUpdateFileContents).toHaveBeenCalledWith(
          expect.objectContaining({
            branch: 'feature-branch',
          })
        );
      });

      it('should use provided SHA without checking file existence', async () => {
        vi.mocked(octokit.repos.createOrUpdateFileContents).mockResolvedValueOnce({
          data: {
            commit: { sha: 'abc', html_url: 'url', message: 'msg' },
            content: { sha: 'def', html_url: 'url', download_url: 'url' },
          },
        } as never);

        const tool = registeredTools.get(TOOL_CREATE_OR_UPDATE_FILE);
        await tool!.handler({
          ...baseParams,
          sha: 'provided-sha-123',
          _executeFromButton: true,
        });

        // Should NOT call getContent since SHA was provided
        expect(octokit.repos.getContent).not.toHaveBeenCalled();

        expect(octokit.repos.createOrUpdateFileContents).toHaveBeenCalledWith(
          expect.objectContaining({
            sha: 'provided-sha-123',
          })
        );
      });
    });

    describe('Error Handling', () => {
      it('should return error on API failure', async () => {
        vi.mocked(octokit.repos.getContent).mockRejectedValueOnce({ status: 404 });
        vi.mocked(octokit.repos.createOrUpdateFileContents).mockRejectedValueOnce(new Error('Permission denied'));

        const tool = registeredTools.get(TOOL_CREATE_OR_UPDATE_FILE);
        const result = await tool!.handler({ ...baseParams, _executeFromButton: true });

        expect(result.isError).toBe(true);
        const parsed = parseResponse(result);
        expect(parsed.success).toBe(false);
        expect(parsed.error).toBe('Permission denied');
      });

      it('should handle rate limit errors', async () => {
        vi.mocked(octokit.repos.getContent).mockRejectedValueOnce({ status: 404 });

        const rateLimitError = new Error('Rate limit exceeded');
        (rateLimitError as Error & { status: number }).status = 403;
        (rateLimitError as Error & { response: { headers: Record<string, string> } }).response = {
          headers: { 'x-ratelimit-remaining': '0' },
        };
        vi.mocked(octokit.repos.createOrUpdateFileContents).mockRejectedValueOnce(rateLimitError);

        const tool = registeredTools.get(TOOL_CREATE_OR_UPDATE_FILE);
        const result = await tool!.handler({ ...baseParams, _executeFromButton: true });

        expect(result.isError).toBe(true);
        const parsed = parseResponse(result);
        expect(parsed.suggestion).toContain('rate limit');
      });

      it('should handle 409 conflict errors', async () => {
        vi.mocked(octokit.repos.getContent).mockRejectedValueOnce({ status: 404 });

        const conflictError = new Error('Conflict');
        (conflictError as Error & { status: number }).status = 409;
        vi.mocked(octokit.repos.createOrUpdateFileContents).mockRejectedValueOnce(conflictError);

        const tool = registeredTools.get(TOOL_CREATE_OR_UPDATE_FILE);
        const result = await tool!.handler({ ...baseParams, _executeFromButton: true });

        expect(result.isError).toBe(true);
        const parsed = parseResponse(result);
        expect(parsed.suggestion).toContain('modified');
      });

      it('should handle 422 SHA mismatch errors', async () => {
        vi.mocked(octokit.repos.getContent).mockRejectedValueOnce({ status: 404 });

        const shaError = new Error('sha does not match');
        (shaError as Error & { status: number }).status = 422;
        vi.mocked(octokit.repos.createOrUpdateFileContents).mockRejectedValueOnce(shaError);

        const tool = registeredTools.get(TOOL_CREATE_OR_UPDATE_FILE);
        const result = await tool!.handler({ ...baseParams, _executeFromButton: true });

        expect(result.isError).toBe(true);
        const parsed = parseResponse(result);
        expect(parsed.suggestion).toContain('SHA');
      });

      it('should handle error when checking file existence', async () => {
        const serverError = new Error('Internal Server Error');
        (serverError as Error & { status: number }).status = 500;
        vi.mocked(octokit.repos.getContent).mockRejectedValueOnce(serverError);

        const tool = registeredTools.get(TOOL_CREATE_OR_UPDATE_FILE);
        const result = await tool!.handler(baseParams);

        expect(result.isError).toBe(true);
        const parsed = parseResponse(result);
        expect(parsed.success).toBe(false);
      });
    });

    describe('Committer and Author', () => {
      it('should pass committer and author information when provided', async () => {
        vi.mocked(octokit.repos.getContent).mockRejectedValueOnce({ status: 404 });
        vi.mocked(octokit.repos.createOrUpdateFileContents).mockResolvedValueOnce({
          data: {
            commit: { sha: 'abc', html_url: 'url', message: 'msg' },
            content: { sha: 'def', html_url: 'url', download_url: 'url' },
          },
        } as never);

        const tool = registeredTools.get(TOOL_CREATE_OR_UPDATE_FILE);
        await tool!.handler({
          ...baseParams,
          committer: { name: 'Bot', email: 'bot@example.com' },
          author: { name: 'Developer', email: 'dev@example.com' },
          _executeFromButton: true,
        });

        expect(octokit.repos.createOrUpdateFileContents).toHaveBeenCalledWith(
          expect.objectContaining({
            committer: { name: 'Bot', email: 'bot@example.com' },
            author: { name: 'Developer', email: 'dev@example.com' },
          })
        );
      });
    });
  });
});
