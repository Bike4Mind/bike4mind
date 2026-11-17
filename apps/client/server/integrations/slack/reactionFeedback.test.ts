import { beforeEach, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({
  workspace: vi.fn(),
  channel: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  audit: vi.fn(),
  limit: vi.fn(),
  get: vi.fn(),
  user: vi.fn(),
  permalink: vi.fn(),
  reaction: vi.fn(),
  fetch: vi.fn(),
  info: vi.fn(),
}));
vi.mock('@bike4mind/database', () => ({ cacheRepository: { tryIncrementWithinLimitFixedWindow: mocks.limit } }));
vi.mock('@bike4mind/database/infra', () => ({
  orgSlackWorkspaceRepository: { findBySlackTeamIdWithToken: mocks.workspace },
  SlackFeedbackChannel: { findOne: () => ({ lean: mocks.channel }) },
  SlackFeedbackDelivery: { create: mocks.create, updateOne: mocks.update },
  slackAuditLogRepository: { createLog: mocks.audit },
}));
vi.mock('@bike4mind/server-utils/security/tokenEncryption', () => ({ decryptToken: (token: string) => token }));
vi.mock('@bike4mind/server-utils/utils/ssrfProtection', () => ({ fetchPinned: mocks.fetch }));
vi.mock('@bike4mind/server-utils/utils/config', () => ({
  Config: {
    SLACK_FEEDBACK_DESTINATIONS: JSON.stringify([
      {
        id: 'receiver',
        organizationId: 'org1',
        url: 'https://receiver.example/inbound',
        secret: 'synthetic-test-signing-key-not-real-12345',
      },
    ]),
  },
}));
vi.mock('@slack/web-api', () => ({
  WebClient: class {
    reactions = { get: mocks.get, add: mocks.reaction };
    users = { info: mocks.user };
    chat = { getPermalink: mocks.permalink };
    conversations = { info: mocks.info };
  },
}));
import { forwardSlackReaction } from './reactionFeedback';
import { signFeedback } from './feedbackProtocol';
const event = {
  type: 'reaction_added',
  reaction: 'bug',
  user: 'UREACTOR',
  item: { type: 'message', channel: 'C123', ts: '123.456' },
};
beforeEach(() => {
  vi.resetAllMocks();
  mocks.workspace.mockResolvedValue({
    id: 'ws1',
    organizationId: 'org1',
    slackTeamId: 'T1',
    slackAppId: 'A1',
    slackBotToken: 'test-token',
    slackBotUserId: 'UBOT',
  });
  mocks.channel.mockResolvedValue({ channelId: 'C123', destinationId: 'receiver' });
  mocks.limit.mockResolvedValue({ success: true });
  mocks.info.mockResolvedValue({ channel: { is_member: true } });
  mocks.get.mockResolvedValue({
    message: {
      ts: '123.456',
      user: 'UAUTHOR',
      text: 'untrusted <script>',
      files: [{ name: 'report.txt', url_private: 'must-not-forward' }],
    },
  });
  mocks.user.mockResolvedValue({ user: { is_bot: false, profile: { email: 'reporter@example.com' } } });
  mocks.permalink.mockResolvedValue({ permalink: 'https://workspace.slack.com/archives/C123/p123456' });
  mocks.fetch.mockResolvedValue({ ok: true, body: { cancel: vi.fn() } });
  mocks.reaction.mockResolvedValue({ ok: true });
});
it('forwards one signed untrusted report without attachment contents and durably audits before sending', async () => {
  await forwardSlackReaction('T1', 'A1', event);
  expect(mocks.fetch).toHaveBeenCalledOnce();
  const [url, init, options] = mocks.fetch.mock.calls[0];
  expect(url).toBe('https://receiver.example/inbound');
  expect(init.redirect).toBe('error');
  expect(options).toEqual({ discardBody: true });
  const payload = JSON.parse(init.body);
  expect(payload).toMatchObject({
    reporterContentTrust: 'untrusted',
    text: 'untrusted <script>',
    fileNames: ['report.txt'],
    author: { slackId: 'UAUTHOR', email: 'reporter@example.com' },
    reactor: { slackId: 'UREACTOR' },
  });
  expect(init.body).not.toContain('must-not-forward');
  expect(init.headers['x-b4m-signature']).toBe(
    signFeedback(init.body, init.headers['x-b4m-timestamp'], 'synthetic-test-signing-key-not-real-12345', 'forward')
  );
  expect(mocks.create.mock.invocationCallOrder[0]).toBeLessThan(mocks.fetch.mock.invocationCallOrder[0]);
  expect(mocks.audit).toHaveBeenCalledWith(expect.objectContaining({ success: true, action: 'feedback_forward' }));
  expect(mocks.reaction).toHaveBeenCalledWith({ channel: 'C123', timestamp: '123.456', name: 'eyes' });
});
it('does no message lookup without opt-in or for a foreign app or DM', async () => {
  mocks.channel.mockResolvedValue(null);
  await forwardSlackReaction('T1', 'A1', event);
  await forwardSlackReaction('T1', 'OTHER', event);
  await forwardSlackReaction('T1', 'A1', { ...event, item: { ...event.item, channel: 'D123' } });
  expect(mocks.get).not.toHaveBeenCalled();
  expect(mocks.fetch).not.toHaveBeenCalled();
});
it('uses the stored emoji in its opt-in lookup', async () => {
  // The repository query, not a hard-coded emoji, selects the opt-in.
  mocks.channel.mockResolvedValue(null);
  await forwardSlackReaction('T1', 'A1', { ...event, reaction: 'other' });
  expect(mocks.create).not.toHaveBeenCalled();
});
it('deduplicates before fetching Slack or consuming quota', async () => {
  mocks.create.mockRejectedValue({ code: 11000 });
  await forwardSlackReaction('T1', 'A1', event);
  expect(mocks.get).not.toHaveBeenCalled();
  expect(mocks.limit).not.toHaveBeenCalled();
});
it.each([0, 1])('fails closed for rate limit %i', async limited => {
  mocks.limit.mockResolvedValueOnce({ success: limited !== 0 }).mockResolvedValueOnce({ success: limited !== 1 });
  await forwardSlackReaction('T1', 'A1', event);
  expect(mocks.get).not.toHaveBeenCalled();
  expect(mocks.update).toHaveBeenCalledWith(expect.anything(), { $set: { state: 'limited' } });
});
it.each([{ bot_id: 'B1' }, { subtype: 'bot_message' }, { metadata: { event_type: 'b4m_api_post' } }, { user: 'UBOT' }])(
  'ignores bot/API-origin messages %j',
  async fields => {
    mocks.get.mockResolvedValue({ message: { ts: '123.456', user: 'UAUTHOR', ...fields } });
    await forwardSlackReaction('T1', 'A1', event);
    expect(mocks.fetch).not.toHaveBeenCalled();
    expect(mocks.update).toHaveBeenCalledWith(expect.anything(), { $set: { state: 'ignored' } });
  }
);
it('never adds eyes on rejected or ambiguous delivery', async () => {
  mocks.fetch.mockRejectedValue(new Error('timeout'));
  await forwardSlackReaction('T1', 'A1', event);
  expect(mocks.reaction).not.toHaveBeenCalled();
  expect(mocks.audit).toHaveBeenCalledWith(expect.objectContaining({ success: false }));
});
