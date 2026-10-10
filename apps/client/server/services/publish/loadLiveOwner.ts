import { User } from '@bike4mind/database';

interface OwnerFields {
  name?: string;
  isBanned?: boolean | null;
  moderation?: { status?: string | null } | null;
}

/**
 * The owner of a published artifact, or null when nothing should be served on their behalf: the
 * account is gone, banned, or moderation-suspended. A payment dispute (`disputePending`) is not
 * a reason to take someone's pages down, so it is deliberately not checked.
 *
 * Every artifact has an `ownerId` (required on the schema), so there is no ownerless case.
 * The lookup is by `_id` only and is not caught: a DB failure fails the request closed.
 */
export async function loadLiveOwner(ownerId: string): Promise<{ name?: string } | null> {
  const owner = await User.findById(ownerId).select('name isBanned moderation.status').lean<OwnerFields | null>();
  if (!owner || owner.isBanned || owner.moderation?.status === 'suspended') return null;
  return { name: owner.name };
}
