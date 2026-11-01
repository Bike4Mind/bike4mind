// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMocks } from 'node-mocks-http';
import { BadRequestError, ConflictError, NotFoundError } from '@bike4mind/common';

const { routeHandlers, baseApiOptions } = vi.hoisted(() => ({
  routeHandlers: {} as Record<string, (req: unknown, res: unknown) => Promise<unknown>>,
  baseApiOptions: [] as unknown[],
}));

vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: (options: unknown) => {
    baseApiOptions.push(options);
    const chain = {
      get(fn: (req: unknown, res: unknown) => Promise<unknown>) {
        routeHandlers.GET = fn;
        return chain;
      },
      put(fn: (req: unknown, res: unknown) => Promise<unknown>) {
        routeHandlers.PUT = fn;
        return chain;
      },
    };
    return chain;
  },
}));

// verifyOrgOwner runs for real against a stubbed organizationRepository, so the owner gate itself is under test.
const mockOrgFindById = vi.fn();
const mockFindWorkspace = vi.fn();
const mockFindWorkspaceWithToken = vi.fn();
const mockFindEnabled = vi.fn();
const mockFindConfig = vi.fn();
const mockSetApiPosting = vi.fn();
vi.mock('@bike4mind/database/infra', () => ({
  organizationRepository: { findById: (...a: unknown[]) => mockOrgFindById(...a) },
  orgSlackWorkspaceRepository: {
    findByOrganizationId: (...a: unknown[]) => mockFindWorkspace(...a),
    findByOrganizationIdWithToken: (...a: unknown[]) => mockFindWorkspaceWithToken(...a),
  },
  slackChannelConfigRepository: {
    findApiPostEnabledBySlackTeamId: (...a: unknown[]) => mockFindEnabled(...a),
    findByChannelId: (...a: unknown[]) => mockFindConfig(...a),
    setApiPostingByChannelId: (...a: unknown[]) => mockSetApiPosting(...a),
  },
}));
vi.mock('@bike4mind/database', () => ({ organizationRepository: {} }));

vi.mock('@bike4mind/server-utils/security/tokenEncryption', () => ({
  decryptToken: (value: string | null | undefined) => (value ? `decrypted:${value}` : null),
}));

const mockRecordAdminAction = vi.fn();
vi.mock('@server/utils/adminAudit', () => ({
  recordAdminActionFromRequest: (...a: unknown[]) => mockRecordAdminAction(...a),
}));

const mockConversationsInfo = vi.fn();
const webClientTokens: unknown[] = [];
vi.mock('@slack/web-api', () => ({
  WebClient: class {
    conversations = { info: (...a: unknown[]) => mockConversationsInfo(...a) };
    constructor(token: unknown) {
      webClientTokens.push(token);
    }
  },
}));

import '../channels';

const ORG = '650000000000000000000abc';
const OWNER = '650000000000000000000111';
const STRANGER = '650000000000000000000333';
const CHANNEL = 'C0123ABCDEF';
const TEAM = 'T0123ABCD';
const KEY_ID = '650000000000000000000999';

const owner = { id: OWNER, isAdmin: false };
const stranger = { id: STRANGER, isAdmin: false };

function makeReq(user: { id: string; isAdmin: boolean }, body?: unknown, method: 'GET' | 'PUT' = 'PUT') {
  const { req, res } = createMocks({ method });
  (req as Record<string, unknown>).query = { id: ORG };
  (req as Record<string, unknown>).user = user;
  (req as Record<string, unknown>).body = body;
  return { req, res };
}

beforeEach(() => {
  vi.clearAllMocks();
  webClientTokens.length = 0;
  mockOrgFindById.mockResolvedValue({ id: ORG, name: 'Acme', userId: OWNER });
  mockFindWorkspace.mockResolvedValue({ id: 'ws_1', organizationId: ORG, slackTeamId: TEAM });
  mockFindWorkspaceWithToken.mockResolvedValue({
    id: 'ws_1',
    organizationId: ORG,
    slackTeamId: TEAM,
    slackBotToken: 'enc-token',
  });
  mockFindConfig.mockResolvedValue(null);
  mockSetApiPosting.mockImplementation(async (channelId: string, update: Record<string, unknown>) => ({
    channelId,
    ...update,
  }));
  mockConversationsInfo.mockResolvedValue({ ok: true, channel: { id: CHANNEL, is_member: true } });
  mockRecordAdminAction.mockResolvedValue(undefined);
});

it('is session-only', () => {
  expect(baseApiOptions).toContainEqual({ auth: 'jwtOnly' });
});

