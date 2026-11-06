import type { AdminAuditAction } from './adminAuditCatalogue';

/**
 * One collection in a data subject erasure: how many of its documents naming the person are deleted,
 * have the person removed (anonymized or pulled from an array) and are kept, with the reasons for
 * keeping them. Counts and registry text only, never the person's data, so it can sit in the
 * completion record.
 */
export type AdminErasureCollection = {
  model: string;
  deleted: number;
  anonymized: number;
  retained: number;
  retainReasons: string[];
};

export type AdminErasurePreview = { generatedAt: string; collections: AdminErasureCollection[] };

/** Where an admin erasure stands, as the admin profile shows it. The user is gone once it completes. */
export type AdminErasureState =
  | { state: 'none' }
  /** A self-serve deletion is pending; an admin erasure cannot be requested over it. */
  | { state: 'selfDeletionPending'; scheduledFor: string }
  | { state: 'requested'; requestedAt: string; requestedBy: string | null; purgeStartedAt: string | null };

export const ADMIN_ERASURE_PREVIEWED_ACTION = 'user.erasure.previewed' satisfies AdminAuditAction;
export const ADMIN_ERASURE_REQUESTED_ACTION = 'user.erasure.requested' satisfies AdminAuditAction;
export const ADMIN_ERASURE_COMPLETED_ACTION = 'user.erasure.completed' satisfies AdminAuditAction;
