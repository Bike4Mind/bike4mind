import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the config module
vi.mock('../../config.js', () => ({
  githubToken: 'mock-token',
}));

// Mock the client module
vi.mock('../../client.js', () => ({
  octokit: {
    issues: {
      createLabel: vi.fn(),
      updateLabel: vi.fn(),
      deleteLabel: vi.fn(),
      listLabelsForRepo: vi.fn(),
    },
  },
}));

import { registerLabelTools } from '../../tools/labels.js';
import { octokit } from '../../client.js';
import { TOOL_CREATE_LABEL, TOOL_UPDATE_LABEL, TOOL_DELETE_LABEL, TOOL_LIST_LABELS } from '../../constants.js';
import { createMockServer, parseResponse, type RegisteredTool } from '../test-utils.js';

describe('Label Tools', () => {
  let registeredTools: Map<string, RegisteredTool>;

  beforeEach(() => {
    vi.clearAllMocks();
    const mock = createMockServer();
    registeredTools = mock.registeredTools;
    registerLabelTools(mock.server);
  });

  describe(TOOL_CREATE_LABEL, () => {
    it('should register the tool', () => {
      expect(registeredTools.has(TOOL_CREATE_LABEL)).toBe(true);
    });

    it('should return preview when not executed from button', async () => {
      const tool = registeredTools.get(TOOL_CREATE_LABEL);
      const result = await tool!.handler({
        owner: 'owner',
        repo: 'repo',
        name: 'bug',
        color: 'd73a4a',
        description: 'Something is wrong',
        _executeFromButton: false,
      });

      expect(octokit.issues.createLabel).not.toHaveBeenCalled();
      const parsed = parseResponse(result);
      expect(parsed.action).toBe('preview');
      expect((parsed.create_label as any).name).toBe('bug');
      expect((parsed.create_label as any).color).toBe('#d73a4a');
    });

    it('should create label when executed from button', async () => {
      const mockResult = {
        data: {
          name: 'bug',
          color: 'd73a4a',
          description: 'Something is wrong',
          url: 'https://api.github.com/repos/owner/repo/labels/bug',
        },
      };

      vi.mocked(octokit.issues.createLabel).mockResolvedValueOnce(mockResult as never);

      const tool = registeredTools.get(TOOL_CREATE_LABEL);
      const result = await tool!.handler({
        owner: 'owner',
        repo: 'repo',
        name: 'bug',
        color: 'd73a4a',
        description: 'Something is wrong',
        _executeFromButton: true,
      });

      expect(octokit.issues.createLabel).toHaveBeenCalledWith({
        owner: 'owner',
        repo: 'repo',
        name: 'bug',
        color: 'd73a4a',
        description: 'Something is wrong',
      });

      const parsed = parseResponse(result);
      expect(parsed.success).toBe(true);
      expect(parsed.name).toBe('bug');
    });
  });

  describe(TOOL_UPDATE_LABEL, () => {
    it('should register the tool', () => {
      expect(registeredTools.has(TOOL_UPDATE_LABEL)).toBe(true);
    });

    it('should return preview when not executed from button', async () => {
      const tool = registeredTools.get(TOOL_UPDATE_LABEL);
      const result = await tool!.handler({
        owner: 'owner',
        repo: 'repo',
        current_name: 'bug',
        new_name: 'defect',
        color: '000000',
        _executeFromButton: false,
      });

      expect(octokit.issues.updateLabel).not.toHaveBeenCalled();
      const parsed = parseResponse(result);
      expect(parsed.action).toBe('preview');
      expect((parsed.update_label as any).current_name).toBe('bug');
      expect((parsed.update_label as any).changes.name).toBe('defect');
    });

    it('should update label when executed from button', async () => {
      const mockResult = {
        data: {
          name: 'defect',
          color: '000000',
          description: 'Something is wrong',
          url: 'https://api.github.com/repos/owner/repo/labels/defect',
        },
      };

      vi.mocked(octokit.issues.updateLabel).mockResolvedValueOnce(mockResult as never);

      const tool = registeredTools.get(TOOL_UPDATE_LABEL);
      const result = await tool!.handler({
        owner: 'owner',
        repo: 'repo',
        current_name: 'bug',
        new_name: 'defect',
        color: '000000',
        _executeFromButton: true,
      });

      expect(octokit.issues.updateLabel).toHaveBeenCalledWith({
        owner: 'owner',
        repo: 'repo',
        name: 'bug',
        new_name: 'defect',
        color: '000000',
        description: undefined,
      });

      const parsed = parseResponse(result);
      expect(parsed.success).toBe(true);
      expect(parsed.old_name).toBe('bug');
      expect(parsed.name).toBe('defect');
    });
  });

  describe(TOOL_DELETE_LABEL, () => {
    it('should register the tool', () => {
      expect(registeredTools.has(TOOL_DELETE_LABEL)).toBe(true);
    });

    it('should return preview when not executed from button', async () => {
      const tool = registeredTools.get(TOOL_DELETE_LABEL);
      const result = await tool!.handler({
        owner: 'owner',
        repo: 'repo',
        name: 'bug',
        _executeFromButton: false,
      });

      expect(octokit.issues.deleteLabel).not.toHaveBeenCalled();
      const parsed = parseResponse(result);
      expect(parsed.action).toBe('preview');
      expect((parsed.delete_label as any).name).toBe('bug');
    });

    it('should delete label when executed from button', async () => {
      vi.mocked(octokit.issues.deleteLabel).mockResolvedValueOnce({} as never);

      const tool = registeredTools.get(TOOL_DELETE_LABEL);
      const result = await tool!.handler({
        owner: 'owner',
        repo: 'repo',
        name: 'bug',
        _executeFromButton: true,
      });

      expect(octokit.issues.deleteLabel).toHaveBeenCalledWith({
        owner: 'owner',
        repo: 'repo',
        name: 'bug',
      });

      const parsed = parseResponse(result);
      expect(parsed.success).toBe(true);
      expect(parsed.deleted).toBe(true);
    });
  });

  describe(TOOL_LIST_LABELS, () => {
    it('should register the tool', () => {
      expect(registeredTools.has(TOOL_LIST_LABELS)).toBe(true);
    });

    it('should list labels', async () => {
      const mockResult = {
        data: [
          {
            id: 1,
            name: 'bug',
            color: 'd73a4a',
            description: 'Something is wrong',
            default: true,
          },
          {
            id: 2,
            name: 'enhancement',
            color: 'a2eeef',
            description: 'New feature',
            default: false,
          },
        ],
      };

      vi.mocked(octokit.issues.listLabelsForRepo).mockResolvedValueOnce(mockResult as never);

      const tool = registeredTools.get(TOOL_LIST_LABELS);
      const result = await tool!.handler({
        owner: 'owner',
        repo: 'repo',
        per_page: 100,
        page: 1,
      });

      expect(octokit.issues.listLabelsForRepo).toHaveBeenCalledWith({
        owner: 'owner',
        repo: 'repo',
        per_page: 100,
        page: 1,
      });

      const parsed = parseResponse(result);
      expect(parsed.success).toBe(true);
      expect(parsed.total_count).toBe(2);
      expect(parsed.labels).toHaveLength(2);
      expect((parsed.labels as any)[0].name).toBe('bug');
    });
  });
});
