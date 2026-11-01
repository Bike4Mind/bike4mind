/**
 * Organization Slack Workspace Integration API
 *
 * GET /api/organizations/[id]/integrations/slack - Get workspace config
 * DELETE /api/organizations/[id]/integrations/slack - Disconnect workspace
 */

import { asyncHandler } from '@server/middlewares/asyncHandler';
import { baseApi } from '@server/middlewares/baseApi';
import {
  organizationRepository,
  orgSlackWorkspaceRepository,
  slackChannelConfigRepository,
} from '@bike4mind/database/infra';
import { NotFoundError } from '@bike4mind/utils';
import { IOrgSlackWorkspaceDocument, IOrgSlackWorkspaceResponse } from '@bike4mind/common';
import { verifyOrgOwner } from '@bike4mind/server-utils/utils/orgAccess';
import { recordAdminActionFromRequest } from '@server/utils/adminAudit';

function toResponse(
  doc: IOrgSlackWorkspaceDocument & { createdAt: Date; updatedAt: Date }
): IOrgSlackWorkspaceResponse {
  return {
    id: doc.id,
    organizationId: doc.organizationId,
    slackTeamId: doc.slackTeamId,
    slackTeamName: doc.slackTeamName,
    slackAppId: doc.slackAppId,
    slackBotUserId: doc.slackBotUserId,
    enabled: doc.enabled,
    installedAt: doc.installedAt,
    installedBy: doc.installedBy,
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
  };
}

const handler = baseApi()
  .get(
    asyncHandler<{}, IOrgSlackWorkspaceResponse | { error: string }, unknown, { id?: string }>(async (req, res) => {
      const orgId = req.query.id!;
      const user = req.user!;

      await verifyOrgOwner(user, orgId);

      const workspace = await orgSlackWorkspaceRepository.findByOrganizationId(orgId);
      if (!workspace) {
        return res.status(404).json({ error: 'No Slack workspace connected' });
      }

      return res
        .status(200)
        .json(toResponse(workspace as IOrgSlackWorkspaceDocument & { createdAt: Date; updatedAt: Date }));
    })
  )
  .delete(
    asyncHandler<{}, unknown, unknown, { id?: string }>(async (req, res) => {
      const orgId = req.query.id!;
      const user = req.user!;

      await verifyOrgOwner(user, orgId);

      const workspace = await orgSlackWorkspaceRepository.findByOrganizationId(orgId);
      if (!workspace) {
        throw new NotFoundError('No Slack workspace connected');
      }

      // API posting opt-ins belong to this connection; they end with it, before the workspace goes.
      const clearedChannelIds = await slackChannelConfigRepository.clearApiPostingBySlackTeamId(workspace.slackTeamId);
      if (clearedChannelIds.length > 0) {
        const org = await organizationRepository.findById(orgId);
        await recordAdminActionFromRequest(req, {
          action: 'org.slack_channel_api_posting.updated',
          actorScope: 'organization',
          target: { kind: 'organization', id: orgId, displayName: org?.name ?? orgId },
          summary: `disabled Slack API posting for ${clearedChannelIds.length} channel(s) on workspace disconnect`,
          changes: [{ field: 'apiPostEnabled', before: true, after: false }],
          details: { slackTeamId: workspace.slackTeamId, channelIds: clearedChannelIds },
        });
      }

      await orgSlackWorkspaceRepository.delete(workspace.id);

      return res.status(200).json({
        success: true,
        message: 'Slack workspace disconnected successfully',
      });
    })
  );

export default handler;
