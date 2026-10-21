import { beforeEach, describe, expect, it, vi } from 'vitest';

const { findUser, systemWorkspace, orgWorkspace, members } = vi.hoisted(() => ({
  findUser: vi.fn(),
  systemWorkspace: vi.fn(),
  orgWorkspace: vi.fn(),
  members: vi.fn(),
}));
vi.mock('./di/registry', () => ({
  getSlackDb: () => ({
    User: { findById: (id: string) => ({ select: () => findUser(id) }) },
    slackDevWorkspaceRepository: { findBySlackTeamIdWithToken: systemWorkspace },
    orgSlackWorkspaceRepository: { findBySlackTeamIdWithToken: orgWorkspace },
  }),
  getSlackDeps: () => ({ tokenEncryption: { decryptToken: (token: string) => token } }),
}));
vi.mock('@slack/web-api', () => ({
  WebClient: vi.fn().mockImplementation(function () {
    return { conversations: { members } };
  }),
}));
import { WebClient } from '@slack/web-api';
import { resolveNotificationDestination } from './notificationDestination';

describe('notification destination authorization', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(WebClient).mockImplementation(function () {
      return { conversations: { members } } as unknown as WebClient;
    });
    findUser.mockResolvedValue({ slackSettings: { slackUserId: 'U123', slackTeamId: 'T123' } });
    systemWorkspace.mockResolvedValue({ slackBotToken: 'workspace-token' });
    orgWorkspace.mockResolvedValue(null);
    members.mockResolvedValue({ ok: true, members: ['U123'] });
  });

  it('ignores a legacy manually claimed identity before loading any token', async () => {
    findUser.mockResolvedValue({ slackSettings: { slackUserId: 'U123' } });
    await expect(resolveNotificationDestination('owner', 'C123')).rejects.toThrow(/verify/);
    expect(systemWorkspace).not.toHaveBeenCalled();
    expect(members).not.toHaveBeenCalled();
  });

  it('resolves DMs only to the verified member and their workspace', async () => {
    expect(await resolveNotificationDestination('owner')).toEqual({
      botToken: 'workspace-token',
      channel: 'U123',
      slackTeamId: 'T123',
    });
    expect(findUser).toHaveBeenCalledWith('owner');
    expect(systemWorkspace).toHaveBeenCalledWith('T123');
    expect(members).not.toHaveBeenCalled();
  });

  it('checks every page using the linked workspace token', async () => {
    members
      .mockResolvedValueOnce({ ok: true, members: ['UOTHER'], response_metadata: { next_cursor: 'next' } })
      .mockResolvedValueOnce({ ok: true, members: ['U123'] });
    expect((await resolveNotificationDestination('owner', 'C123')).channel).toBe('C123');
    expect(WebClient).toHaveBeenCalledWith('workspace-token');
    expect(members).toHaveBeenNthCalledWith(1, { channel: 'C123', cursor: undefined, limit: 200 });
    expect(members).toHaveBeenNthCalledWith(2, { channel: 'C123', cursor: 'next', limit: 200 });
  });

  it('refuses a channel when membership is absent', async () => {
    members.mockResolvedValue({ ok: true, members: ['UOTHER'] });
    await expect(resolveNotificationDestination('owner', 'C456')).rejects.toThrow(/member/);
  });

  it('fails closed when Slack cannot verify membership', async () => {
    members.mockRejectedValue(new Error('missing_scope'));
    await expect(resolveNotificationDestination('owner', 'C789')).rejects.toThrow('missing_scope');
  });

  it('reuses a positive membership result instead of paging the member list again', async () => {
    expect((await resolveNotificationDestination('owner', 'C777')).channel).toBe('C777');
    expect((await resolveNotificationDestination('owner', 'C777')).channel).toBe('C777');
    expect(members).toHaveBeenCalledTimes(1);
  });

  it('cannot repoint a DM to another member', async () => {
    await expect(resolveNotificationDestination('owner', 'UOTHER')).rejects.toThrow(/channel/);
    expect(members).not.toHaveBeenCalled();
  });

  it('uses the matching organization workspace when no system installation exists', async () => {
    systemWorkspace.mockResolvedValue(null);
    orgWorkspace.mockResolvedValue({ slackBotToken: 'org-token' });
    expect((await resolveNotificationDestination('owner')).botToken).toBe('org-token');
    expect(orgWorkspace).toHaveBeenCalledWith('T123');
  });
});
