import {
  ForbiddenError,
  IUserDocument,
  Permission,
  ShareableAccessShape,
  grantablePermissions,
} from '@bike4mind/common';
import { canonicalId } from '../utils/objectIds';

type Attacher = Pick<IUserDocument, 'id' | 'groups'>;

/** A file or session as the gate reads it; cast at the call site like grantCap's callers do. */
export type AttachableItem = ShareableAccessShape & { id: string; fileName?: string; name?: string };

/**
 * Project membership grants read on every attached item, so attaching an item shares it with every
 * current and future member. The attacher must therefore be able to share it: own it or hold share
 * on it, the same gate as reshareableBy in sharingService/accept.ts. An item already attached to the
 * project is exempt, since attaching it again shares nothing new.
 */
export const canAttachToProject = (
  item: AttachableItem,
  attacher: Attacher,
  alreadyAttachedIds: Iterable<string> = []
): boolean => {
  const attached = new Set(Array.from(alreadyAttachedIds, canonicalId));
  if (attached.has(canonicalId(item.id))) return true;
  return grantablePermissions(item, attacher.id, attacher.groups ?? []).has(Permission.share);
};

/**
 * Throws a 403 when any of `items` cannot be attached by `attacher` (see canAttachToProject). 403,
 * not the 404/400 used for unreachable ids: every item here already resolved through a read-scoped
 * lookup, so refusing it reveals nothing the caller could not already see.
 */
export const assertCanAttachToProject = (
  items: AttachableItem[],
  attacher: Attacher,
  alreadyAttachedIds: Iterable<string>,
  noun: 'files' | 'notebooks'
): void => {
  const attached = Array.from(alreadyAttachedIds);
  const refused = items.filter(item => !canAttachToProject(item, attacher, attached));
  if (refused.length === 0) return;
  // Named so the caller knows which pick to drop: the whole batch is refused, nothing is attached.
  const names = refused.map(item => item.fileName || item.name || item.id).join(', ');
  throw new ForbiddenError(`You need share access to add these ${noun} to a project: ${names}`);
};
