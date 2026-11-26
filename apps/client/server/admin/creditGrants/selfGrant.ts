import { hasAdminPermission } from '@bike4mind/common';
import type { CreditActor } from './delegateTargets';

/**
 * Whether a credit increase an admin makes to their own account, or to an organization they belong to,
 * must wait for a second admin holding `credits:adjust`. It always must unless they hold
 * `credits:self_grant`, which the full-admin flag does not imply (EXPLICIT_ONLY_ADMIN_PERMISSIONS).
 * Delegated admins are refused such grants outright (delegateTargets.ts), so this only ever holds a full admin's.
 */
export const isHeldSelfGrant = (actor: CreditActor, targetsSelf: boolean): boolean =>
  targetsSelf && !hasAdminPermission(actor, 'credits:self_grant');
