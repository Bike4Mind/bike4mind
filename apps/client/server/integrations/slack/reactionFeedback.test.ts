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
  findChannel: vi.fn(),
}));
vi.mock('@bike4mind/database', () => ({ cacheRepository: { tryIncrementWithinLimitFixedWindow: mocks.limit } }));
vi.mock('@bike4mind/database/infra', () => ({
  orgSlackWorkspaceRepository: { findBySlackTeamIdWithToken: mocks.workspace },
  SlackFeedbackChannel: { findOne: mocks.findChannel },
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
      {
        id: 'foreign',
        organizationId: 'org2',
        url: 'https://foreign.example',
        secret: 'synthetic-foreign-signing-key-not-real-12345',
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
import { feedbackId, signFeedback } from './feedbackProtocol';
const event = {
  type: 'reaction_added',
  reaction: 'bug',
  user: 'UREACTOR',
  item: { type: 'message', channel: 'C123', ts: '123.456' },
};
beforeEach(() => {
  vi.resetAllMocks();
  mocks.findChannel.mockImplementation(() => ({ lean: mocks.channel }));
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
  mocks.fetch.mockResolvedValue({ ok: true, body: { cancel: vi.fn().mockResolvedValue(undefined) } });
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
  expect(mocks.findChannel).toHaveBeenNthCalledWith(1, {
    _id: feedbackId('ws1', 'C123'),
    workspaceId: 'ws1',
    organizationId: 'org1',
    slackTeamId: 'T1',
    enabled: true,
    emoji: 'bug',
  });
  expect(mocks.findChannel).toHaveBeenNthCalledWith(2, {
    _id: feedbackId('ws1', 'C123'),
    workspaceId: 'ws1',
    organizationId: 'org1',
    slackTeamId: 'T1',
    enabled: true,
    emoji: 'bug',
    destinationId: 'receiver',
  });
  expect(mocks.limit).toHaveBeenNthCalledWith(1, 'slack-feedback:org:org1', 100, 3600000);
  expect(mocks.limit).toHaveBeenNthCalledWith(2, 'slack-feedback:channel:T1:C123', 10, 3600000);
  expect(mocks.create).toHaveBeenCalledWith(
    expect.objectContaining({ _id: feedbackId('ws1', 'T1', 'C123', '123.456') })
  );
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
  expect(mocks.fetch).not.toHaveBeenCalled();
  expect(mocks.update).toHaveBeenCalledWith(expect.anything(), { $set: { state: 'limited' } });
});
it.each([{ bot_id: 'B1' }, { subtype: 'bot_message' }, { metadata: { event_type: 'b4m_api_post' } }, { user: 'UBOT' }])(
  'ignores bot/API-origin messages %j',
  async fields => {
    mocks.get.mockResolvedValue({ message: { ts: '123.456', user: 'UAUTHOR', ...fields } });
    await forwardSlackReaction('T1', 'A1', event);
    expect(mocks.fetch).not.toHaveBeenCalled();
    expect(mocks.update).toHaveBeenCalledWith(expect.anything(), { $set: { state: 'ignored' } });
    expect(mocks.limit).not.toHaveBeenCalled();
  }
);
it('never adds eyes on rejected or ambiguous delivery', async () => {
  mocks.fetch.mockRejectedValue(new Error('timeout'));
  await forwardSlackReaction('T1', 'A1', event);
  expect(mocks.reaction).not.toHaveBeenCalled();
  expect(mocks.audit).toHaveBeenCalledWith(expect.objectContaining({ success: false }));
});
it('rechecks opt-in after message lookups before disclosing reporter content', async () => {
  mocks.channel.mockResolvedValueOnce({ channelId: 'C123', destinationId: 'receiver' }).mockResolvedValueOnce(null);
  await forwardSlackReaction('T1', 'A1', event);
  expect(mocks.get).toHaveBeenCalledOnce();
  expect(mocks.fetch).not.toHaveBeenCalled();
});
it.each(['is_shared', 'is_org_shared', 'is_ext_shared', 'is_pending_ext_shared'])(
  'refuses a channel with %s',
  async flag => {
    mocks.info.mockResolvedValue({ channel: { is_member: true, [flag]: true } });
    await forwardSlackReaction('T1', 'A1', event);
    expect(mocks.get).not.toHaveBeenCalled();
    expect(mocks.fetch).not.toHaveBeenCalled();
  }
);
it.each([
  ['author', 'is_bot'],
  ['author', 'deleted'],
  ['reactor', 'is_bot'],
  ['reactor', 'deleted'],
])('ignores %s with %s without spending quota', async (actor, flag) => {
  mocks.user
    .mockResolvedValueOnce({ user: { [flag]: actor === 'author' } })
    .mockResolvedValueOnce({ user: { [flag]: actor === 'reactor' } });
  await forwardSlackReaction('T1', 'A1', event);
  expect(mocks.limit).not.toHaveBeenCalled();
  expect(mocks.fetch).not.toHaveBeenCalled();
  expect(mocks.update).toHaveBeenCalledWith(expect.anything(), { $set: { state: 'ignored' } });
});
it('refuses a destination from another organization', async () => {
  mocks.channel.mockResolvedValue({ channelId: 'C123', destinationId: 'foreign' });
  await forwardSlackReaction('T1', 'A1', event);
  expect(mocks.create).not.toHaveBeenCalled();
  expect(mocks.fetch).not.toHaveBeenCalled();
});
it('does not overwrite accepted delivery state when audit persistence fails', async () => {
  mocks.audit.mockRejectedValue(new Error('audit unavailable'));
  await forwardSlackReaction('T1', 'A1', event);
  expect(mocks.update).toHaveBeenCalledWith(expect.anything(), { $set: { state: 'sent' } });
  expect(mocks.update).not.toHaveBeenCalledWith(expect.anything(), { $set: { state: 'failed' } });
});
it('settles a sending delivery as sent when the first sent write throws after acceptance', async () => {
  mocks.update.mockImplementation(async (_filter: unknown, change: { $set: { state: string } }) => {
    if (change.$set.state === 'sent' && mocks.update.mock.calls.filter(c => c[1].$set.state === 'sent').length === 1) {
      throw new Error('write unavailable');
    }
  });
  await forwardSlackReaction('T1', 'A1', event);
  const sent = mocks.update.mock.calls.filter(c => c[1].$set.state === 'sent');
  expect(sent).toHaveLength(2);
  expect(sent[1][0]).toEqual({ _id: expect.any(String), state: 'sending' });
  expect(mocks.update).not.toHaveBeenCalledWith(expect.anything(), { $set: { state: 'failed' } });
});
it('ignores a message whose author cannot be resolved', async () => {
  mocks.user.mockResolvedValueOnce({});
  await forwardSlackReaction('T1', 'A1', event);
  expect(mocks.update).toHaveBeenCalledWith(expect.anything(), { $set: { state: 'ignored' } });
  expect(mocks.fetch).not.toHaveBeenCalled();
});

it.each([
  ['WREACTOR', 'C12345678'],
  ['UREACTOR', 'G12345678'],
  ['WREACTOR', 'G12345678'],
])('forwards a signed report from %s in an eligible %s channel', async (user, channel) => {
  mocks.channel.mockResolvedValue({ channelId: channel, destinationId: 'receiver' });
  mocks.info.mockResolvedValue({ channel: { is_member: true, is_private: channel.startsWith('G') } });
  await forwardSlackReaction('T1', 'A1', { ...event, user, item: { ...event.item, channel } });
  expect(mocks.fetch).toHaveBeenCalledOnce();
  const [url, init] = mocks.fetch.mock.calls[0];
  expect(url).toBe('https://receiver.example/inbound');
  expect(JSON.parse(init.body)).toMatchObject({ reactor: { slackId: user }, fileNames: ['report.txt'] });
  expect(init.body).not.toContain('must-not-forward');
  expect(init.headers['x-b4m-signature']).toBe(
    signFeedback(init.body, init.headers['x-b4m-timestamp'], 'synthetic-test-signing-key-not-real-12345', 'forward')
  );
  expect(mocks.findChannel).toHaveBeenCalledWith(
    expect.objectContaining({
      _id: feedbackId('ws1', channel),
      workspaceId: 'ws1',
      organizationId: 'org1',
      slackTeamId: 'T1',
      enabled: true,
    })
  );
  expect(mocks.create).toHaveBeenCalledWith(
    expect.objectContaining({ _id: feedbackId('ws1', 'T1', channel, '123.456') })
  );
});

it.each([
  { is_mpim: true },
  { is_shared: true },
  { is_org_shared: true },
  { is_ext_shared: true },
  { is_pending_ext_shared: true },
  { is_member: false },
])('refuses ineligible G channels %j without sending or spending quota', async fields => {
  mocks.info.mockResolvedValue({ channel: { is_member: true, ...fields } });
  await forwardSlackReaction('T1', 'A1', { ...event, user: 'WREACTOR', item: { ...event.item, channel: 'G12345678' } });
  expect(mocks.fetch).not.toHaveBeenCalled();
  expect(mocks.limit).not.toHaveBeenCalled();
});
