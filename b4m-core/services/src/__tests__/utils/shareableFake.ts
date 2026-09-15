import { Permission } from '@bike4mind/common';

/**
 * A shareable repository that applies the real grant rules instead of returning a canned value,
 * so an authorization test can say "a read-only sharee is refused" rather than naming the
 * predicate the service happens to call. Mirrors ShareableDocumentRepository's three arms
 * (owner, users[], groups[]) - the semantics those predicates are pinned to in
 * packages/database SharableDocumentModel.integration.test.ts.
 */
export interface ShareableFakeDoc {
  id: string;
  userId: string;
  users?: Array<{ userId: string; permissions: Permission[] | string[]; projectId?: string }>;
  groups?: Array<{ groupId: string; permissions: Permission[] | string[] }>;
}

export interface ShareableFakeActor {
  id: string;
  groups?: string[];
}

// 'write' has no Permission member and so can never be stored, but the read arm still queries
// for it; kept here so the fake matches the predicate rather than the enum.
const READ_GRANTS = ['read', 'write'];

const holds = (doc: ShareableFakeDoc, actor: ShareableFakeActor, grants: string[]): boolean => {
  if (doc.userId === actor.id) return true;
  const byUser = doc.users?.some(share => share.userId === actor.id && share.permissions.some(p => grants.includes(p)));
  if (byUser) return true;
  return (
    doc.groups?.some(
      share => (actor.groups ?? []).includes(share.groupId) && share.permissions.some(p => grants.includes(p))
    ) ?? false
  );
};

export const createShareableFake = <T extends ShareableFakeDoc>(docs: T[]) => {
  const byId = (id: string) => docs.find(doc => doc.id === id);
  const gateOne = (grants: string[]) => async (actor: ShareableFakeActor, id: string) => {
    const doc = byId(id);
    return doc && holds(doc, actor, grants) ? doc : null;
  };
  const gateMany = (grants: string[]) => async (actor: ShareableFakeActor, ids: string[]) =>
    ids.map(byId).filter((doc): doc is T => !!doc && holds(doc, actor, grants));

  return {
    findAllAccessible: async (actor: ShareableFakeActor) => docs.filter(doc => holds(doc, actor, READ_GRANTS)),
    findAllShared: async (actor: ShareableFakeActor) =>
      docs.filter(doc => doc.userId !== actor.id && holds(doc, actor, READ_GRANTS)),
    findAccessibleById: gateOne(READ_GRANTS),
    findAllAccessibleByIds: gateMany(READ_GRANTS),
    findUpdateAccessById: gateOne([Permission.update]),
    findAllUpdateAccessByIds: gateMany([Permission.update]),
    findShareAccessById: gateOne([Permission.share]),
  };
};
