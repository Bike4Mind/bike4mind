import { beforeEach, describe, expect, it, vi } from 'vitest';

const { userFindOne, mcpFindOne } = vi.hoisted(() => ({ userFindOne: vi.fn(), mcpFindOne: vi.fn() }));

vi.mock('../di/registry', () => ({
  getSlackDb: () => ({ User: { findOne: userFindOne }, McpServer: { findOne: mcpFindOne } }),
}));
vi.mock('@bike4mind/observability', () => ({
  Logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { mapSlackUserIdToGithubUsername, mapSlackUserIdsToGithubUsernames } from './slack-github-mapper';

beforeEach(() => {
  vi.clearAllMocks();
  userFindOne.mockResolvedValue({ id: 'user-1', name: 'Alice' });
  mcpFindOne.mockResolvedValue({ metadata: { githubLogin: 'alice-gh' } });
});

describe('mapSlackUserIdToGithubUsername', () => {
  it("only resolves accounts linked in the requester's workspace", async () => {
    const mapping = await mapSlackUserIdToGithubUsername('U1', 'T1');

    expect(userFindOne).toHaveBeenCalledWith({
      'slackSettings.slackUserId': 'U1',
      'slackSettings.slackTeamId': 'T1',
    });
    expect(mapping).toEqual({ slackUserId: 'U1', githubUsername: 'alice-gh', userDisplayName: 'Alice' });
  });

  it('resolves nobody when the requester has no workspace', async () => {
    const mappings = await mapSlackUserIdsToGithubUsernames(['U1', 'U2'], undefined);

    expect(userFindOne).not.toHaveBeenCalled();
    expect(mappings).toEqual([
      { slackUserId: 'U1', githubUsername: null },
      { slackUserId: 'U2', githubUsername: null },
    ]);
  });
});
