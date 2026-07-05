import { accessibleBy } from '@casl/mongoose';
import {
  IGroupDocument,
  IInviteDocument,
  InvitePermission,
  InviteType,
  IShareableDocument,
  IUserDocument,
  Permission,
  isImageServeable,
} from '@bike4mind/common';
import { Ability } from '@server/auth/ability';
import { BadRequestError, UnauthorizedError } from '@server/utils/errors';
import { mongoose, inviteRepository } from '@bike4mind/database';

// NOTE: The remaining functions here are intentionally NOT consolidated into
// @bike4mind/services `sharingService`. They authorize via CASL (`Ability` /
// `accessibleBy`), which is app-level and cannot live in the core package, and
// their semantics differ from the service equivalents (e.g. cancel-by-invite-id
// vs cancel-all-for-document, refuse-whole-invite vs refuse-own-slot,
// share-permission-scoped listing vs inviter-scoped listing). Migrating them
// would change authorization behavior, so they stay here. Invite creation has
// already moved to `sharingService.createInvite`.

// Find all invites for a FabFile, ToolModel, SessionModel, or Group.
// Requires sharing permission.
export const getInvitesForDocument = (
  type: InviteType,
  document: IShareableDocument,
  ability: Ability,
  filter: mongoose.FilterQuery<mongoose.InferSchemaType<IInviteDocument>> = {}
) => {
  if (!ability.can(Permission.share, document)) {
    throw new BadRequestError('Unauthorized');
  }

  const query: mongoose.FilterQuery<mongoose.InferSchemaType<IInviteDocument>> = {
    ...filter,
    type,
    documentId: document.id,
  };

  return inviteRepository.find(query);
};

// Find all pending, visible invites within a user's ability, given 'accept' permission
export const getPendingInvitesForUser = async (
  ability: Ability,
  filter?: mongoose.FilterQuery<mongoose.InferSchemaType<IInviteDocument>>
) => {
  const scope = accessibleBy(ability, InvitePermission.acceptOrRefuse) as unknown as Record<string, unknown>;
  return inviteRepository.find({
    ...filter,
    ...scope,
  });
};

export const refuseInvite = async (id: string, user: IUserDocument, ability: Ability, isPublic: boolean = false) => {
  const invite = await inviteRepository.findById(id);
  if (!invite) {
    throw new BadRequestError('Invite not found');
  }

  const scope = accessibleBy(ability, InvitePermission.acceptOrRefuse) as unknown as Record<string, unknown>;
  if (isPublic) {
    delete scope['$or'];
  }

  invite.remaining = 0;
  if (invite.recipients) {
    invite.recipients.pending = [];
    invite.recipients.refused = user.email ? [user.email] : [];
  }

  await inviteRepository.update(invite);

  return inviteRepository.findById(invite.id);
};

export const cancelInvite = async (
  shareDocument: IGroupDocument | IShareableDocument,
  inviteId: string,
  ability: Ability
) => {
  // Canceling is a little expensive because we have to load the Document
  // in order to determine `share` permissions.
  if (!shareDocument || !ability.can(Permission.share, shareDocument)) {
    throw new UnauthorizedError('Unauthorized');
  }

  const invite = await inviteRepository.findById(inviteId);
  if (!invite) {
    throw new BadRequestError('Invite not found');
  }

  invite.remaining = 0;
  if (invite.recipients) {
    invite.recipients.pending = [];
  }

  await inviteRepository.update(invite);

  return inviteRepository.findById(inviteId);
};

export const updateSharing = async <T>(
  model: mongoose.Model<T>,
  _id: string,
  sharingData: Partial<IShareableDocument>,
  ability: Ability
) => {
  if (!ability.can(Permission.share, model)) {
    throw new BadRequestError('Unauthorized');
  }

  const filter = {
    _id,
    // @ts-ignore
    ...accessibleBy(ability, Permission.update)[model],
  };

  const updated = await model.findOneAndUpdate(filter, { ...sharingData }, { new: true });

  // This manager is generic across shareable model types (FabFile, Session, etc).
  // Only FabFile carries a cached signed `fileUrl`/moderationStatus, so only gate
  // that case: a held/blocked uploaded image must not hand out its URL via the sharing
  // response. Non-FabFile docs (no moderationStatus/fileUrl) are returned unchanged.
  if (updated && model.modelName === 'FabFile') {
    const doc = updated as unknown as {
      mimeType?: string | null;
      moderationStatus?: string | null;
      fileUrl?: unknown;
      fileUrlExpireAt?: unknown;
    };
    if (!isImageServeable(doc)) {
      doc.fileUrl = undefined;
      doc.fileUrlExpireAt = undefined;
    }
  }

  return updated;
};
