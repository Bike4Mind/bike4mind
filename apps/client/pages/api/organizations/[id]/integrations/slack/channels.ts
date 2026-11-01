/**
 * Slack channels enabled for API posting (POST /api/v1/slack/messages).
 *
 * GET /api/organizations/[id]/integrations/slack/channels - channels of the org's workspace with API posting on
 * PUT /api/organizations/[id]/integrations/slack/channels - turn API posting on or off for one channel
 *
 * Owner only (verifyOrgOwner), like the sibling integrations/slack routes: it decides what external
 * systems may say in the org's Slack. Session only: an API key must not widen its own reach.
 */

import { z } from 'zod';
import { parseOrBadRequest } from '@bike4mind/server-utils/utils/errors';
import { decryptToken } from '@bike4mind/server-utils/security/tokenEncryption';
import { verifyOrgOwner } from '@bike4mind/server-utils/utils/orgAccess';
import { orgSlackWorkspaceRepository, slackChannelConfigRepository } from '@bike4mind/database/infra';
import { ConflictError, NotFoundError, SLACK_CHANNEL_ID_PATTERN, type ISlackChannelConfig } from '@bike4mind/common';
import { asyncHandler } from '@server/middlewares/asyncHandler';
import { baseApi } from '@server/middlewares/baseApi';
import { recordAdminActionFromRequest } from '@server/utils/adminAudit';
import { WebClient } from '@slack/web-api';

const MAX_ALLOWED_KEY_IDS = 50;

const UpdateApiPostingSchema = z.strictObject({
  channelId: z.string().regex(SLACK_CHANNEL_ID_PATTERN, 'channelId must be a Slack channel id such as C0123ABCD'),
  apiPostEnabled: z.boolean(),
  /** API key ids allowed to post; empty or omitted means any `slack:post` key of an org member. */
  apiPostAllowedKeyIds: z
    .array(z.string().regex(/^[a-f0-9]{24}$/, 'API key ids are 24 hex characters'))
    .max(MAX_ALLOWED_KEY_IDS)
    .optional(),
});

type ApiPostingView = Pick<ISlackChannelConfig, 'channelId' | 'apiPostEnabled' | 'apiPostAllowedKeyIds'>;

const toView = (config: ApiPostingView) => ({
  channelId: config.channelId,
  apiPostEnabled: config.apiPostEnabled === true,
  apiPostAllowedKeyIds: config.apiPostAllowedKeyIds ?? [],
});

const orgIdOf = (req: { query: { id?: string } }): string => (typeof req.query.id === 'string' ? req.query.id : '');

/**
 * Whether the bot can see the channel and is a member, asked of Slack with the workspace's own token,
 * so a channel id from another workspace is refused rather than claimed here.
 */
async function lookUpChannel(botToken: string, channelId: string): Promise<{ found: boolean; botIsMember: boolean }> {
  const client = new WebClient(botToken, { retryConfig: { retries: 0 }, timeout: 10_000 });
  try {
    const result = await client.conversations.info({ channel: channelId });
    return { found: true, botIsMember: result.channel?.is_member === true };
  } catch (error) {
    if ((error as { data?: { error?: string } }).data?.error === 'channel_not_found') {
      return { found: false, botIsMember: false };
    }
    throw error;
  }
}

const handler = baseApi({ auth: 'jwtOnly' })
  .get(
    asyncHandler<{}, unknown, unknown, { id?: string }>(async (req, res) => {
      const org = await verifyOrgOwner(req.user!, orgIdOf(req));
      const workspace = await orgSlackWorkspaceRepository.findByOrganizationId(org.id);
      if (!workspace) throw new NotFoundError('No Slack workspace connected');

      const configs = await slackChannelConfigRepository.findApiPostEnabledBySlackTeamId(workspace.slackTeamId);
      return res.json({ channels: configs.map(toView) });
    })
  )
  .put(
    asyncHandler<{}, unknown, unknown, { id?: string }>(async (req, res) => {
      const org = await verifyOrgOwner(req.user!, orgIdOf(req));
      const update = parseOrBadRequest(UpdateApiPostingSchema, req.body);

      const workspace = await orgSlackWorkspaceRepository.findByOrganizationIdWithToken(org.id);
      if (!workspace) throw new NotFoundError('No Slack workspace connected');

      const audit = (before: ApiPostingView | null) =>
        recordAdminActionFromRequest(req, {
          action: 'org.slack_channel_api_posting.updated',
          actorScope: 'organization',
          target: { kind: 'organization', id: org.id, displayName: org.name },
          summary: `${update.apiPostEnabled ? 'enabled' : 'disabled'} Slack API posting for channel ${update.channelId}`,
          changes: [
            { field: 'apiPostEnabled', before: before?.apiPostEnabled === true, after: update.apiPostEnabled },
            {
              field: 'apiPostAllowedKeyIds',
              before: before?.apiPostAllowedKeyIds ?? [],
              after: update.apiPostEnabled ? (update.apiPostAllowedKeyIds ?? []) : [],
            },
          ],
        });

      // Turning posting off needs no Slack round trip and never creates a record. The answer is the same
      // whether the channel had posting on, had no record, or belongs to another workspace.
      if (!update.apiPostEnabled) {
        const before = await slackChannelConfigRepository.disableApiPostingByChannelId(
          update.channelId,
          workspace.slackTeamId
        );
        if (before) await audit(before);
        return res.json({ channelId: update.channelId, apiPostEnabled: false, apiPostAllowedKeyIds: [] });
      }

      // Turning it on must name a channel of this workspace.
      const botToken = decryptToken(workspace.slackBotToken);
      if (!botToken) throw new ConflictError('The Slack workspace connection has no bot token. Reconnect Slack.');
      const channel = await lookUpChannel(botToken, update.channelId);
      if (!channel.found) {
        throw new NotFoundError(
          'Channel not found in the connected Slack workspace. For a private channel, invite the bot first.'
        );
      }

      const before = await slackChannelConfigRepository.findByChannelId(update.channelId);
      const saved = await slackChannelConfigRepository.setApiPostingByChannelId(update.channelId, {
        slackTeamId: workspace.slackTeamId,
        organizationId: org.id,
        apiPostEnabled: update.apiPostEnabled,
        apiPostAllowedKeyIds: update.apiPostAllowedKeyIds ?? [],
        configuredBy: req.user!.id,
      });
      if (!saved) throw new ConflictError('This channel is configured under a different Slack workspace.');
      await audit(before?.slackTeamId === workspace.slackTeamId ? before : null);

      return res.json({ ...toView(saved), botIsMember: channel.botIsMember });
    })
  );

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
