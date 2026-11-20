import { PublishedArtifact, User } from '@bike4mind/database';
import { Types } from 'mongoose';
import { z } from 'zod';

const OwnerIdSchema = z
  .union([z.string().regex(/^[a-f\d]{24}$/i), z.instanceof(Types.ObjectId).transform(id => id.toHexString())])
  .transform(id => id.toLowerCase());

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
): Promise<{ ownerId: { $nin: unknown[] } } | null> {
  const ownerIds: unknown[] = await PublishedArtifact.distinct('ownerId', {
    $and: [filter, { ownerId: { $ne: callerId } }],
  });
  const caller = OwnerIdSchema.safeParse(callerId);
  const owners = ownerIds
    .map(value => ({ value, parsed: OwnerIdSchema.safeParse(value) }))
    .filter(owner => !caller.success || !owner.parsed.success || owner.parsed.data !== caller.data);
  if (owners.length === 0) return null;

  const canonicalOwnerIds = owners.flatMap(owner => (owner.parsed.success ? [owner.parsed.data] : []));
  const live = await User.find({ _id: { $in: canonicalOwnerIds }, ...LIVE_OWNER_QUERY })
    .select('_id')
    .lean<Array<{ _id: unknown }>>();
  const liveIds = new Set(live.map(owner => String(owner._id).toLowerCase()));
  // This clause is used in a raw aggregation: preserve BSON values instead of stringifying them.
  const hidden = owners
    .filter(owner => !owner.parsed.success || !liveIds.has(owner.parsed.data))
    .map(owner => owner.value);
  return hidden.length > 0 ? { ownerId: { $nin: hidden } } : null;
}
