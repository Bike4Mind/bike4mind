import type { IOrganizationRepository, IUserRepository, StorageOwner } from '@bike4mind/common';

/**
 * The two counters a FabFile's bytes can be billed to (see storageOwnerOf in @bike4mind/common).
 * Every service-side charge and refund moves them through `adjustOwnerStorage`, so no site picks a
 * counter by hand. The in-transaction app sites (apps/client/server/s3/storageCharge.ts, the delete
 * routes, lakeIngestShared) route the same way through their Mongoose-session equivalents.
 */
export type OwnerStorageCounters = {
  users: Pick<IUserRepository, 'incrementCurrentStorage'>;
  organizations: Pick<IOrganizationRepository, 'incrementCurrentStorage'>;
};

type StorageCounter = { incrementCurrentStorage(id: string, bytes: number): Promise<void> };

/** The counter `owner` is billed on, or undefined when the caller did not wire it. */
export const ownerStorageCounter = (
  counters: Partial<OwnerStorageCounters>,
  owner: StorageOwner
): StorageCounter | undefined => (owner.type === 'org' ? counters.organizations : counters.users);

/** Atomically moves `owner`'s counter by `bytes` (negative refunds), floored at 0. A 0 delta writes nothing. */
export async function adjustOwnerStorage(
  counters: OwnerStorageCounters,
  owner: StorageOwner,
  bytes: number
): Promise<void> {
  if (bytes === 0) return;
  const counter = owner.type === 'org' ? counters.organizations : counters.users;
  await counter.incrementCurrentStorage(owner.id, bytes);
}
