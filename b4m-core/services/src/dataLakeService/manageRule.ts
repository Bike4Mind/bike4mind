import type { AccessContext, IDataLakeDocument } from '@bike4mind/common';

/** The acting principal for a write/manage decision - resolved from auth, never the body. */
export type ManageActor = Pick<AccessContext, 'userId' | 'isAdmin'>;

/**
 * The single WRITE/MANAGE decision for a lake: platform admin, or the lake's creator. This is
 * the exact rule the remove path (`removeFileFromDataLake`) and the visibility change already
 * enforce inline - centralized here so every mutating path agrees on who may write.
 *
 * Deliberately narrower than `canAccessLake` (read): a tag/entitlement/org grant lets a member
 * READ a lake but NOT write into it. Injecting a file (applying the lake's meta-tag) is a write,
 * so it must clear this gate, closing the read-can-write asymmetry.
 *
 * The truthiness guard makes the owner arm fail closed on a blank identity: without it, a lake with
 * no `createdByUserId` (the synthetic fallback document) would match an actor with no `userId`, since
 * `undefined === undefined` and `'' === ''`. Unreachable today - the schema requires the field and
 * `AccessContext.userId` is a required string - but this predicate now gates prompt DISCLOSURE as
 * well as writes, so it should not depend on those invariants holding elsewhere. Mirrors the same
 * guard in `getDataLakePrompts.ts`.
 *
 * Lives in its own module (not `authorizeLakeWrite.ts`, which re-exports it for existing callers)
 * because `canAccessLake` (in `assertLakeAccess.ts`) also needs it, and `authorizeLakeWrite.ts`
 * already imports FROM `assertLakeAccess.ts` - importing back would cycle.
 */
export function canManageLake(lake: Pick<IDataLakeDocument, 'createdByUserId'>, actor: ManageActor): boolean {
  if (actor.isAdmin) return true;
  return !!actor.userId && !!lake.createdByUserId && lake.createdByUserId === actor.userId;
}
