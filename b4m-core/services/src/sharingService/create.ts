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
  ShareableAccessShape,
  grantablePermissions,
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
  // No prefault here: the default depends on recipients.length (below), which this schema
  // cannot see. No caller currently sets this explicitly.
  available: z.number().optional(),
});

interface CreateInviteAdapters {
  db: {
    // TODO: Use Invite model create type def
    invites: IInviteRepository;
    users: Pick<IUserRepository, 'findAllByEmailsOrUsernames' | 'findById' | 'findByIds'>;
    // add findShareAccessById to fabFiles
    fabFiles: Pick<IFabFileRepository, 'findByIdAndUserId' | 'shareable'>;
    sessions: Pick<ISessionRepository, 'findByIdAndUserId'>;
    projects: Pick<IProjectRepository, 'shareable'>;
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
  // Accept the schema INPUT type: secureParameters re-parses and applies .prefault() internally,
  // so the caller need not supply expiresAt (the output type would require it as Date).
  parameters: z.input<typeof createInviteSchema>,
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
      // Scoped to the caller's share access (owner, users[].share, or groups[].share), matching
      // the FabFile arm above. A caller with no share access gets the same generic "Document not
      // found" as a nonexistent project, since findShareAccessById returns null for both.
      doc = await db.projects.shareable.findShareAccessById(user, id);
      name = doc?.name;
      break;
    default:
      break;
  }
  if (!doc) throw new BadRequestError('Document not found');
  if (!name) throw new NotFoundError('no name');

  // An invite must never carry a permission its minter does not hold, or a sharee with `share`
  // could mint themselves `update`/`delete` and redeem the link. Scoped to the three shareable
  // types: Organization and Group invites are membership grants gated by their own authority
  // checks above, and their `users[]` means seats, not permission entries. The owner holds
  // everything, so this is a no-op on the common path.
  if (type === InviteType.FabFile || type === InviteType.Session || type === InviteType.Project) {
    const held = grantablePermissions(doc as ShareableAccessShape, user.id, user.groups ?? []);
    const overreach = rest.permissions.filter(permission => !held.has(permission));
    if (overreach.length) {
      throw new BadRequestError(`Cannot grant permissions you do not hold: ${overreach.join(', ')}`);
    }
  }

  const recipientsArray = recipients ?? [];
  const users = await db.users.findAllByEmailsOrUsernames(recipientsArray, recipientsArray);
  const isLinkOnlyInvite = recipients?.length === 0;
  // Persisted so the view and accept gates can tell "names nobody by design" from "named somebody
  // who did not resolve". `recipients` omitted entirely names nobody just as `[]` does, which is
  // why this is not simply isLinkOnlyInvite (that one sizes `available` and is left as it was).
  const namesNobody = recipientsArray.length === 0;

  // By-Users sharing (FabFile/Session) sends real emails/usernames and must not silently
  // create a share nobody can see. Organization/Project invites send raw user ids through
  // this same recipients array (Organization resolves them separately via inviteToOrg
  // above); Group invites do not use recipients at all (membership authority is checked via
  // assertCanManageOrgGroups above, and the join itself happens on accept - see accept.ts).
  // None of that is this check's concern, so it stays scoped to FabFile/Session only.
  let pending: string[];
  if ((type === InviteType.FabFile || type === InviteType.Session) && recipientsArray.length > 0) {
    // Per-recipient, not a shared matched-set: (1) a username match with no email is not
    // actually shareable (accept.ts's recipients.pending/accepted are keyed on email, and
    // acceptInvite rejects an emailless accepter outright), so it must count as unresolved
    // rather than silently vanishing from `pending`; (2) findAllByEmailsOrUsernames is now
    // case-insensitive, and this schema's uniqueness is case-SENSITIVE (username_1, email_1),
    // so two real accounts differing only by case can both match one input string - that must
    // fail loudly, not silently grant access to whichever one happened to match.
    const resolvable = users.filter((u): u is IUserDocument & { email: string } => Boolean(u.email));
    const resolved = recipientsArray.map(recipient => {
      const lower = recipient.toLowerCase();
      // A string containing '@' is an email address and resolves against the email field only.
      // Usernames are self-set and unvalidated, so matching them against an email-shaped input
      // lets someone claim another person's address and receive shares meant for them.
      const matches = resolvable.filter(u =>
        recipient.includes('@') ? u.email.toLowerCase() === lower : u.username.toLowerCase() === lower
      );
      if (matches.length === 0) throw new BadRequestError(`Could not find a user for: ${recipient}`);
      if (matches.length > 1) throw new BadRequestError(`More than one user matches: ${recipient}`);
      return matches[0].email;
    });
    // Dedupe: two recipient strings (an email and that same person's username) can resolve to
    // the same one user, and pending.length below counts unique resolved users, not raw entries.
    pending = Array.from(new Set(resolved));
  } else if ((type === InviteType.Project || type === InviteType.Organization) && recipientsArray.length > 0) {
    // Project and Organization invites carry raw user ids (the add-members modals send
    // `recipients: [userId]`), which findAllByEmailsOrUsernames cannot resolve - it queries email
    // and username only, never _id. Left unresolved, `pending` stayed empty and every gate keyed
    // on it fell open: the invite read as "names nobody", so any authenticated holder of the id
    // could view it and accept it. Emails/usernames are accepted here too so a caller that sends
    // those instead of ids keeps working.
    const byId = await db.users.findByIds(recipientsArray);
    pending = Array.from(
      new Set([...users, ...byId].map(u => u.email).filter((email): email is string => Boolean(email)))
    );
    // An invite naming only unresolvable recipients can never be viewed or accepted by anyone now
    // that those gates key on `pending`, so fail loudly at mint time instead of persisting a row
    // that silently does nothing.
    if (pending.length === 0) throw new BadRequestError('Could not find a user for any recipient');
  } else {
    pending = users.map(user => user.email).filter((email): email is string => Boolean(email));
  }

  // No caller sets `available` explicitly today. Defaulting it to a flat 1 regardless of
  // recipient count meant a multi-recipient By-Users share minted one invite whose single
  // accept slot only the first recipient could ever claim, while the sharer was told all of
  // them succeeded - so the default has to track how many people this invite is actually for.
  // pending.length (not recipientsArray.length): two recipient strings that resolve to the
  // same person, or an org/project id that resolves to nobody, must not inflate the count.
  const resolvedAvailable = available ?? (isLinkOnlyInvite ? 1000 : Math.max(pending.length, DEFAULT_AVAILABLE));

  const build: Omit<IInvite, 'id'> = {
    // We suggest that it's a FabFile so that permissions is a valid/required field
    type: type as InviteType,
    documentId: id,
    remaining: resolvedAvailable,
    ...rest,
    recipients: {
      pending,
      accepted: [],
      refused: [],
    },
    accepted: 0,
    isLinkOnly: namesNobody,
    name,
    // username of the user who is sharing instead of owner of the file
    username: user.username,
    // Who minted the invite -- accept.ts's Session arm caps propagated file grants to
    // what this user actually holds, so an attached file the inviter cannot share
    // does not silently inherit the invite's permissions.
    inviterId: user.id,
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
