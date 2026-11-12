import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  findLoop: vi.fn(),
  findUser: vi.fn(),
  tryIncrement: vi.fn(),
  authorize: vi.fn(),
  spend: vi.fn(),
  post: vi.fn(),
}));
vi.mock('@bike4mind/database', () => ({
  loopRepository: { findByIdAndUserId: h.findLoop },
  userRepository: { findById: h.findUser },
  cacheRepository: { tryIncrementWithinLimitFixedWindow: h.tryIncrement },
  loopEventRepository: {},
  workItemRepository: {},
}));
vi.mock('@bike4mind/server-utils/security/tokenEncryption', () => ({
  decryptToken: (value?: string | null) => (value ? `plain:${value}` : null),
}));
vi.mock('@bike4mind/server-utils/integrations/slack/orgChannelPost', async orig => ({
  ...(await orig<Record<string, unknown>>()),
  authorizeOrgChannelPost: h.authorize,
  spendSlackChannelBudget: h.spend,
  postOrgSlackMessage: h.post,
}));
vi.mock('@server/utils/loopDispatch', () => ({ requestLoopDispatch: vi.fn(), pushLoopChanged: vi.fn() }));

import { MAX_SLACK_POSTS_PER_RUN, resolveLoopSlackTools } from './agentExecutor.loopSlackTools';

const LOOP = { id: 'l1', name: 'Release <!here>', userId: 'u1', organizationId: 'org-1', slackChannelId: 'C0123ABCD' };
const scope = { loopId: 'l1', loopsEnabled: true, userId: 'u1', executionId: 'exec-1' };

const post = async (params: unknown) => {
  const { loopSlackExternalTools } = await resolveLoopSlackTools(scope);
  return loopSlackExternalTools.loop_slack_post
    .implementation({ userId: 'u1' } as never)
    .toolFn(params) as Promise<string>;
};

beforeEach(() => {
  vi.clearAllMocks();
  h.findLoop.mockResolvedValue(LOOP);
  h.findUser.mockResolvedValue({ name: 'Ada' });
  h.tryIncrement.mockResolvedValue({ success: true });
  h.authorize.mockResolvedValue({ ok: true, organizationId: 'org-1', encryptedBotToken: 'tok' });
  h.spend.mockResolvedValue(true);
  h.post.mockResolvedValue({ ok: true, ts: '1.2' });
});

describe('resolveLoopSlackTools', () => {
  it('offers loop_slack_post only to a loop with a Slack channel and EnableLoops on', async () => {
    expect((await resolveLoopSlackTools(scope)).loopSlackEnabledTools).toEqual(['loop_slack_post']);
    expect((await resolveLoopSlackTools({ ...scope, loopsEnabled: false })).loopSlackEnabledTools).toEqual([]);
    h.findLoop.mockResolvedValue({ ...LOOP, slackChannelId: undefined });
    expect((await resolveLoopSlackTools(scope)).loopSlackExternalTools).toEqual({});
  });
});

describe('loop_slack_post', () => {
  it('posts with the loop attribution, neutralised mentions and API-post metadata', async () => {
    expect(JSON.parse(await post({ text: 'Shipped <!channel>' }))).toEqual({ posted: true, ts: '1.2' });
    expect(h.authorize).toHaveBeenCalledWith({ channelId: 'C0123ABCD', userId: 'u1' });
    const [token, message] = h.post.mock.calls[0];
    expect(token).toBe('plain:tok');
    expect(message.channel).toBe('C0123ABCD');
    expect(message.text).not.toContain('<!channel>');
    expect(JSON.stringify(message.blocks)).not.toMatch(/<!here>|<!channel>/);
    expect(message.blocks[1].elements[0].text).toBe('Posted by loop Release &lt;!here&gt; on behalf of Ada');
    expect(message.metadata).toEqual({
      event_type: 'b4m_api_post',
      event_payload: { loop_id: 'l1', user_id: 'u1' },
    });
    expect(h.tryIncrement).toHaveBeenCalledWith('loop-slack:exec-1', MAX_SLACK_POSTS_PER_RUN, expect.any(Number));
  });

  it.each([
    [
      'not opted in or key-restricted',
      () => h.authorize.mockResolvedValue({ ok: false, reason: 'key_not_allowlisted' }),
    ],
    ['owner not an org member', () => h.authorize.mockResolvedValue({ ok: false, reason: 'not_org_member' })],
    ['opted in by another org', () => h.authorize.mockResolvedValue({ ok: true, organizationId: 'org-2' })],
    ['over the per-run cap', () => h.tryIncrement.mockResolvedValue({ success: false })],
    ['over the channel budget', () => h.spend.mockResolvedValue(false)],
  ])('refuses when %s, without posting', async (_label, arrange) => {
    arrange();
    expect(await post({ text: 'hi' })).toMatch(/^Error: /);
    expect(h.post).not.toHaveBeenCalled();
  });

  it('refuses an empty or too-long text, and returns a Slack refusal as a tool error', async () => {
    expect(await post({ text: ' ' })).toBe('Error: text is required');
    expect(await post({ text: 'x'.repeat(3001) })).toMatch(/3000 characters/);
    h.post.mockRejectedValue({ code: 'slack_webapi_platform_error', data: { error: 'not_in_channel' } });
    expect(await post({ text: 'hi' })).toMatch(/^Error: The Bike4Mind bot is not a member/);
  });
});
