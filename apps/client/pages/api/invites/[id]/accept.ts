// Accept an invitation
// POST /api/invites/[id]/accept

import { sharingService } from '@bike4mind/services';
import {
  inviteRepository,
  Organization,
  sessionRepository,
  projectRepository,
  fabFileRepository,
  userRepository,
  Project,
  Group,
  fileTagRepository,
  withTransaction,
} from '@bike4mind/database';
import { baseApi } from '@server/middlewares/baseApi';
import { filterInviteRecipientsToSelf } from '@server/managers/inviteManager';
import { sendToClient } from '@server/websocket/utils';
import { foldTagName, InviteType, ProjectEvents } from '@bike4mind/common';
import { logEvent } from '@server/utils/analyticsLog';
import { Resource } from 'sst';

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
        icon: ownerTag?.icon || '🏷️',
        color: ownerTag?.color || '#0B6BCB',
        description: ownerTag?.description || `Shared tag: ${originalName}`,
      });
    }
  } catch (error) {
    console.warn(`Failed to transfer tags from file ${fileId} to user ${userId}:`, error);
  }
};

const handler = baseApi().post(async (req, res) => {
  const id = req.query.id as string;
  if (!id) {
    return res.status(400).json({ message: 'Invalid accept invite request' });
  }

  // Wrap in a transaction so the invite mutation and the document/user writes it
  // drives (e.g. org membership + user.organizationId in the Organization path) commit
  // atomically. Without it, a failure between the two writes could leave a user in an
  // org with organizationId still null. Mirrors the add-member handler, which already
  // wraps organizationService.addMember.
  const invite = await withTransaction(() =>
    sharingService.acceptInvite(
      req.user.id,
      {
        id,
      },
      {
        db: {
          invites: inviteRepository,
          sessions: sessionRepository,
          projects: projectRepository,
          fabFiles: fabFileRepository,
          groups: Group,
          organization: Organization,
          users: userRepository,
        },
      }
    )
  );

  // Log PROJECT_JOINED event for project invites
  if (invite.type === InviteType.Project) {
    const project = await Project.findById(invite.documentId);
    if (project) {
      await logEvent(
        {
          userId: req.user.id,
          type: ProjectEvents.PROJECT_JOINED,
          metadata: {
            projectId: project.id,
            projectName: project.name,
            memberId: req.user.id,
          },
        },
        { ability: req.ability }
      );
    }
  }

  // Handle file tag transfer after successful invite acceptance
  if (invite.type === InviteType.FabFile) {
    await transferFileTagsToUser(invite.documentId, req.user.id);
  }

  // trigger refetch on inbox
  const wsEndpoint = Resource.websocket.managementEndpoint;
  await sendToClient(req.user.id, wsEndpoint, {
    action: 'invites_refetch',
    status: 'Accepted invite',
  });

  // Invitee-facing: strip co-recipients' emails from the returned invite.
  return res.json(filterInviteRecipientsToSelf(invite, req.user.email));
});

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
