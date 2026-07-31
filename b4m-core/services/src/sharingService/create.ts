import {
  IFabFileDocument,
  IFabFileRepository,
  IGroupDocument,
  IInvite,
  IInviteRepository,
  InviteType,
  IOrganizationDocument,
  IOrganizationRepository,
  IProjectDocument,
  IProjectRepository,
  ISessionDocument,
  ISessionRepository,
  IUserDocument,
  IUserRepository,
  Permission,
} from '@bike4mind/common';
import { BadRequestError, NotFoundError, secureParameters } from '@bike4mind/utils';
import { z } from 'zod';
import { assertCanManageOrgGroups } from '../organizationService/groupMembership';

const defaultExpiration = () => new Date(new Date().getFullYear() + 100, new Date().getMonth(), new Date().getDate());
export const DEFAULT_AVAILABLE = 1;

const createInviteSchema = z.object({
  id: z.string(),
  type: z.enum(InviteType),
  permissions: z.array(z.enum(Permission)),
  recipients: z.string().array().optional(),
  description: z.string().optional(),
  expiresAt: z.date().optional().prefault(defaultExpiration()),
  available: z.number().optional().prefault(DEFAULT_AVAILABLE),
});

type CreateInviteParameters = z.infer<typeof createInviteSchema>;

interface CreateInviteAdapters {
  db: {
    // TODO: Use Invite model create type def
    invites: IInviteRepository;
    users: Pick<IUserRepository, 'findAllByEmailsOrUsernames' | 'findById'>;
    // add findShareAccessById to fabFiles
    fabFiles: Pick<IFabFileRepository, 'findByIdAndUserId' | 'shareable'>;
    sessions: Pick<ISessionRepository, 'findByIdAndUserId'>;
    projects: Pick<IProjectRepository, 'findById'>;
    // TODO: Use Organization model create type def
    organizations: IOrganizationRepository;
    // TODO: Use Group model create type def
    groups: {
      findById: (id: string) => Promise<IGroupDocument | null>;
    };
  };
}

export const createInvite = async (
  user: IUserDocument,
  parameters: CreateInviteParameters,
  { db }: CreateInviteAdapters
) => {
  const { id, type, available, recipients, ...rest } = secureParameters(parameters, createInviteSchema);

  // When no expiration date is given, default to 100 years from now.

  // May throw if a field is missing:

  let doc: IFabFileDocument | ISessionDocument | IOrganizationDocument | IGroupDocument | IProjectDocument | null =
    null;
  let name: string | undefined = '';

  switch (type) {
    case InviteType.FabFile:
      doc = await db.fabFiles.shareable.findShareAccessById(user, id);
      name = (doc as IFabFileDocument)?.fileName;
      break;
    case InviteType.Session:
      doc = await db.sessions.findByIdAndUserId(id, user.id);
      name = doc?.name;
      break;
    case InviteType.Organization:
      doc = await inviteToOrg(user, { id, recipients }, db);

      name = doc?.name;
      break;
    case InviteType.Group: {
      if (!rest.permissions) throw new BadRequestError('Invalid invite group request');
      const group = await db.groups.findById(id);
      if (!group) throw new BadRequestError('Document not found');
      // A group with no organizationId (pre-org-groups data) fails closed, matching the
      // authorizeByInviteType arm.
      const organization = group.organizationId ? await db.organizations.findById(group.organizationId) : null;
      if (!organization) throw new BadRequestError('Document not found');
      // Minting a group invite is a grant of group membership, so it takes the same authority as
      // the members route (organizationService/groupMembership.ts assertCanManageOrgGroups), and
      // is asserted before `name` is read so the group's name never reaches a caller without it.
      // Callers with no role in the organization collapse to the same generic error as a missing
      // group: a 403 must not confirm that a group id exists to someone who cannot already see it.
      // Mirrors authorizeAndValidate, which returns 'Group not found' for a wrong-org group for
      // exactly this reason. A member who merely lacks group-management authority still gets 403.
      // See sharingService/accept.ts for the redemption path.
      const isInOrganization =
        user.isAdmin ||
        organization.userId === user.id ||
        (organization.users ?? []).some(member => member.userId === user.id);
      if (!isInOrganization) throw new BadRequestError('Document not found');
      assertCanManageOrgGroups(user, organization);
      doc = group;
      name = group.name;
      break;
    }
    case InviteType.Project:
      if (!rest.permissions.length) throw new BadRequestError('Invalid invite group request');
      doc = await db.projects.findById(id);
      name = doc?.name;
      break;
    default:
      break;
  }
  if (!doc) throw new BadRequestError('Document not found');
  if (!name) throw new NotFoundError('no name');

  const recipientsArray = recipients ?? [];
  const users = await db.users.findAllByEmailsOrUsernames(recipientsArray, recipientsArray);
  // we push emails on pending regardless if username was sought for
  const pending = users.map(user => user.email as string);
  const isLinkOnlyInvite = recipients?.length === 0;

  const build: Omit<IInvite, 'id'> = {
    // We suggest that it's a FabFile so that permissions is a valid/required field
    type: type as InviteType,
    documentId: id,
    remaining: isLinkOnlyInvite ? 1000 : available,
    ...rest,
    recipients: {
      pending,
      accepted: [],
      refused: [],
    },
    accepted: 0,
    name,
    // username of the user who is sharing instead of owner of the file
    username: user.username,
  };

  const invite = await db.invites.create(build);

  return invite;
};

const inviteToOrg = async (
  user: IUserDocument,
  params: { id: string; recipients?: string[] },
  db: CreateInviteAdapters['db']
) => {
  if (!params.recipients) throw new BadRequestError('Invalid invite organization request');

  const organization = user.isAdmin
    ? await db.organizations.findById(params.id)
    : await db.organizations.shareable.findShareAccessById(user, params.id);

  if (!organization) throw new BadRequestError('Organization not found');

  // We add 1 to include the owner of the organization
  const totalUsers = (organization.users.length ?? 0) + 1;

  if (totalUsers + params.recipients.length > organization.seats) {
    throw new BadRequestError('Organization is full');
  }

  const invites = await db.invites.findAllByDocumentId(organization.id);
  const pending = invites?.map(invite => invite.recipients?.pending || []).flat().length;

  if (totalUsers + pending + params.recipients.length > organization.seats) {
    throw new BadRequestError('Organization is full');
  }

  return organization;
};
