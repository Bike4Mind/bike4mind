/**
 * Shared session-ownership predicate: a caller has access if they own the session outright, or
 * hold a share on it. Structural (not `ISessionDocument`-typed) so a raw driver lookup's plain
 * object satisfies it too, not just a hydrated Mongoose document.
 */
export interface SessionOwnershipShape {
  userId: string;
  users?: Array<{ userId: string }>;
}

export function isSessionOwnedByUser(
  session: SessionOwnershipShape | null | undefined,
  userId: string | undefined
): boolean {
  if (!session || !userId) return false;
  return session.userId === userId || (session.users?.some(share => share.userId === userId) ?? false);
}
