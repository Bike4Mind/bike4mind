import {
  activityRepository,
  fabFileRepository,
  Group,
  inviteRepository,
  organizationRepository,
  Project,
  projectRepository,
  sessionRepository,
  userRepository,
  withTransaction,
} from '@bike4mind/database';
import type { IUserDocument, Permission } from '@bike4mind/common';
import { InviteEvents, InviteType, ProjectEvents } from '@bike4mind/common';
import { projectService, sharingService } from '@bike4mind/services';
import { ActivityType } from '@bike4mind/server-utils/config/activityType';
import { logEvent } from '@bike4mind/server-utils/utils/analyticsLog';
import { NotFoundError } from '@bike4mind/server-utils/utils/errors';
import { isValidObjectId } from '@bike4mind/server-utils/utils/objectId';
import { generateInviteLink } from '@server/managers/createDocumentInvite';
import { toSharerInviteViews } from '@server/managers/inviteManager';
import { cleanUpRevokedFileReferences, projectRevokeCleanupTargets } from '@server/sharing/revokedFileReferences';
import { getInviteTypeName } from '@server/utils/mailer/inviteNotificationEmail';
import { notifyInvitees, reserveInviteSendBudget } from '@server/utils/inviteSendLimits';
import type { ProjectMutationContext } from './attachSessionsToProject';

/**
 * The member, invite and system-prompt writes behind /api/projects/[id]/(members|invites|systemPrompts)
 * and their /api/v1/projects twins. Each runs the service write in a transaction, then emits the same
 * analytics events and side effects, so the two surfaces cannot drift.
 */

type Ctx = ProjectMutationContext & { user: IUserDocument };

/** Removes `memberId` as the owner, or leaves the project when it is omitted. */
export async function removeProjectMember(
  ctx: Ctx & { logger: NonNullable<Ctx['logger']> },
  projectId: string,
  memberId?: string
) {
  const { user, ability, logger } = ctx;

  // Read before the leave: its cascade prunes the project's file list.
  const cleanUpTargets = await projectRevokeCleanupTargets(projectId, memberId || user.id, logger);

  const project = await withTransaction(async () => {
    const left = await projectService.leaveProject(
      user,
      { id: projectId, userIdToRemove: memberId },
      {
        db: {
          projects: projectRepository,
          sessions: sessionRepository,
          fabFiles: fabFileRepository,
          users: userRepository,
        },
      }
    );

    if (memberId) {
      await logEvent(
        {
          userId: user.id,
          type: ProjectEvents.REMOVE_MEMBER,
          metadata: { projectId, projectName: left.name, memberId },
        },
        { ability }
      );
    } else {
      await logEvent(
        {
          userId: user.id,
          type: ProjectEvents.PROJECT_LEAVED,
          metadata: { projectId, projectName: left.name, memberId: user.id },
        },
        { ability }
      );
      await activityRepository.createActivity(
        ActivityType.PROJECT_LEAVED,
        { type: 'Project', id: projectId },
        { type: 'User', id: user.id }
      );
    }

    return left;
  });

  // After the commit, outside its session (see cleanUpDeletedFileReferences).
  await cleanUpRevokedFileReferences(cleanUpTargets, logger);

  return project;
}

const systemPromptAdapters = { db: { fabFiles: fabFileRepository, projects: projectRepository } };

export async function addProjectSystemPrompts(ctx: Ctx, projectId: string, fileIds: string[]) {
  const project = await withTransaction(() =>
    projectService.addSystemPrompts(ctx.user, { projectId, fileIds }, systemPromptAdapters)
  );

  await Promise.all(
    fileIds.map(fileId =>
      logEvent(
        {
          userId: ctx.user.id,
          type: ProjectEvents.ADD_SYSTEM_PROMPT,
          metadata: { projectId: project.id, projectName: project.name, promptId: fileId },
        },
        { ability: ctx.ability }
      )
    )
  );

  return project;
}

