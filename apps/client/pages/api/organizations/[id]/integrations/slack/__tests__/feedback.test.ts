import { beforeEach, expect, it, vi } from 'vitest';
import { createMocks } from 'node-mocks-http';
const m = vi.hoisted(() => ({
  handlers: {} as Record<string, (req: unknown, res: unknown) => Promise<unknown>>,
  options: [] as unknown[],
  org: vi.fn(),
  workspace: vi.fn(),
  update: vi.fn(),
  list: vi.fn(),
  audit: vi.fn(),
  info: vi.fn(),
}));
vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: (options: unknown) => {
    m.options.push(options);
    const chain = {
      get: (fn: (req: unknown, res: unknown) => Promise<unknown>) => {
        m.handlers.GET = fn;
        return chain;
      },
      put: (fn: (req: unknown, res: unknown) => Promise<unknown>) => {
        m.handlers.PUT = fn;
        return chain;
      },
    };
    return chain;
  },
}));
vi.mock('@bike4mind/database/infra', () => ({
  organizationRepository: { findById: m.org },
  orgSlackWorkspaceRepository: { findByOrganizationId: m.workspace, findByOrganizationIdWithToken: m.workspace },
  SlackFeedbackChannel: { updateOne: m.update, find: () => ({ select: () => ({ lean: m.list }) }) },
  slackAuditLogRepository: { createLog: m.audit },
}));
vi.mock('@bike4mind/database', () => ({ organizationRepository: {} }));
vi.mock('@bike4mind/server-utils/security/tokenEncryption', () => ({ decryptToken: (token: string) => token }));
vi.mock('@server/integrations/slack/reactionFeedback', () => ({
  getFeedbackDestinations: () => [
    {
      id: 'receiver',
      organizationId: '650000000000000000000abc',
      url: 'https://receiver.example',
      secret: 'must-not-expose',
    },
    { id: 'foreign', organizationId: 'other-org', secret: 'foreign-secret' },
  ],
}));
vi.mock('@slack/web-api', () => ({
  WebClient: class {
    conversations = { info: m.info };
  },
}));
import '../feedback';
const orgId = '650000000000000000000abc';
const ownerId = '650000000000000000000111';
const update = { channelId: 'C12345678', enabled: true, destinationId: 'receiver' };
function request(body: unknown = update, userId = ownerId) {
  const { req, res } = createMocks();
  Object.assign(req, { query: { id: orgId }, body, user: { id: userId, isAdmin: false } });
  return { req, res };
}
beforeEach(() => {
  vi.clearAllMocks();
  m.org.mockResolvedValue({ id: orgId, userId: ownerId });
  m.workspace.mockResolvedValue({ id: 'ws1', enabled: true, slackTeamId: 'T1', slackBotToken: 'test-token' });
  m.info.mockResolvedValue({ channel: { is_member: true } });
  m.list.mockResolvedValue([{ ...update, emoji: 'bug', secret: 'must-strip' }]);
});
it('is session-only and owner-only for reads and writes', async () => {
  expect(m.options).toContainEqual({ auth: 'jwtOnly' });
  for (const method of ['GET', 'PUT']) {
    const { req, res } = request(update, '650000000000000000000222');
    await expect(m.handlers[method](req, res)).rejects.toThrow('Organization not found');
  }
  expect(m.workspace).not.toHaveBeenCalled();
  expect(m.update).not.toHaveBeenCalled();
});
it('returns only own destination ids and the allowlisted channel fields', async () => {
  const { req, res } = request();
  await m.handlers.GET(req, res);
  expect(res._getJSONData()).toEqual({
    channels: [{ channelId: 'C12345678', destinationId: 'receiver', emoji: 'bug' }],
    destinations: ['receiver'],
  });
});
it('enables only an explicitly checked channel', async () => {
  const { req, res } = request();
  await m.handlers.PUT(req, res);
  expect(m.info).toHaveBeenCalledWith({ channel: 'C12345678' });
  expect(m.update).toHaveBeenCalledWith(
    expect.anything(),
    {
      $set: expect.objectContaining({
        organizationId: orgId,
        workspaceId: 'ws1',
        channelId: 'C12345678',
        destinationId: 'receiver',
        emoji: 'bug',
        enabled: true,
      }),
    },
    { upsert: true, runValidators: true }
  );
});
it('refuses a destination belonging to another org', async () => {
  const { req, res } = request({ ...update, destinationId: 'foreign' });
  await expect(m.handlers.PUT(req, res)).rejects.toThrow('Destination is not provisioned');
  expect(m.info).not.toHaveBeenCalled();
  expect(m.update).not.toHaveBeenCalled();
});
it.each([{ is_ext_shared: true }, { is_im: true }, { is_mpim: true }, { is_member: false }])(
  'refuses excluded channels %j',
  async fields => {
    m.info.mockResolvedValue({ channel: { is_member: true, ...fields } });
    const { req, res } = request();
    await expect(m.handlers.PUT(req, res)).rejects.toThrow('non-shared channel');
    expect(m.update).not.toHaveBeenCalled();
  }
);
it('allows opt-out without a Slack call and without upsert', async () => {
  const { req, res } = request({ channelId: 'C12345678', enabled: false });
  await m.handlers.PUT(req, res);
  expect(m.info).not.toHaveBeenCalled();
  expect(m.update).toHaveBeenCalledWith(expect.objectContaining({ organizationId: orgId }), {
    $set: { enabled: false },
  });
});
