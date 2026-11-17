import { beforeEach, expect, it, vi } from 'vitest';
import { Readable } from 'stream';
import { createResponse } from 'node-mocks-http';
import { feedbackId, signFeedback } from '@server/integrations/slack/feedbackProtocol';

const m = vi.hoisted(() => ({
  post: vi.fn(),
  delivery: vi.fn(),
  channel: vi.fn(),
  workspace: vi.fn(),
  claim: vi.fn(),
  audit: vi.fn(),
  info: vi.fn(),
  findChannel: vi.fn(),
  handlers: {} as Record<string, (req: unknown, res: unknown) => Promise<unknown>>,
}));
vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: () => ({
    post: (handler: (req: unknown, res: unknown) => Promise<unknown>) => {
      m.handlers.POST = handler;
    },
  }),
}));
vi.mock('@bike4mind/database/infra', () => ({
  orgSlackWorkspaceRepository: { findBySlackTeamIdWithToken: m.workspace },
  SlackFeedbackChannel: { findOne: m.findChannel },
  SlackFeedbackDelivery: { findById: () => ({ lean: m.delivery }), updateOne: m.claim },
  slackAuditLogRepository: { createLog: m.audit },
}));
vi.mock('@bike4mind/server-utils/security/tokenEncryption', () => ({ decryptToken: (token: string) => token }));
vi.mock('@server/integrations/slack/reactionFeedback', () => ({
  getFeedbackDestinations: () => [
    { id: 'receiver', organizationId: 'org1', secret: 'synthetic-callback-key-not-real-12345' },
    { id: 'foreign', organizationId: 'org2', secret: 'synthetic-foreign-callback-key-12345' },
  ],
}));
vi.mock('@slack/web-api', () => ({
  WebClient: class {
    chat = { postMessage: m.post };
    conversations = { info: m.info };
  },
}));
import '../status';