export async function removeProjectSystemPrompts(ctx: Ctx, projectId: string, fileIds: string[]) {
  const project = await withTransaction(() =>
    projectService.removeSystemPrompts(ctx.user, { projectId, fileIds }, systemPromptAdapters)
  );

  await Promise.all(
    fileIds.map(promptId =>
      logEvent(
        {
          userId: ctx.user.id,
          type: ProjectEvents.REMOVE_SYSTEM_PROMPT,
          metadata: { projectId: project.id, projectName: project.name, promptId },
        },
        { ability: ctx.ability }
      )
    )
  );

  return project;
}

/** Flips the prompt when `enabled` is omitted (the SPA toggle), otherwise sets it. */
export async function setProjectSystemPrompt(ctx: Ctx, projectId: string, fileId: string, enabled?: boolean) {
  return withTransaction(() =>
    projectService.toggleSystemPrompt(ctx.user, { projectId, fileId, enabled }, systemPromptAdapters)
  );
}

export interface CreateProjectInviteInput {
  permissions: Permission[];
  recipients?: string[];
  description?: string;
  expiresAt?: Date;
  available?: number;
}

/**
 * Creates a project invite and notifies its recipients. Returns the sharer view of the invite (see
 * toSharerInviteViews) and its share link. The caller gates outbound actions first.
 */
export async function createProjectInvite(ctx: Ctx, projectId: string, input: CreateProjectInviteInput) {
  const { user, ability, logger } = ctx;
  // An id that is not an ObjectId names no project, so answer the 404 here rather than letting the
  // lookup cast and raise a CastError.
  if (!isValidObjectId(projectId)) throw new NotFoundError('Project not found');

  const { expiresAt, ...rest } = input;
  const budget = await reserveInviteSendBudget(user.id, rest.recipients, { chargeTypedAddresses: true });
  const created = await withTransaction(() =>
    sharingService.createInvite(
      user,
      // id and type come last so path params are always authoritative over any body field.
      { ...rest, ...(expiresAt !== undefined && { expiresAt }), id: projectId, type: InviteType.Project },
      {
        db: {
          invites: inviteRepository,
          users: userRepository,
          fabFiles: fabFileRepository,
          sessions: sessionRepository,
          projects: projectRepository,
          organizations: organizationRepository,
          groups: Group,
        },
      }
    )
  ).catch(async (error: unknown) => {
    await budget.release();
    throw error;
  });

  await logEvent(
    {
      userId: user.id,
      type: InviteEvents.CREATE_INVITE,
      metadata: { id: created.id, totalInvites: created.recipients?.pending?.length ?? 0 },
    },
    { ability }
  );

  const project = await Project.findById(projectId);
  const pendingRecipients = created.recipients?.pending || [];
  if (project) {
    await Promise.all(
      pendingRecipients.map((recipientId: string) =>
        logEvent(
          {
            userId: user.id,
            type: ProjectEvents.ADD_MEMBER,
            metadata: {
              projectId,
              projectName: project.name,
              memberId: recipientId,
              memberRole: (rest.permissions || []).join(','),
            },
          },
          { ability }
        )
      )
    );
  }

  const link = generateInviteLink(created);

  // Same notification the generic invite route sends; without it an invitee only learns of the
  // invite from the in-app inbox. Not awaited, so a mail failure never fails the invite.
  if (pendingRecipients.length > 0) {
    const brand = process.env.APP_NAME || '';
    notifyInvitees({
      recipients: pendingRecipients,
      sharerName: user.name || user.username || `A${brand ? ` ${brand}` : ''} user`,
      sharerEmail: user.email || '',
      documentName: project?.name || 'a project',
      typeName: getInviteTypeName(InviteType.Project),
      inviteLink: link,
      message: rest.description,
    }).catch(error => {
      logger?.error('Failed to send invite notification emails', { error, inviteId: created.id });
    });
  }

  const [view] = await toSharerInviteViews([created], user);
  return { view, link };
}
