import { WebClient } from '@slack/web-api';
import {
  orgSlackWorkspaceRepository,
  SlackFeedbackChannel,
  SlackFeedbackDelivery,
  slackAuditLogRepository,
} from '@bike4mind/database/infra';
import { Logger } from '@bike4mind/observability';
import { decryptToken } from '@bike4mind/server-utils/security/tokenEncryption';
import { baseApi } from '@server/middlewares/baseApi';
import { getFeedbackDestinations } from '@server/integrations/slack/reactionFeedback';
import {
  feedbackId,
  isFeedbackChannelEligible,
  statusLabels,
  statusSchema,
  verifyFeedback,
} from '@server/integrations/slack/feedbackProtocol';

const handler = baseApi({ auth: false }).post(async (req, res) => {
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    length += buffer.length;
    if (length > 4096) return res.status(413).json({ error: 'Payload too large' });
    chunks.push(buffer);
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  let input: unknown;
  try {
    input = JSON.parse(raw);
  } catch {
    return res.status(400).json({ error: 'Invalid payload' });
  }
  const parsed = statusSchema.safeParse(input);
  if (!parsed.success) return res.status(400).json({ error: 'Invalid payload' });
  const { deliveryId, status } = parsed.data;
  const delivery = await SlackFeedbackDelivery.findById(deliveryId).lean();
  const destination =
    delivery &&
    getFeedbackDestinations().find(
      d => d.id === delivery.destinationId && d.organizationId === delivery.organizationId
    );
  if (
    !destination ||
    !verifyFeedback(raw, req.headers['x-b4m-timestamp'], req.headers['x-b4m-signature'], destination.secret)
  ) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  if (delivery.state !== 'sent') {
    return res.status(409).json({ error: 'Delivery has not been confirmed' });
  }
  const workspace = await orgSlackWorkspaceRepository.findBySlackTeamIdWithToken(delivery.slackTeamId);
  const channel = await SlackFeedbackChannel.findOne({
    _id: feedbackId(delivery.workspaceId, delivery.channelId),
    workspaceId: delivery.workspaceId,
    slackTeamId: delivery.slackTeamId,
    organizationId: delivery.organizationId,
    enabled: true,
    destinationId: delivery.destinationId,
  }).lean();
  if (
    !workspace ||
    workspace.id !== delivery.workspaceId ||
    workspace.organizationId !== delivery.organizationId ||
    !channel
  ) {
    return res.status(410).json({ error: 'Integration is disabled' });
  }
  const token = decryptToken(workspace.slackBotToken);
  if (!token) return res.status(410).json({ error: 'Integration is disabled' });
  const client = new WebClient(token, { retryConfig: { retries: 0 }, timeout: 2000 });
  let info: Awaited<ReturnType<typeof client.conversations.info>>;
  try {
    info = await client.conversations.info({ channel: delivery.channelId });
  } catch (error) {
    Logger.warn('Slack feedback status: channel lookup failed', {
      deliveryId,
      error: error instanceof Error ? error.name : 'unknown',
    });
    return res.status(503).json({ error: 'Slack is unavailable' });
  }
  if (!isFeedbackChannelEligible(info.channel)) {
    return res.status(410).json({ error: 'Channel is not eligible' });
  }
  // Claim before posting: a replay or ambiguous Slack timeout must never post a second reply.
  const claim = await SlackFeedbackDelivery.updateOne(
    {
      _id: deliveryId,
      state: 'sent',
      statuses: { $ne: status },
    },
    { $addToSet: { statuses: status } }
  );
  if (!claim.modifiedCount) return res.json({ ok: true, posted: false });
  await slackAuditLogRepository.createLog({
    eventType: 'api_call',
    action: 'feedback_status',
    slackUserId: delivery.reactor,
    slackTeamId: delivery.slackTeamId,
    resourceType: 'message',
    resourceId: deliveryId,
    success: true,
    metadata: { status, phase: 'claimed' },
  });
  try {
    await client.chat.postMessage({
      channel: delivery.channelId,
      thread_ts: delivery.messageTs,
      text: statusLabels[status],
      mrkdwn: false,
      unfurl_links: false,
      unfurl_media: false,
      metadata: { event_type: 'b4m_api_post', event_payload: { source: 'feedback_status' } },
    });
    return res.json({ ok: true, posted: true });
  } catch {
    await slackAuditLogRepository.createLog({
      eventType: 'api_call',
      action: 'feedback_status',
      slackUserId: delivery.reactor,
      slackTeamId: delivery.slackTeamId,
      resourceType: 'message',
      resourceId: deliveryId,
      success: false,
      metadata: { status, phase: 'failed' },
    });
    return res.status(502).json({ error: 'Status delivery failed' });
  }
});

export const config = { api: { bodyParser: false, externalResolver: true } };
export default handler;
