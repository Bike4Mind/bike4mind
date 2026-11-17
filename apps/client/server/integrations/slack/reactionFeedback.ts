import { WebClient } from '@slack/web-api';
import { cacheRepository } from '@bike4mind/database';
import {
  orgSlackWorkspaceRepository,
  SlackFeedbackChannel,
  SlackFeedbackDelivery,
  slackAuditLogRepository,
} from '@bike4mind/database/infra';
import { decryptToken } from '@bike4mind/server-utils/security/tokenEncryption';
import { fetchPinned } from '@bike4mind/server-utils/utils/ssrfProtection';
import { Config } from '@bike4mind/server-utils/utils/config';
import { z } from 'zod';
import {
  feedbackDestinations,
  feedbackId,
  isFeedbackChannelEligible,
  reactionSchema,
  signFeedback,
} from './feedbackProtocol';
import { Logger } from '@bike4mind/observability';

export function getFeedbackDestinations() {
  return feedbackDestinations(Config.SLACK_FEEDBACK_DESTINATIONS);
}

const messageSchema = z.object({
  ts: z.string(),
  user: z.string().optional(),
  text: z.string().optional(),
  bot_id: z.string().optional(),
  subtype: z.string().optional(),
  metadata: z.object({ event_type: z.string() }).optional(),
  files: z.array(z.object({ name: z.string().optional() })).optional(),
});