const deliveryId = feedbackId('message');
const secret = 'synthetic-callback-key-not-real-12345';
async function request(options: { signature?: string; body?: string } = {}) {
  const body = options.body ?? JSON.stringify({ deliveryId, status: 'filed' });
  const timestamp = String(Math.floor(Date.now() / 1000));
  const req = Object.assign(Readable.from([Buffer.from(body)]), {
    headers: {
      'x-b4m-timestamp': timestamp,
      'x-b4m-signature': options.signature ?? signFeedback(body, timestamp, secret, 'status'),
    },
  });
  const res = createResponse();
  await m.handlers.POST(req, res);
  return res;
}
beforeEach(() => {
  vi.resetAllMocks();
  m.findChannel.mockImplementation(() => ({ lean: m.channel }));
  m.info.mockResolvedValue({ channel: { is_member: true } });
  m.delivery.mockResolvedValue({
    _id: deliveryId,
    destinationId: 'receiver',
    organizationId: 'org1',
    workspaceId: 'ws1',
    slackTeamId: 'T1',
    channelId: 'C1',
    messageTs: '1.2',
    reactor: 'U1',
    state: 'sent',
  });
  m.workspace.mockResolvedValue({ id: 'ws1', organizationId: 'org1', slackBotToken: 'test-token' });
  m.channel.mockResolvedValue({ enabled: true });
  m.claim.mockResolvedValue({ modifiedCount: 1 });
  m.post.mockResolvedValue({ ok: true });
});
it('accepts a signed synthetic callback and posts fixed text into only the original thread', async () => {
  const res = await request();
  expect(res.statusCode).toBe(200);
  expect(res._getJSONData()).toEqual({ ok: true, posted: true });
  expect(m.post).toHaveBeenCalledWith(
    expect.objectContaining({
      channel: 'C1',
      thread_ts: '1.2',
      text: 'Feedback filed.',
      mrkdwn: false,
      metadata: { event_type: 'b4m_api_post', event_payload: { source: 'feedback_status' } },
    })
  );
  expect(m.claim.mock.invocationCallOrder[0]).toBeLessThan(m.post.mock.invocationCallOrder[0]);
  expect(m.findChannel).toHaveBeenCalledWith({
    _id: feedbackId('ws1', 'C1'),
    workspaceId: 'ws1',
    slackTeamId: 'T1',
    organizationId: 'org1',
    enabled: true,
    destinationId: 'receiver',
  });
});
it('rejects invalid authentication without posting', async () => {
  expect((await request({ signature: 'wrong' })).statusCode).toBe(401);
  expect(m.claim).not.toHaveBeenCalled();
  expect(m.post).not.toHaveBeenCalled();
});
it('does not post a replayed status', async () => {
  m.claim.mockResolvedValue({ modifiedCount: 0 });
  expect((await request())._getJSONData()).toEqual({ ok: true, posted: false });
  expect(m.post).not.toHaveBeenCalled();
});
it('returns a retryable conflict for a callback before forward acceptance is recorded', async () => {
  m.delivery.mockResolvedValue({ destinationId: 'receiver', organizationId: 'org1', state: 'sending' });
  expect((await request()).statusCode).toBe(409);
  expect(m.claim).not.toHaveBeenCalled();
  expect(m.post).not.toHaveBeenCalled();
});
it('refuses callbacks after disconnect or opt-out', async () => {
  m.channel.mockResolvedValue(null);
  expect((await request()).statusCode).toBe(410);
  expect(m.post).not.toHaveBeenCalled();
});
it('refuses callbacks for a replaced workspace connection', async () => {
  m.workspace.mockResolvedValue({ id: 'ws-other', organizationId: 'org1' });
  expect((await request()).statusCode).toBe(410);
  expect(m.post).not.toHaveBeenCalled();
});
it('caps raw body size and rejects arbitrary status text', async () => {
  expect((await request({ body: 'x'.repeat(4097) })).statusCode).toBe(413);
  expect((await request({ body: JSON.stringify({ deliveryId, status: '<!channel>' }) })).statusCode).toBe(400);
  expect(m.post).not.toHaveBeenCalled();
});
it('rejects a valid signature from another destination secret', async () => {
  const body = JSON.stringify({ deliveryId, status: 'filed' });
  const timestamp = String(Math.floor(Date.now() / 1000));
  expect(
    (
      await request({
        body,
        signature: signFeedback(body, timestamp, 'synthetic-foreign-callback-key-12345', 'status'),
      })
    ).statusCode
  ).toBe(401);
  expect(m.claim).not.toHaveBeenCalled();
});
it('refuses a delivery bound to another organization destination', async () => {
  m.delivery.mockResolvedValue({ destinationId: 'foreign', organizationId: 'org1', state: 'sent' });
  const body = JSON.stringify({ deliveryId, status: 'filed' });
  const timestamp = String(Math.floor(Date.now() / 1000));
  expect(
    (
      await request({
        body,
        signature: signFeedback(body, timestamp, 'synthetic-foreign-callback-key-12345', 'status'),
      })
    ).statusCode
  ).toBe(401);
});
it.each(['is_shared', 'is_org_shared', 'is_ext_shared', 'is_pending_ext_shared'])(
  'does not post status to %s',
  async flag => {
    m.info.mockResolvedValue({ channel: { is_member: true, [flag]: true } });
    expect((await request()).statusCode).toBe(410);
    expect(m.claim).not.toHaveBeenCalled();
    expect(m.post).not.toHaveBeenCalled();
  }
);
it('returns a retryable 503 without claiming when Slack lookup fails', async () => {
  m.info.mockRejectedValue(new Error('xoxb-secret failure'));
  const res = await request();
  expect(res.statusCode).toBe(503);
  expect(res._getJSONData()).toEqual({ error: 'Slack is unavailable' });
  expect(m.claim).not.toHaveBeenCalled();
  expect(m.post).not.toHaveBeenCalled();
});
