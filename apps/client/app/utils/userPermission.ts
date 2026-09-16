import { IShareableDocument, IUserDocument, Permission } from '@bike4mind/common';
import { type Types } from 'mongoose';

export type ShareableDocWithUserId = Omit<IShareableDocument, 'id'> & {
  userId: string | Types.ObjectId | undefined;
  id?: string;
};

// A user can hold more than one users[] entry on the same document: pushShareable keys entries by
// (userId, projectId), so a direct share and each project that materialized access are separate
// rows. Any single entry carrying the permission grants it, which is the same union semantics the
// server-side $elemMatch predicates and heldPermissions apply.
const holdsPermission = (doc: ShareableDocWithUserId, userId: string, permission: Permission): boolean =>
  (doc.users ?? []).some(share => share.userId === userId && share.permissions?.includes(permission));

export const userCanUpdateDoc = (user: IUserDocument | null, doc: ShareableDocWithUserId | null): boolean => {
  if (!user || !doc) return false;
  if (user.id === doc.userId) return true;
  // Check if the user has global 'update' permission or specific 'update' permission for this session
  if (doc.isGlobalWrite) {
    return true;
  }

  if (!doc.users) {
    console.log(`UserId: ${user.id} Doc's userID ${doc.userId} doc.id ${doc.id} has no users!`);
  }

  if (holdsPermission(doc, user.id, Permission.update)) {
    return true;
  }

  return false;
};

export const userCanReadDoc = (user: IUserDocument | null, doc: ShareableDocWithUserId | null): boolean => {
  if (!user || !doc) return false;
  if (user.id === doc.userId) return true;

  // Check if the user has global 'update' permission or specific 'update' permission for this session
  if (doc.isGlobalRead) {
    return true;
  }

  if (holdsPermission(doc, user.id, Permission.read)) {
    return true;
  }

  return false;
};

export const userCanDeleteDoc = (user: IUserDocument | null, doc: ShareableDocWithUserId | null): boolean => {
  if (!user || !doc) return false;
  if (user.id === doc.userId) return true;

  if (holdsPermission(doc, user.id, Permission.delete)) {
    return true;
  }

  return false;
};

/**
 * Show the conversation when the user can read the session OR authorized content is
 * present. The /chat query is read-gated server-side (findAccessibleById), so its
 * content implies authorization - only pass `hasAuthorizedContent` sourced from it.
 * Auth is checked at fetch time, so a cached conversation can briefly outlive a
 * mid-session access revocation.
 */
export const canShowConversation = (canRead: boolean, hasAuthorizedContent: boolean): boolean =>
  canRead || hasAuthorizedContent;

export const userCanShareDoc = (user: IUserDocument | null, doc: ShareableDocWithUserId | null): boolean => {
  if (!user || !doc) return false;
  if (user.id === doc.userId) return true;

  if (holdsPermission(doc, user.id, Permission.share)) {
    return true;
  }

  return false;
};
