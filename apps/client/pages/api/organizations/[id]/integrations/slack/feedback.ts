import { z } from 'zod';
import { WebClient } from '@slack/web-api';
import { orgSlackWorkspaceRepository, SlackFeedbackChannel, slackAuditLogRepository } from '@bike4mind/database/infra';
import { verifyOrgOwner } from '@bike4mind/server-utils/utils/orgAccess';
import { decryptToken } from '@bike4mind/server-utils/security/tokenEncryption';
import { parseOrBadRequest } from '@bike4mind/server-utils/utils/errors';
import { BadRequestError, NotFoundError } from '@bike4mind/utils';
import { baseApi } from '@server/middlewares/baseApi';
import { getFeedbackDestinations } from '@server/integrations/slack/reactionFeedback';
import { feedbackId } from '@server/integrations/slack/feedbackProtocol';
import { respond } from '@server/utils/respond';

const responseSchema = z.object({
  channels: z.array(z.object({ channelId: z.string(), destinationId: z.string(), emoji: z.string() })),
  destinations: z.array(z.string()),
});

const updateSchema = z.strictObject({
  channelId: z.string().regex(/^C[A-Z0-9]{8,}$/),
  enabled: z.boolean(),
  emoji: z
    .string()
    .regex(/^[a-z0-9_+-]{1,64}$/)
    .default('bug'),
  destinationId: z
    .string()
    .regex(/^[a-z0-9_-]{1,64}$/)
    .optional(),
});

const handler = baseApi({ auth: 'jwtOnly' })
  .get(async (req, res) => {
    const org = await verifyOrgOwner(req.user!, String(req.query.id));
    const workspace = await orgSlackWorkspaceRepository.findByOrganizationId(org.id);
    if (!workspace?.enabled) throw new NotFoundError('No Slack workspace connected');
    const channels = await SlackFeedbackChannel.find({
      workspaceId: workspace.id,
      organizationId: org.id,
      enabled: true,
    })
      .select('channelId destinationId emoji -_id')
      .lean();
    return respond(res, responseSchema, {
      channels,
      destinations: getFeedbackDestinations()
        .filter(d => d.organizationId === org.id)
        .map(d => d.id),
    });
  })
  .put(async (req, res) => {
    const org = await verifyOrgOwner(req.user!, String(req.query.id));
    const update = parseOrBadRequest(updateSchema, req.body);
    const workspace = await orgSlackWorkspaceRepository.findByOrganizationIdWithToken(org.id);
    if (!workspace) throw new NotFoundError('No Slack workspace connected');
    const id = feedbackId(workspace.id, update.channelId);
    if (update.enabled) {
      if (!getFeedbackDestinations().some(d => d.id === update.destinationId && d.organizationId === org.id)) {
        throw new BadRequestError('Destination is not provisioned for this organization');
      }
      const token = decryptToken(workspace.slackBotToken);
      if (!token) throw new BadRequestError('Reconnect Slack');
      const client = new WebClient(token, { retryConfig: { retries: 0 }, timeout: 2000 });
      const info = await client.conversations.info({ channel: update.channelId });
      if (!info.channel?.is_member || info.channel.is_im || info.channel.is_mpim || info.channel.is_ext_shared) {
        throw new BadRequestError('Invite the bot to a non-shared channel in this workspace first');
      }
    }
    await slackAuditLogRepository.createLog({
      eventType: 'api_call',
      action: 'feedback_opt_in',
      slackUserId: req.user!.id,
      slackTeamId: workspace.slackTeamId,
      resourceType: 'settings',
      resourceId: id,
      success: true,
      metadata: { organizationId: org.id, channelId: update.channelId, enabled: update.enabled, phase: 'requested' },
    });
    if (update.enabled) {
      await SlackFeedbackChannel.updateOne(
        { _id: id },
        {
          $set: {
            organizationId: org.id,
            workspaceId: workspace.id,
            slackTeamId: workspace.slackTeamId,
            channelId: update.channelId,
            destinationId: update.destinationId,
            emoji: update.emoji,
            enabled: true,
            configuredBy: req.user!.id,
          },
        },
        { upsert: true, runValidators: true }
      );
    } else {
      await SlackFeedbackChannel.updateOne({ _id: id, organizationId: org.id }, { $set: { enabled: false } });
    }
    return res.json({ ok: true });
  });

export default handler;
