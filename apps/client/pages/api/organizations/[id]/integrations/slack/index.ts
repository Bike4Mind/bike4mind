/**
 * Organization Slack Workspace Integration API
 *
 * GET /api/organizations/[id]/integrations/slack - Get workspace config
 * DELETE /api/organizations/[id]/integrations/slack - Disconnect workspace
 */

import { asyncHandler } from '@server/middlewares/asyncHandler';
import { baseApi } from '@server/middlewares/baseApi';
import { organizationRepository } from '@bike4mind/database/infra';
import { orgSlackWorkspaceRepository } from '@bike4mind/database/infra';
import { NotFoundError } from '@bike4mind/utils';
import { IOrgSlackWorkspaceDocument, IOrgSlackWorkspaceResponse } from '@bike4mind/common';

/**
 * Verify user is org owner or system admin.
 * Only org owner (not manager) can manage Slack integration.
 */
async function verifyOrgOwnerAccess(user: { id: string; isAdmin: boolean }, orgId: string) {
  if (user.isAdmin) {
    const org = await organizationRepository.findById(orgId);
    if (!org) throw new NotFoundError('Organization not found');
    return org;
  }

  const org = await organizationRepository.findById(orgId);
  if (!org) throw new NotFoundError('Organization not found');

  if (org.userId !== user.id) {
    throw new NotFoundError('Organization not found');
  }

  return org;
}

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

      await verifyOrgOwnerAccess(user, orgId);

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
    asyncHandler<{}, { success: boolean; message: string }, unknown, { id?: string }>(async (req, res) => {
      const orgId = req.query.id!;
      const user = req.user!;

      await verifyOrgOwnerAccess(user, orgId);

      const workspace = await orgSlackWorkspaceRepository.findByOrganizationId(orgId);
      if (!workspace) {
        throw new NotFoundError('No Slack workspace connected');
      }

      await orgSlackWorkspaceRepository.delete(workspace.id);

      return res.status(200).json({
        success: true,
        message: 'Slack workspace disconnected successfully',
      });
    })
  );

export default handler;
