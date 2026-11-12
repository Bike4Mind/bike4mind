import { PublishedArtifact, User } from '@bike4mind/database';
import { isValidObjectId } from '@bike4mind/server-utils/utils/objectId';

interface OwnerFields {
  name?: string;
  username?: string;
  isBanned?: boolean | null;
  moderation?: { status?: string | null } | null;
}

// The Mongo form of loadLiveOwner's check; the two must agree on what makes an owner live.
const LIVE_OWNER_QUERY = { isBanned: { $ne: true }, 'moderation.status': { $ne: 'suspended' } };

/**
 * The owner of a published artifact, or null when nothing should be served on their behalf: the
 * account is gone, banned, or moderation-suspended. A payment dispute (`disputePending`) is not
 * a reason to take someone's pages down, so it is deliberately not checked.
 *
 * Every artifact has an `ownerId` (required on the schema), so there is no ownerless case.
 * The lookup is by `_id` only and is not caught: a DB failure fails the request closed.
 */
export async function loadLiveOwner(ownerId: string): Promise<{ name?: string; username?: string } | null> {
  const owner = await User.findById(ownerId)
    .select('name username isBanned moderation.status')
    .lean<OwnerFields | null>();
  if (!owner || owner.isBanned || owner.moderation?.status === 'suspended') return null;
  return { name: owner.name, username: owner.username };
}

/**
 * The listing counterpart of loadLiveOwner: a clause that drops rows whose owner is not live, so the
 * browse listing (GET /api/publish/artifacts) agrees with serve and the metadata GET. Looks up only
 * the owners of rows in `filter` other than `callerId`, whose own rows always list. Null when every
 * owner is live. Like loadLiveOwner, a missing owner counts as not live and DB errors propagate.
 */
export async function excludeNonLiveOwners(
  filter: Record<string, unknown>,
  callerId: string
): Promise<{ ownerId: { $nin: string[] } } | null> {
  const ownerIds = (await PublishedArtifact.distinct('ownerId', {
    $and: [filter, { ownerId: { $ne: callerId } }],
  })) as string[];
  if (ownerIds.length === 0) return null;

  const live = await User.find({ _id: { $in: ownerIds.filter(id => isValidObjectId(id)) }, ...LIVE_OWNER_QUERY })
    .select('_id')
    .lean<Array<{ _id: unknown }>>();
  const liveIds = new Set(live.map(owner => String(owner._id)));
  // _id stringifies lowercase; a stored ownerId in other casing still matched the $in above.
  const hidden = ownerIds.filter(id => !liveIds.has(id.toLowerCase()));
  return hidden.length > 0 ? { ownerId: { $nin: hidden } } : null;
}
