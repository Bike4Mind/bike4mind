// @vitest-environment node
/**
 * POST /api/v1/slack/messages through the REAL baseApi chain (apiKeyAuth, scope gate, contract
 * validation, error handler). The database repositories, the per-key limiter and the Slack Web API
 * client are mocked; the harness shape follows pages/api/v1/artifacts/__tests__/scopes.integration.test.ts.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'events';
import { createMocks } from 'node-mocks-http';

const {
  mockValidate,
  mockFindUser,
  mockKeyRateLimit,
  mockSlackLimit,
  mockFindConfig,
  mockFindWorkspace,
  mockMemberOrgIds,
  mockPostMessage,
  mockFindKey,
  webClientArgs,
} = vi.hoisted(() => ({
  mockFindKey: vi.fn(),
  mockValidate: vi.fn(),
  mockFindUser: vi.fn(),
  mockKeyRateLimit: vi.fn(),
  mockSlackLimit: vi.fn(),
  mockFindConfig: vi.fn(),
  mockFindWorkspace: vi.fn(),
  mockMemberOrgIds: vi.fn(),
  mockPostMessage: vi.fn(),
  webClientArgs: [] as unknown[][],
}));

vi.mock('@bike4mind/server-utils/utils/apiKeyTrust', () => ({
  resolveUntrustedKeyLimits: async (_owner: unknown, key: { rateLimit: unknown }) => ({
    rateLimit: key.rateLimit,
    ownerUntrusted: false,
  }),
}));
vi.mock('@bike4mind/server-utils/utils/apiKeyRateLimitCheck', async orig => ({
  ...(await orig<Record<string, unknown>>()),
  checkApiKeyRateLimit: (...a: unknown[]) => mockKeyRateLimit(...a),
}));
// The route's own per-key windows: each limiter built by the route defers to mockSlackLimit with its options.
vi.mock('@bike4mind/server-utils/middlewares/rateLimit', () => ({
  rateLimit: (options: unknown) => (req: unknown, res: unknown, next: (error?: unknown) => void) =>
    mockSlackLimit(options, req, res, next),
}));
vi.mock('@bike4mind/server-utils/utils/analyticsLog', () => ({
  logEvent: vi.fn().mockResolvedValue(undefined),
  logEventSafe: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('@bike4mind/server-utils/security/tokenEncryption', async orig => ({
  ...(await orig<Record<string, unknown>>()),
  decryptToken: (value: string | null | undefined) => (value ? `decrypted:${value}` : null),
}));

vi.mock('@bike4mind/services', async orig => {
  const actual = await orig<Record<string, unknown>>();
  return {
    ...actual,
    userApiKeyService: {
      ...(actual.userApiKeyService as object),
      validateUserApiKey: (...a: unknown[]) => mockValidate(...a),
    },
  };
});

vi.mock('@bike4mind/database', async orig => {
  const actual = await orig<Record<string, unknown>>();
  const RealUser = actual.User as Record<string, unknown>;
  return {
    ...actual,
    connectDB: vi.fn().mockResolvedValue(undefined),
    User: Object.assign(Object.create(RealUser), { findById: (...a: unknown[]) => mockFindUser(...a) }),
    userRepository: { findById: (...a: unknown[]) => mockFindUser(...a) },
  };
});

vi.mock('@bike4mind/database/infra', async orig => ({
  ...(await orig<Record<string, unknown>>()),
  slackChannelConfigRepository: { findByChannelId: (...a: unknown[]) => mockFindConfig(...a) },
  orgSlackWorkspaceRepository: { findBySlackTeamIdWithToken: (...a: unknown[]) => mockFindWorkspace(...a) },
  organizationRepository: { findMembershipOrgIds: (...a: unknown[]) => mockMemberOrgIds(...a) },
}));

vi.mock('@bike4mind/database/auth', async orig => {
  const actual = await orig<Record<string, unknown>>();
  const real = actual.userApiKeyRepository as object;
  return {
    ...actual,
    userApiKeyRepository: Object.assign(Object.create(real), { findById: (...a: unknown[]) => mockFindKey(...a) }),
  };
});

vi.mock('@slack/web-api', async orig => {
  const actual = await orig<Record<string, unknown>>();
  class WebClient {
    chat = { postMessage: (...a: unknown[]) => mockPostMessage(...a) };
    constructor(...args: unknown[]) {
      webClientArgs.push(args);
    }
  }
  return { ...actual, WebClient };
});

vi.mock('@server/auth/auth', async orig => ({
  ...(await orig<Record<string, unknown>>()),
  auth: (_req: unknown, _res: unknown, next: () => void) => next(),
}));

import { ApiKeyScope, TooManyRequestsError } from '@bike4mind/common';
import handler from '../messages';

const CHANNEL = 'C0123ABCDEF';
const TEAM = 'T0123ABCD';
const ORG = 'org-1';
const KEY_ID = 'key-1';
const TS = '1730000000.123456';
const ZWSP = '\u200B';

function withKey(overrides: Record<string, unknown> = {}) {
  mockValidate.mockResolvedValue({
    isValid: true,
    keyId: KEY_ID,
    userId: 'user-1',
    scopes: [ApiKeyScope.SLACK_POST],
    rateLimit: { requestsPerMinute: 60, requestsPerDay: 1000 },
    ...overrides,
  });
}

function slackPlatformError(error: string) {
  return Object.assign(new Error(`An API error occurred: ${error}`), {
    code: 'slack_webapi_platform_error',
    data: { ok: false, error },
  });
}

async function post(body: unknown) {
  const { req, res } = createMocks(
    {
      method: 'POST',
      url: '/api/v1/slack/messages',
      body,
      headers: { 'x-api-key': 'sk-test-valid-key', 'content-type': 'application/json' },
    } as never,
    { eventEmitter: EventEmitter }
  );
  // The handler's Express-typed params vs node-mocks-http mocks.
  await (handler as unknown as (req: unknown, res: unknown) => Promise<void>)(req, res);
  return res;
}

const message = (extra: Record<string, unknown> = {}) => ({ channel_id: CHANNEL, text: 'Shipped v1.2.3', ...extra });

beforeEach(() => {
  vi.clearAllMocks();
  webClientArgs.length = 0;
  withKey();
  mockFindUser.mockResolvedValue({
    id: 'user-1',
    _id: 'user-1',
    name: 'Ada',
    groups: [],
    isBanned: false,
    disputePending: false,
  });
  mockFindKey.mockResolvedValue({ id: KEY_ID, name: 'factory' });
  mockKeyRateLimit.mockResolvedValue({ allowed: true, retryAfter: undefined, headers: {} });
  mockSlackLimit.mockImplementation((_options, _req, _res, next) => next());
  mockFindConfig.mockResolvedValue({
    channelId: CHANNEL,
    slackTeamId: TEAM,
    apiPostEnabled: true,
    apiPostOrganizationId: ORG,
  });
  mockFindWorkspace.mockResolvedValue({ organizationId: ORG, slackTeamId: TEAM, slackBotToken: 'enc-token' });
  mockMemberOrgIds.mockResolvedValue([ORG]);
  mockPostMessage.mockResolvedValue({ ok: true, ts: TS, channel: CHANNEL });
});

describe('POST /api/v1/slack/messages', () => {
  it('posts with the workspace bot token and returns the ts', async () => {
    const res = await post(message());

    expect(res._getStatusCode()).toBe(200);
    expect(res._getJSONData()).toEqual({ ok: true, channel_id: CHANNEL, ts: TS });
    expect(mockFindWorkspace).toHaveBeenCalledWith(TEAM);
    expect(mockMemberOrgIds).toHaveBeenCalledWith('user-1');
    expect(webClientArgs[0][0]).toBe('decrypted:enc-token');
    expect(mockPostMessage).toHaveBeenCalledWith(expect.objectContaining({ channel: CHANNEL, text: 'Shipped v1.2.3' }));
  });

  it('appends an attribution block the caller cannot remove, with escaped names', async () => {
    mockFindUser.mockResolvedValue({ id: 'user-1', _id: 'user-1', name: 'Eve <!channel>', groups: [] });
    mockFindKey.mockResolvedValue({ id: KEY_ID, name: 'ci <@U1>' });
    await post(message());

    const blocks = mockPostMessage.mock.calls[0][0].blocks;
    expect(blocks[0]).toEqual({ type: 'section', text: { type: 'mrkdwn', text: 'Shipped v1.2.3' } });
    expect(blocks.at(-1)).toEqual({
      type: 'context',
      elements: [{ type: 'mrkdwn', text: 'Posted via API by Eve &lt;!channel&gt; \u00B7 key ci &lt;@U1&gt;' }],
    });
    expect(mockFindKey).toHaveBeenCalledWith(KEY_ID);
  });

  it('marks every post with server-set metadata that names the key and user', async () => {
    await post(message());
    expect(mockPostMessage.mock.calls[0][0].metadata).toEqual({
      event_type: 'b4m_api_post',
      event_payload: { key_id: KEY_ID, user_id: 'user-1' },
    });
    expect((await post(message({ metadata: { event_type: 'other' } })))._getStatusCode()).toBe(422);
  });

  it('passes thread_ts and blocks through to Slack', async () => {
    const blocks = [{ type: 'section', text: { type: 'mrkdwn', text: '*Merged* <@U0123ABC>' } }];
    const res = await post(message({ thread_ts: TS, blocks }));

    expect(res._getStatusCode()).toBe(200);
    expect(mockPostMessage).toHaveBeenCalledWith(
      expect.objectContaining({ channel: CHANNEL, text: 'Shipped v1.2.3', thread_ts: TS })
    );
    expect(mockPostMessage.mock.calls[0][0].blocks.slice(0, -1)).toEqual(blocks);
  });

  it('neutralizes broadcast mentions in text and blocks but keeps user mentions', async () => {
    const res = await post(
      message({
        text: '<!channel> shipped @here cc <@U0123ABC>',
        blocks: [
          { type: 'section', text: { type: 'mrkdwn', text: '<!everyone> and <!here|here>' } },
          { type: 'context', elements: [{ type: 'mrkdwn', text: '@channel <!subteam^S0123|@oncall>' }] },
        ],
      })
    );

    expect(res._getStatusCode()).toBe(200);
    const sent = mockPostMessage.mock.calls[0][0];
    expect(sent.text).toBe(`@${ZWSP}channel shipped @${ZWSP}here cc <@U0123ABC>`);
    expect(sent.blocks.slice(0, -1)).toEqual([
      { type: 'section', text: { type: 'mrkdwn', text: `@${ZWSP}everyone and @${ZWSP}here` } },
      { type: 'context', elements: [{ type: 'mrkdwn', text: `@${ZWSP}channel @${ZWSP}oncall` }] },
    ]);
    expect(JSON.stringify(sent)).not.toMatch(/<!channel>|<!here|<!everyone>|<!subteam/);
  });

  it('refuses a key without slack:post (403) before touching Slack or the channel config', async () => {
    withKey({ scopes: [ApiKeyScope.AI_CHAT] });
    const res = await post(message());

    expect(res._getStatusCode()).toBe(403);
    expect(res._getJSONData().required_scopes).toEqual([ApiKeyScope.SLACK_POST]);
    expect(mockFindConfig).not.toHaveBeenCalled();
    expect(mockPostMessage).not.toHaveBeenCalled();
  });

  it.each([
    ['has no config', null],
    ['is not opted in', { channelId: CHANNEL, slackTeamId: TEAM }],
    ['is explicitly opted out', { channelId: CHANNEL, slackTeamId: TEAM, apiPostEnabled: false }],
  ])('refuses a channel that %s (403)', async (_label, config) => {
    mockFindConfig.mockResolvedValue(config);
    const res = await post(message());

    expect(res._getStatusCode()).toBe(403);
    expect(res._getJSONData().error).toMatch(/not enabled for API posting/);
    expect(mockPostMessage).not.toHaveBeenCalled();
  });

  it('refuses a key missing from the channel allowlist (403) and accepts one on it', async () => {
    mockFindConfig.mockResolvedValue({
      channelId: CHANNEL,
      slackTeamId: TEAM,
      apiPostEnabled: true,
      apiPostOrganizationId: ORG,
      apiPostAllowedKeyIds: ['other-key'],
    });
    expect((await post(message()))._getStatusCode()).toBe(403);

    mockFindConfig.mockResolvedValue({
      channelId: CHANNEL,
      slackTeamId: TEAM,
      apiPostEnabled: true,
      apiPostOrganizationId: ORG,
      apiPostAllowedKeyIds: ['other-key', KEY_ID],
    });
    expect((await post(message()))._getStatusCode()).toBe(200);
  });

  it("refuses a channel in another organization's workspace (403)", async () => {
    mockFindWorkspace.mockResolvedValue({ organizationId: 'org-2', slackTeamId: TEAM, slackBotToken: 'enc' });
    const res = await post(message());

    expect(res._getStatusCode()).toBe(403);
    expect(res._getJSONData().error).toMatch(/not enabled for API posting/);
    expect(mockPostMessage).not.toHaveBeenCalled();
  });

  it('refuses an opt-in granted by an organization other than the one the workspace is connected to (403)', async () => {
    mockFindConfig.mockResolvedValue({
      channelId: CHANNEL,
      slackTeamId: TEAM,
      apiPostEnabled: true,
      apiPostOrganizationId: 'org-previous',
    });
    const res = await post(message());

    expect(res._getStatusCode()).toBe(403);
    expect(res._getJSONData().error).toMatch(/not enabled for API posting/);
    expect(mockPostMessage).not.toHaveBeenCalled();
  });

  it('refuses a channel whose workspace is not connected to any organization (403)', async () => {
    mockFindWorkspace.mockResolvedValue(null);
    expect((await post(message()))._getStatusCode()).toBe(403);
    expect(mockPostMessage).not.toHaveBeenCalled();
  });

  it('refuses an org-billed key that bills a different organization (403)', async () => {
    withKey({ organizationId: 'org-2', billingOwnerType: 'organization' });
    mockMemberOrgIds.mockResolvedValue([ORG, 'org-2']);
    expect((await post(message()))._getStatusCode()).toBe(403);
    expect(mockPostMessage).not.toHaveBeenCalled();
  });

  it.each([['not_in_channel'], ['channel_not_found']])(
    "maps Slack's %s to a 409 telling the caller to invite the bot",
    async slackError => {
      mockPostMessage.mockRejectedValue(slackPlatformError(slackError));
      const res = await post(message());

      expect(res._getStatusCode()).toBe(409);
      expect(res._getJSONData().errorCode).toBe('slack_bot_not_in_channel');
      expect(res._getJSONData().error).toMatch(/\/invite/);
    }
  );

  it('maps an archived channel to 409 and revoked workspace credentials to 401 provider_rejected', async () => {
    mockPostMessage.mockRejectedValueOnce(slackPlatformError('is_archived'));
    const archived = await post(message());
    expect(archived._getStatusCode()).toBe(409);
    expect(archived._getJSONData().errorCode).toBe('slack_channel_archived');

    mockPostMessage.mockRejectedValueOnce(slackPlatformError('token_revoked'));
    const revoked = await post(message());
    expect(revoked._getStatusCode()).toBe(401);
    expect(revoked._getJSONData().errorCode).toBe('provider_rejected');
  });

  it.each(['restricted_action', 'restricted_action_read_only_channel', 'restricted_action_thread_only_channel'])(
    'maps Slack %s to 409 slack_channel_restricted',
    async slackError => {
      mockPostMessage.mockRejectedValueOnce(slackPlatformError(slackError));
      const res = await post(message());
      expect(res._getStatusCode()).toBe(409);
      expect(res._getJSONData().errorCode).toBe('slack_channel_restricted');
    }
  );

  it('refuses a message mentioning more than 10 distinct users (422) before touching the channel config', async () => {
    const text = Array.from({ length: 11 }, (_, i) => `<@U${String(i).padStart(9, '0')}>`).join(' ');
    const res = await post(message({ text }));

    expect(res._getStatusCode()).toBe(422);
    expect(mockFindConfig).not.toHaveBeenCalled();
  });

  it('maps Slack rejecting the blocks to 422 and an unknown Slack failure to 502', async () => {
    mockPostMessage.mockRejectedValueOnce(slackPlatformError('invalid_blocks'));
    expect((await post(message({ blocks: [{ type: 'section', text: { type: 'bogus' } }] })))._getStatusCode()).toBe(
      422
    );

    mockPostMessage.mockRejectedValueOnce(new Error('socket hang up'));
    expect((await post(message()))._getStatusCode()).toBe(502);
  });

  it.each([
    ['a missing channel_id', { text: 'hi' }],
    ['a user id as channel_id', { channel_id: 'U0123ABCDEF', text: 'hi' }],
    ['a lowercase channel_id', { channel_id: 'c0123abcdef', text: 'hi' }],
    ['blank text', message({ text: '   ' })],
    ['text over 3,000 characters', message({ text: 'x'.repeat(3001) })],
    ['a malformed thread_ts', message({ thread_ts: '12345' })],
    ['more than 49 blocks', message({ blocks: Array.from({ length: 50 }, () => ({ type: 'divider' })) })],
    ['a block without a type', message({ blocks: [{ text: 'no type' }] })],
    [
      'blocks over the size cap',
      message({ blocks: [{ type: 'section', text: { type: 'mrkdwn', text: 'x'.repeat(40_001) } }] }),
    ],
    ['an unknown field', message({ reply_broadcast: true })],
    [
      'a button disguised as a link (forged action)',
      message({
        blocks: [
          {
            type: 'section',
            text: { type: 'mrkdwn', text: 'View logs' },
            accessory: {
              type: 'button',
              text: { type: 'plain_text', text: 'View logs' },
              action_id: 'sre_approve_fix',
            },
          },
        ],
      }),
    ],
    ['an actions block', message({ blocks: [{ type: 'actions', elements: [] }] })],
    [
      'a url button field',
      message({ blocks: [{ type: 'section', text: { type: 'mrkdwn', text: 'x' }, url: 'https://e.x' }] }),
    ],
    [
      'nesting past the depth ceiling',
      message({ blocks: [{ type: 'section', fields: [[[[[[[[[[[[[['x']]]]]]]]]]]]]] }] }),
    ],
  ])('rejects %s with 422 before any lookup', async (_label, body) => {
    const res = await post(body);

    expect(res._getStatusCode()).toBe(422);
    expect(mockFindConfig).not.toHaveBeenCalled();
    expect(mockPostMessage).not.toHaveBeenCalled();
  });

  it('limits per key and per user (30/min, 1,000/day) and per channel (60/min), answering 429 when spent', async () => {
    await post(message());
    type Window = { limit: number; windowMs: number; subject: (req: unknown) => string | undefined };
    const windows = mockSlackLimit.mock.calls.map(([options]) => options as Window);
    expect(windows.map(({ limit, windowMs }) => [limit, windowMs])).toEqual([
      [30, 60_000],
      [1000, 86_400_000],
      [30, 60_000],
      [1000, 86_400_000],
      [60, 60_000],
    ]);
    const req = { apiKeyInfo: { keyId: KEY_ID }, user: { id: 'user-1' }, body: { channel_id: CHANNEL } };
    expect(windows.map(window => window.subject(req))).toEqual([
      `api-key:${KEY_ID}`,
      `api-key:${KEY_ID}`,
      'user:user-1',
      'user:user-1',
      `channel:${CHANNEL}`,
    ]);
    expect(windows[4].subject({ ...req, body: { channel_id: 'nope' } })).toBeUndefined();

    // Spend only the channel window: the post is refused even though the key and user windows pass.
    mockSlackLimit.mockImplementation((options: Window, _req, _res, next) =>
      options.limit === 60 ? next(new TooManyRequestsError('slow down')) : next()
    );
    const res = await post(message());
    expect(res._getStatusCode()).toBe(429);
    expect(mockPostMessage).toHaveBeenCalledTimes(1);
  });

  it('spends the channel window only on an authorized post, so refused callers cannot exhaust it', async () => {
    const channelWindowCalls = () =>
      mockSlackLimit.mock.calls.filter(([options]) => (options as { limit: number }).limit === 60).length;
    mockMemberOrgIds.mockResolvedValue(['org-2']);

    expect((await post(message()))._getStatusCode()).toBe(403);
    expect(channelWindowCalls()).toBe(0);

    mockMemberOrgIds.mockResolvedValue([ORG]);
    expect((await post(message()))._getStatusCode()).toBe(200);
    expect(channelWindowCalls()).toBe(1);
  });
});
