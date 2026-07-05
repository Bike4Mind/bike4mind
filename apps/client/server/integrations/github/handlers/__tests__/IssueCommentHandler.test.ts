import { describe, it, expect, beforeEach, vi } from 'vitest';

const mockNotify = vi.fn();

vi.mock('@bike4mind/slack', () => ({
  GitHubSlackNotifier: vi.fn().mockImplementation(function () {
    return { notify: mockNotify };
  }),
  buildMentionBlocks: vi.fn().mockReturnValue({ text: 'mention', blocks: [] }),
}));

import { IssueCommentHandler } from '@server/integrations/github/handlers/IssueCommentHandler';
import { GitHubSlackNotifier } from '@bike4mind/slack';
import type { GitHubIssueCommentPayload } from '@server/integrations/github/types';
import type { IMcpServerDocument } from '@bike4mind/common';

function createCommentPayload(
  overrides: Partial<{
    action: string;
    body: string;
    commenter: string;
  }>
): GitHubIssueCommentPayload {
  return {
    action: overrides.action ?? 'created',
    repository: { full_name: 'owner/repo' },
    sender: { login: overrides.commenter ?? 'commenter-user' },
    issue: {
      number: 42,
      title: 'Test issue',
      html_url: 'https://github.com/owner/repo/issues/42',
      pull_request: undefined,
    },
    comment: {
      id: 1,
      body: overrides.body ?? '',
      html_url: 'https://github.com/owner/repo/issues/42#comment-1',
      user: { login: overrides.commenter ?? 'commenter-user' },
    },
  } as GitHubIssueCommentPayload;
}

const mockMcpServer = { id: 'mcp-1' } as IMcpServerDocument;

describe('IssueCommentHandler', () => {
  let handler: IssueCommentHandler;

  beforeEach(() => {
    vi.clearAllMocks();
    mockNotify.mockResolvedValue({ notifiedUserIds: [], failedNotifications: [] });
    const notifier = new GitHubSlackNotifier({} as never);
    handler = new IssueCommentHandler(notifier);
  });

  describe('action filtering', () => {
    it('should only process "created" action', async () => {
      const payload = createCommentPayload({ action: 'created', body: '@alice hello' });
      await handler.handle(payload, mockMcpServer);
      expect(mockNotify).toHaveBeenCalled();
    });

    it('should skip "edited" action', async () => {
      const payload = createCommentPayload({ action: 'edited', body: '@alice hello' });
      await handler.handle(payload, mockMcpServer);
      expect(mockNotify).not.toHaveBeenCalled();
    });

    it('should skip "deleted" action', async () => {
      const payload = createCommentPayload({ action: 'deleted', body: '@alice hello' });
      await handler.handle(payload, mockMcpServer);
      expect(mockNotify).not.toHaveBeenCalled();
    });
  });

  describe('@mention regex extraction', () => {
    it('should extract @mention at start of string', async () => {
      const payload = createCommentPayload({ body: '@alice please review' });
      await handler.handle(payload, mockMcpServer);

      expect(mockNotify).toHaveBeenCalledWith('mentions', ['alice'], expect.any(Function), expect.objectContaining({}));
    });

    it('should extract @mention after space', async () => {
      const payload = createCommentPayload({ body: 'Hey @alice please review' });
      await handler.handle(payload, mockMcpServer);

      expect(mockNotify).toHaveBeenCalledWith('mentions', ['alice'], expect.any(Function), expect.objectContaining({}));
    });

    it('should extract multiple @mentions', async () => {
      const payload = createCommentPayload({ body: '@alice @bob please review' });
      await handler.handle(payload, mockMcpServer);

      const targetUsernames = mockNotify.mock.calls[0][1] as string[];
      expect(targetUsernames).toContain('alice');
      expect(targetUsernames).toContain('bob');
      expect(targetUsernames).toHaveLength(2);
    });

    it('should extract hyphenated GitHub usernames', async () => {
      const payload = createCommentPayload({ body: '@user-name please review' });
      await handler.handle(payload, mockMcpServer);

      expect(mockNotify).toHaveBeenCalledWith(
        'mentions',
        ['user-name'],
        expect.any(Function),
        expect.objectContaining({})
      );
    });

    it('should NOT extract from email addresses', async () => {
      const payload = createCommentPayload({ body: 'email@alice.com' });
      await handler.handle(payload, mockMcpServer);

      expect(mockNotify).not.toHaveBeenCalled();
    });

    it('should deduplicate repeated @mentions', async () => {
      const payload = createCommentPayload({ body: '@alice @alice @alice' });
      await handler.handle(payload, mockMcpServer);

      expect(mockNotify).toHaveBeenCalledWith('mentions', ['alice'], expect.any(Function), expect.objectContaining({}));
    });

    it('should exclude the commenter from mentions (self-mention)', async () => {
      const payload = createCommentPayload({
        body: '@commenter-user @alice',
        commenter: 'commenter-user',
      });
      await handler.handle(payload, mockMcpServer);

      expect(mockNotify).toHaveBeenCalledWith('mentions', ['alice'], expect.any(Function), expect.objectContaining({}));
    });

    it('should exclude self-mention case-insensitively', async () => {
      const payload = createCommentPayload({
        body: '@COMMENTER-USER @alice',
        commenter: 'commenter-user',
      });
      await handler.handle(payload, mockMcpServer);

      expect(mockNotify).toHaveBeenCalledWith('mentions', ['alice'], expect.any(Function), expect.objectContaining({}));
    });

    it('should not notify when only self-mentions exist', async () => {
      const payload = createCommentPayload({
        body: '@commenter-user hello',
        commenter: 'commenter-user',
      });
      await handler.handle(payload, mockMcpServer);

      expect(mockNotify).not.toHaveBeenCalled();
    });

    it('should not notify for empty body', async () => {
      const payload = createCommentPayload({ body: '' });
      await handler.handle(payload, mockMcpServer);

      expect(mockNotify).not.toHaveBeenCalled();
    });

    it('should not match bare @ without username', async () => {
      const payload = createCommentPayload({ body: '@ hello' });
      await handler.handle(payload, mockMcpServer);

      expect(mockNotify).not.toHaveBeenCalled();
    });

    it('should extract @mention after newline', async () => {
      const payload = createCommentPayload({ body: 'First line\n@alice second line' });
      await handler.handle(payload, mockMcpServer);

      expect(mockNotify).toHaveBeenCalledWith('mentions', ['alice'], expect.any(Function), expect.objectContaining({}));
    });
  });
});
