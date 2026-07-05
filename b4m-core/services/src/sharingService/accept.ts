import {
  IFabFileRepository,
  IInvite,
  IInviteRepository,
  InviteType,
  IOrganizationDocument,
  IProjectRepository,
  ISessionRepository,
  IShareableDocument,
  IUserDocument,
  Permission,
} from '@bike4mind/common';
import { ForbiddenError, NotFoundError, secureParameters, UnprocessableEntityError } from '@bike4mind/utils';
import { z } from 'zod';

const acceptInviteSchema = z.object({
  id: z.string(),
});

type AcceptInviteParameters = z.infer<typeof acceptInviteSchema>;

interface AcceptInviteAdapters {
  db: {
    invites: IInviteRepository;
    sessions: ISessionRepository;
    projects: IProjectRepository;
    fabFiles: IFabFileRepository;
    organization: {
      findById: (id: string) => Promise<IOrganizationDocument | null>;
      update: (data: IOrganizationDocument) => Promise<unknown>;
    };
    users: {
      findById: (id: string) => Promise<IUserDocument | null>;
      update: (data: IUserDocument) => Promise<unknown>;
    };
  };
}

/**
 * Accepts an invite from a user.
 *
 * @param userId - The ID of the user accepting the invite.
 * @param params - The parameters for the accept invite operation.
 * @param adapters - The adapters for the database operations.
 * @returns The invite after accepting.
 */
export const acceptInvite = async (userId: string, params: AcceptInviteParameters, { db }: AcceptInviteAdapters) => {
  const { id } = secureParameters(params, acceptInviteSchema);

  const user = await db.users.findById(userId);
  if (!user) throw new NotFoundError('User not found');
  if (!user.email) throw new UnprocessableEntityError('User has no email');

  const invite = await db.invites.findById(id);
  if (!invite) throw new NotFoundError('Invite not found');

  if (invite.remaining <= 0) {
    throw new UnprocessableEntityError('Invite has no remaining users');
  }

  if ((invite.recipients?.accepted || []).includes(user.email)) {
    throw new UnprocessableEntityError('User has already accepted the invite');
  }

  if (invite.recipients) {
    invite.recipients.pending = invite.recipients.pending?.filter(p => p !== user.email);
    invite.recipients.refused = invite.recipients.refused?.filter(p => p !== user.email);
    invite.recipients.accepted.push(user.email);
  }

  invite.accepted += 1;
  invite.remaining -= 1;

  await db.invites.update(invite);

  // Assumes the invite carries permissions.
  const inviteWithPermissions = invite as IInvite & { permissions: Permission[] };

  const update = { userId, permissions: inviteWithPermissions.permissions };

  switch (invite.type) {
    case InviteType.Group:
      user.groups ||= [];
      user.groups.push(invite.documentId);
      await db.users.update(user);
      break;
    case InviteType.Session: {
      const session = await db.sessions.findById(invite.documentId);
      if (!session) throw new NotFoundError('Session not found');

      // If session has files, share these as well
      if (session.knowledgeIds && session.knowledgeIds.length > 0) {
        await Promise.all(
          session.knowledgeIds.map(async knowledgeId => {
            const fabfile = await db.fabFiles.findById(knowledgeId);
            if (fabfile) {
              pushShareable(fabfile, update);
              await db.fabFiles.update(fabfile);
            }
          })
        );
      }
      pushShareable(session, update);
      await db.sessions.update(session);
      break;
    }
    case InviteType.FabFile: {
      const fabfile = await db.fabFiles.findById(invite.documentId);
      if (!fabfile) {
        throw new NotFoundError('Fabfile not found');
      }

      pushShareable(fabfile, update);
      await db.fabFiles.update(fabfile);
      break;
    }
    case InviteType.Organization:
      await acceptOrganization(
        user,
        {
          organizationId: invite.documentId,
          permissions: inviteWithPermissions.permissions,
        },
        { db }
      );
      break;
    case InviteType.Project:
      await acceptProject(
        user,
        { projectId: invite.documentId, permissions: inviteWithPermissions.permissions },
        { db }
      );

      break;
    default:
      throw new Error('Invalid invite type');
  }

  return invite;
};

interface AcceptOrganizationParameters {
  organizationId: string;
  permissions: Permission[];
}

const acceptOrganization = async (
  user: IUserDocument,
  params: AcceptOrganizationParameters,
  { db }: AcceptInviteAdapters
) => {
  const { organizationId, permissions } = params;
  const organization = await db.organization.findById(organizationId);

  if (!organization) {
    throw new NotFoundError('Organization not found');
  }

  const totalUsers = (organization.users.length ?? 0) + 1; // We add 1 to include the owner of the organization
  if (totalUsers >= organization.seats) {
    throw new ForbiddenError('Organization is full');
  }

  pushShareable(organization, { userId: user.id, permissions });
  organization.userDetails ||= [];

  organization.userDetails.push({
    id: user.id,
    email: user.email ?? user.username,
    name: user.name,
    usedCredits: 0,
    lastCreditUsedAt: null,
  });

  await db.organization.update(organization);

  // Establish full membership on the user document. Without this, the accepting
  // user's `organizationId` stays null and every org-scoped feature that reads
  // `user.organizationId` (e.g. data-lake AccessContext) treats them as org-less.
  // Mirrors the InviteType.Group path above and organizationManager.addUserToOrganization,
  // which set the selected organization as a required side effect of joining.
  user.organizationId = organizationId;
  await db.users.update(user);
};

interface AcceptProjectParameters {
  projectId: string;
  permissions: Permission[];
}

const acceptProject = async (
  user: IUserDocument,
  parameters: AcceptProjectParameters,
  adapters: AcceptInviteAdapters
) => {
  const { projectId, permissions } = parameters;
  const { db } = adapters;

  const project = await db.projects.findById(projectId);

  if (!project) {
    throw new NotFoundError('Project not found');
  }

  pushShareable(project, { userId: user.id, permissions });

  await db.projects.update(project);

  const files = await db.fabFiles.findAllByIds([
    ...project.fileIds,
    ...project.systemPrompts.map(prompt => prompt.fileId),
  ]);
  const sessions = await db.sessions.findAllByIds(project.sessionIds);

  for (const file of files) {
    pushShareable(file, { userId: user.id, permissions, projectId });
    await db.fabFiles.update(file);
  }
  for (const session of sessions) {
    pushShareable(session, { userId: user.id, permissions, projectId });
    await db.sessions.update(session);
  }
};

export const pushShareable = (
  entity: IShareableDocument,
  data: { userId: string; permissions: Permission[]; projectId?: string }
) => {
  entity.users ||= [];
  const userIndex = entity.users.findIndex(user => user.userId === data.userId);
  if (userIndex === -1) {
    entity.users.push({ userId: data.userId, permissions: data.permissions, projectId: data.projectId });
  } else {
    entity.users[userIndex] = data;
  }
};
