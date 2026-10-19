import { describe, it, expect, vi, beforeEach } from 'vitest';

const confluenceApi = vi.hoisted(() => ({ addComment: vi.fn() }));

vi.mock('../../client.js', () => ({
  getConfluenceApi: () => confluenceApi,
}));

import { registerConfluenceCommentTools } from '../../tools/confluence-comments.js';
import { CONFLUENCE_CREATE_COMMENT, CONFLUENCE_REPLY_TO_COMMENT } from '../../constants.js';
import { createMockServer, parseResponse, type RegisteredTool } from '../test-utils.js';

const decodeToken = (token: unknown): { tool: string; params: Record<string, unknown> } =>
  JSON.parse(Buffer.from(String(token), 'base64').toString('utf8'));

const cases = [
  {
    tool: CONFLUENCE_CREATE_COMMENT,
    args: { pageId: '123', content: '<p>hi</p>', inlineOriginalSelection: 'some text' },
    expectedWriteArgs: { pageId: '123', content: '<p>hi</p>', inlineOriginalSelection: 'some text' },
  },
  {
    tool: CONFLUENCE_REPLY_TO_COMMENT,
    args: { pageId: '123', parentCommentId: '456', content: '<p>reply</p>' },
    expectedWriteArgs: { pageId: '123', content: '<p>reply</p>', parentId: '456' },
  },
];

describe('Confluence comment tools are gated behind preview/confirm', () => {
  let registeredTools: Map<string, RegisteredTool>;

  beforeEach(() => {
    vi.clearAllMocks();
    confluenceApi.addComment.mockResolvedValue({ id: '789' });
    const mock = createMockServer();
    registeredTools = mock.registeredTools;
    registerConfluenceCommentTools(mock.server);
  });

  describe.each(cases)('$tool', ({ tool, args, expectedWriteArgs }) => {
    it('returns a preview carrying the full args without writing', async () => {
      const parsed = parseResponse(await registeredTools.get(tool)!.handler({ ...args, confirmed: true }));

      expect(confluenceApi.addComment).not.toHaveBeenCalled();
      expect(parsed.action).toBe('preview');
      expect(decodeToken(parsed._confirmToken)).toMatchObject({ tool, params: args });
    });

    it('writes when executed from the confirm button', async () => {
      await registeredTools.get(tool)!.handler({ ...args, _executeFromButton: true });

      expect(confluenceApi.addComment).toHaveBeenCalledWith(expectedWriteArgs);
    });
  });
});