export async function forwardSlackReaction(teamId: string, appId: string, input: unknown) {
  const parsed = reactionSchema.safeParse(input);
  if (!parsed.success) return;
  const event = parsed.data;
  const workspace = await orgSlackWorkspaceRepository.findBySlackTeamIdWithToken(teamId);
  if (!workspace || workspace.slackAppId !== appId || event.user === workspace.slackBotUserId) return;
  const channel = await SlackFeedbackChannel.findOne({
    _id: feedbackId(workspace.id, event.item.channel),
    workspaceId: workspace.id,
    organizationId: workspace.organizationId,
    slackTeamId: teamId,
    enabled: true,
    emoji: event.reaction,
  }).lean();
  if (!channel) return;
  const destination = getFeedbackDestinations().find(
    d => d.id === channel.destinationId && d.organizationId === workspace.organizationId
  );
  const token = decryptToken(workspace.slackBotToken);
  if (!destination || !token) return;
  const id = feedbackId(workspace.id, teamId, event.item.channel, event.item.ts);
  try {
    await SlackFeedbackDelivery.create({
      _id: id,
      organizationId: workspace.organizationId,
      workspaceId: workspace.id,
      slackTeamId: teamId,
      channelId: event.item.channel,
      messageTs: event.item.ts,
      reactor: event.user,
      destinationId: destination.id,
      state: 'claimed',
    });
  } catch (error) {
    if ((error as { code?: number }).code === 11000) return;
    throw error;
  }
  const client = new WebClient(token, { retryConfig: { retries: 0 }, timeout: 2000 });
  const finish = async (state: 'ignored' | 'limited' | 'sent' | 'failed') => {
    await SlackFeedbackDelivery.updateOne({ _id: id }, { $set: { state } });
    await slackAuditLogRepository.createLog({
      eventType: 'event',
      action: 'feedback_forward',
      resourceType: 'message',
      resourceId: id,
      slackTeamId: teamId,
      slackUserId: event.user,
      success: state === 'sent',
      metadata: {
        organizationId: workspace.organizationId,
        channelId: channel.channelId,
        destinationId: destination.id,
        state,
      },
    });
  };
  let accepted = false;
  try {
    const info = await client.conversations.info({ channel: channel.channelId });
    if (!isFeedbackChannelEligible(info.channel)) {
      return await finish('ignored');
    }
    // reactions.get fetches the selected message, including replies, without reading channel history.
    const result = await client.reactions.get({ channel: channel.channelId, timestamp: event.item.ts, full: true });
    const message = messageSchema.parse(result.message);
    if (
      !message ||
      message.ts !== event.item.ts ||
      !message.user ||
      message.bot_id ||
      message.subtype ||
      message.user === workspace.slackBotUserId ||
      message.metadata?.event_type === 'b4m_api_post'
    ) {
      return await finish('ignored');
    }
    const author = await client.users.info({ user: message.user });
    const reactor = await client.users.info({ user: event.user });
    if (
      !author.user ||
      author.user.is_bot ||
      author.user.deleted ||
      reactor.user?.is_bot ||
      reactor.user?.deleted ||
      !reactor.user
    ) {
      return await finish('ignored');
    }
    const permalink = await client.chat.getPermalink({ channel: channel.channelId, message_ts: event.item.ts });
    if (!permalink.permalink) throw new Error('Missing permalink');
    const body = JSON.stringify({
      version: 1,
      type: 'slack.reaction_feedback',
      deliveryId: id,
      organizationId: workspace.organizationId,
      reporterContentTrust: 'untrusted',
      channelId: channel.channelId,
      messageTs: event.item.ts,
      permalink: permalink.permalink,
      author: { slackId: message.user, email: author.user?.profile?.email },
      reactor: { slackId: event.user },
      text: (message.text ?? '').slice(0, 40000),
      fileNames: (message.files ?? []).slice(0, 50).map(file => (file.name ?? '').slice(0, 255)),
    });
    const currentWorkspace = await orgSlackWorkspaceRepository.findBySlackTeamIdWithToken(teamId);
    const currentChannel = await SlackFeedbackChannel.findOne({
      _id: feedbackId(workspace.id, channel.channelId),
      workspaceId: workspace.id,
      slackTeamId: teamId,
      organizationId: workspace.organizationId,
      enabled: true,
      destinationId: destination.id,
      emoji: event.reaction,
    }).lean();
    if (
      !currentWorkspace ||
      currentWorkspace.id !== workspace.id ||
      currentWorkspace.organizationId !== workspace.organizationId ||
      !currentChannel
    ) {
      return await finish('ignored');
    }
    const orgLimit = await cacheRepository.tryIncrementWithinLimitFixedWindow(
      `slack-feedback:org:${workspace.organizationId}`,
      100,
      3600000
    );
    const channelLimit = await cacheRepository.tryIncrementWithinLimitFixedWindow(
      `slack-feedback:channel:${teamId}:${channel.channelId}`,
      10,
      3600000
    );
    if (!orgLimit.success || !channelLimit.success) return await finish('limited');
    // Audit intent durably before the non-transactional external side effect. Claims are never retried.
    await SlackFeedbackDelivery.updateOne({ _id: id }, { $set: { state: 'sending' } });
    const timestamp = String(Math.floor(Date.now() / 1000));
    const response = await fetchPinned(
      destination.url,
      {
        method: 'POST',
        body,
        redirect: 'error',
        signal: AbortSignal.timeout(3000),
        headers: {
          'content-type': 'application/json',
          'x-b4m-timestamp': timestamp,
          'x-b4m-signature': signFeedback(body, timestamp, destination.secret, 'forward'),
          'idempotency-key': id,
        },
      },
      { discardBody: true }
    );
    accepted = response.ok;
    await response.body?.cancel().catch(() => undefined);
    if (!response.ok) return await finish('failed');
    await finish('sent');
    await client.reactions
      .add({ channel: channel.channelId, timestamp: event.item.ts, name: 'eyes' })
      .catch(() => undefined);
  } catch (error) {
    // SDK/network errors can embed tokens or destination URLs, so log only safe classifications.
    Logger.error('Slack feedback forwarding failed', {
      deliveryId: id,
      accepted,
      errorType: error instanceof Error ? error.name : 'UnknownError',
    });
    if (accepted) {
      await Promise.resolve(
        SlackFeedbackDelivery.updateOne({ _id: id, state: 'sending' }, { $set: { state: 'sent' } })
      ).catch(() => undefined);
    } else {
      await finish('failed');
    }
  }
}
