import { sharingService } from '@bike4mind/services';
import {
  inviteRepository,
  organizationRepository,
  sessionRepository,
  projectRepository,
  fabFileRepository,
  userRepository,
  Project,
  Group,
  fileTagRepository,
  withTransaction,
} from '@bike4mind/database';
import { foldTagName, InviteType, ProjectEvents } from '@bike4mind/common';
import { logEvent } from '@bike4mind/server-utils/utils/analyticsLog';
import { sendToClient } from '@bike4mind/server-utils/websocket/utils';
import { payOrgInviteBonus } from '@server/credits/orgInviteBonus';
import type { Request } from 'express';
import { Resource } from 'sst';

// Accept/refuse side effects shared by POST /api/invites/[id]/{accept,refuse} and POST /api/invites/bulk.
type InviteResponder = Pick<Request, 'user' | 'ability' | 'apiKeyInfo' | 'logger'>;

/**
 * Transfers tags from a specific file to the user
 */
const transferFileTagsToUser = async (fileId: string, userId: string) => {
  try {
    const file = await fabFileRepository.findById(fileId);
    if (!file?.tags || file.tags.length === 0) {
      return;
    }

    // Get original tags from the file owner to copy their properties
    const fileOwnerTags = await fileTagRepository.findAllByUserId(file.userId);
    // foldTagName, not a local toLowerCase: these keys decide which owner tag a name copies its
    // icon/colour from, and the repository upsert below folds under the same rule.
    const ownerTagsByName = new Map(fileOwnerTags.map(tag => [foldTagName(tag.name), tag]));

    // Group under the shared collision rule, so two stored casings of one tag copy across as one tag
    // rather than two. findOrCreateByNameAndUserId matches its name exactly, so it cannot dedup them.
    const tagInfo = new Map<string, { originalName: string; ownerTag?: any }>();

    for (const fileTag of file.tags) {
      const foldedName = foldTagName(fileTag.name);
      if (!tagInfo.has(foldedName)) {
        tagInfo.set(foldedName, {
          originalName: fileTag.name,
          ownerTag: ownerTagsByName.get(foldedName),
        });
      }
    }

    // Create/update tags atomically
    for (const { originalName, ownerTag } of Array.from(tagInfo.values())) {
      await fileTagRepository.findOrCreateByNameAndUserId(originalName, userId, {
        icon: ownerTag?.icon || '\u{1F3F7}\uFE0F',
        color: ownerTag?.color || '#0B6BCB',
        description: ownerTag?.description || `Shared tag: ${originalName}`,
      });
    }
  } catch (error) {
    console.warn(`Failed to transfer tags from file ${fileId} to user ${userId}:`, error);
  }
};

export async function acceptInviteForUser(req: InviteResponder, id: string) {
  const user = req.user!;
  // Wrap in a transaction so the invite mutation and the document/user writes it
  // drives (e.g. org membership + user.organizationId in the Organization path) commit
  // atomically. Without it, a failure between the two writes could leave a user in an
  // org with organizationId still null. Mirrors the add-member handler, which already
  // wraps organizationService.addMember.
  const invite = await withTransaction(() =>
    sharingService.acceptInvite(
      user.id,
      { id },
      {
        db: {
          invites: inviteRepository,
          sessions: sessionRepository,
          projects: projectRepository,
          fabFiles: fabFileRepository,
          groups: Group,
          organization: organizationRepository,
          users: userRepository,
        },
      }
    )
  );

  // The bonus is JWT-only; an API-key acceptance can recover later through the eligibility check.
  if (invite.type === InviteType.Organization && !req.apiKeyInfo) {
    try {
      await payOrgInviteBonus(user.id, invite.id);
    } catch (error) {
      req.logger?.error('Organization invite bonus remains unpaid', error);
    }
  }

  if (invite.type === InviteType.Project) {
    const project = await Project.findById(invite.documentId);
    if (project) {
      await logEvent(
        {
          userId: user.id,
          type: ProjectEvents.PROJECT_JOINED,
          metadata: {
            projectId: project.id,
            projectName: project.name,
            memberId: user.id,
          },
        },
        { ability: req.ability }
      );
    }
  }

  if (invite.type === InviteType.FabFile) {
    await transferFileTagsToUser(invite.documentId, user.id);
  }

  return invite;
}

export async function refuseInviteForUser(req: InviteResponder, id: string) {
  // Public-ness (link vs email invite) is derived from invite state in the service;
  // no client-supplied flag is trusted for the recipient check. Revoking the whole
  // invite (rather than just the caller's own slot) needs the share-authority
  // adapters the service checks via authorizeByInviteType.
  return sharingService.refuseWholeInvite(
    req.user!,
    { id },
    {
      db: {
        invites: inviteRepository,
        fabFiles: fabFileRepository,
        sessions: sessionRepository,
        projects: projectRepository,
        organizations: organizationRepository,
        groups: Group,
      },
    }
  );
}

export async function notifyInvitesRefetch(userId: string, status: string) {
  await sendToClient(userId, Resource.websocket.managementEndpoint, { action: 'invites_refetch', status });
}