describe('PUT /api/organizations/[id]/integrations/slack/channels', () => {
  it("enables a channel of the org's workspace for the owner, checked against Slack with the bot token", async () => {
    const { req, res } = makeReq(owner, { channelId: CHANNEL, apiPostEnabled: true, apiPostAllowedKeyIds: [KEY_ID] });

    await routeHandlers.PUT(req, res);

    expect(webClientTokens).toEqual(['decrypted:enc-token']);
    expect(mockConversationsInfo).toHaveBeenCalledWith({ channel: CHANNEL });
    expect(mockSetApiPosting).toHaveBeenCalledWith(CHANNEL, {
      slackTeamId: TEAM,
      organizationId: ORG,
      apiPostEnabled: true,
      apiPostAllowedKeyIds: [KEY_ID],
      configuredBy: OWNER,
    });
    expect(res._getJSONData()).toEqual({
      channelId: CHANNEL,
      apiPostEnabled: true,
      apiPostAllowedKeyIds: [KEY_ID],
      botIsMember: true,
    });
    expect(mockRecordAdminAction).toHaveBeenCalledWith(
      req,
      expect.objectContaining({ action: 'org.slack_channel_api_posting.updated' })
    );
  });

  it('reports when the bot still has to be invited', async () => {
    mockConversationsInfo.mockResolvedValue({ ok: true, channel: { id: CHANNEL, is_member: false } });
    const { req, res } = makeReq(owner, { channelId: CHANNEL, apiPostEnabled: true });

    await routeHandlers.PUT(req, res);

    expect(res._getJSONData()).toMatchObject({ apiPostEnabled: true, botIsMember: false });
  });

  it('disables a channel without asking Slack', async () => {
    const { req, res } = makeReq(owner, { channelId: CHANNEL, apiPostEnabled: false });

    await routeHandlers.PUT(req, res);

    expect(mockConversationsInfo).not.toHaveBeenCalled();
    expect(mockSetApiPosting).toHaveBeenCalledWith(CHANNEL, expect.objectContaining({ apiPostEnabled: false }));
    expect(res._getJSONData()).toEqual({ channelId: CHANNEL, apiPostEnabled: false, apiPostAllowedKeyIds: [] });
  });

  it('404s a non-owner and changes nothing', async () => {
    const { req, res } = makeReq(stranger, { channelId: CHANNEL, apiPostEnabled: true });

    await expect(routeHandlers.PUT(req, res)).rejects.toBeInstanceOf(NotFoundError);
    expect(mockFindWorkspaceWithToken).not.toHaveBeenCalled();
    expect(mockSetApiPosting).not.toHaveBeenCalled();
  });

  it('404s a channel Slack cannot find in the workspace', async () => {
    mockConversationsInfo.mockRejectedValue(
      Object.assign(new Error('channel_not_found'), { data: { ok: false, error: 'channel_not_found' } })
    );
    const { req, res } = makeReq(owner, { channelId: CHANNEL, apiPostEnabled: true });

    await expect(routeHandlers.PUT(req, res)).rejects.toBeInstanceOf(NotFoundError);
    expect(mockSetApiPosting).not.toHaveBeenCalled();
  });

  it('404s when the org has no Slack workspace', async () => {
    mockFindWorkspaceWithToken.mockResolvedValue(null);
    const { req, res } = makeReq(owner, { channelId: CHANNEL, apiPostEnabled: true });

    await expect(routeHandlers.PUT(req, res)).rejects.toBeInstanceOf(NotFoundError);
  });

  it('409s a channel already configured under another workspace', async () => {
    mockSetApiPosting.mockResolvedValue(null);
    const { req, res } = makeReq(owner, { channelId: CHANNEL, apiPostEnabled: true });

    await expect(routeHandlers.PUT(req, res)).rejects.toBeInstanceOf(ConflictError);
    expect(mockRecordAdminAction).not.toHaveBeenCalled();
  });

  it.each([
    ['a malformed channel id', { channelId: 'general', apiPostEnabled: true }],
    ['a missing flag', { channelId: CHANNEL }],
    ['a malformed key id', { channelId: CHANNEL, apiPostEnabled: true, apiPostAllowedKeyIds: ['nope'] }],
    ['an unknown field', { channelId: CHANNEL, apiPostEnabled: true, slackTeamId: 'T999' }],
  ])('400s %s', async (_label, body) => {
    const { req, res } = makeReq(owner, body);

    await expect(routeHandlers.PUT(req, res)).rejects.toBeInstanceOf(BadRequestError);
    expect(mockSetApiPosting).not.toHaveBeenCalled();
  });
});

describe('GET /api/organizations/[id]/integrations/slack/channels', () => {
  it("lists the workspace's API-posting channels to the owner", async () => {
    mockFindEnabled.mockResolvedValue([{ channelId: CHANNEL, slackTeamId: TEAM, apiPostEnabled: true }]);
    const { req, res } = makeReq(owner, undefined, 'GET');

    await routeHandlers.GET(req, res);

    expect(mockFindEnabled).toHaveBeenCalledWith(TEAM);
    expect(res._getJSONData()).toEqual({
      channels: [{ channelId: CHANNEL, apiPostEnabled: true, apiPostAllowedKeyIds: [] }],
    });
  });

  it('404s a non-owner without reading the workspace', async () => {
    const { req, res } = makeReq(stranger, undefined, 'GET');

    await expect(routeHandlers.GET(req, res)).rejects.toBeInstanceOf(NotFoundError);
    expect(mockFindWorkspace).not.toHaveBeenCalled();
  });
});
