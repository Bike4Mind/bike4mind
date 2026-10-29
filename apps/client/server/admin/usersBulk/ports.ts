import { z } from 'zod';
import { ApiKeyStatus, type AdminAuditAction, type AuditChange } from '@bike4mind/common';
import type { cacheRepository } from '@bike4mind/database';
import { ADMIN_USERS_BULK_MAX, ADMIN_USERS_BULK_UNDO_WINDOW_MS } from '@client/app/utils/adminUsersBulk';
import type { BulkUser } from './resolve';

/**
 * The persistence seams shared by execute and undo. Real implementations live in adapters.ts; every
 * write runs inside the caller's per-user transaction (mongoose AsyncLocalStorage carries the session).
 */
export type UsersBulkDb = {
  findUser: (userId: string) => Promise<BulkUser | null>;
  /** Sets the flag only when it differs; true when it changed. */
  setFlag: (userId: string, field: 'isBanned' | 'isModerated', value: boolean) => Promise<boolean>;
  /** $addToSet / $pull; true when the tag list changed. */
  addTag: (userId: string, tag: string) => Promise<boolean>;
  removeTag: (userId: string, tag: string) => Promise<boolean>;
  /** Disables the user's live keys, stamped with the batch so only that batch's undo can restore them. */
  revokeLiveApiKeys: (input: {
    userId: string;
    revokedBy: string;
    reason: string;
    batchId: string;
  }) => Promise<RevokedApiKey[]>;
  reactivateApiKeys: (userId: string, keys: RevokedApiKey[], batchId: string) => Promise<number>;
  /** Writes the balance change through the credit ledger; `delta` is signed and non-zero. */
  adjustCredits: (input: {
    userId: string;
    delta: number;
    actorId: string;
    previousBalance: number;
    note: string;
    batchId: string;
  }) => Promise<{ creditTransactionId?: string }>;
};

export type UsersBulkStore = Pick<
  typeof cacheRepository,
  | 'claimDedup'
  | 'casUpdateDedup'
  | 'casDeleteDedup'
  | 'createOrUpdate'
  | 'findByKey'
  | 'readDedup'
  | 'deleteByKeyAndReturn'
>;

export type UsersBulkAuditEntry = {
  action: Extract<AdminAuditAction, `user.bulk.${string}`>;
  user: Pick<BulkUser, 'id' | 'email' | 'username'>;
  summary: string;
  changes?: AuditChange[];
  details?: Record<string, unknown>;
  related?: { creditTransactionId?: string };
};

export type UsersBulkLogger = { error: (message: string, meta?: Record<string, unknown>) => void };

/** Runs one user's steps atomically; may retry the callback, so every step re-reads its state. */
export type RunInTransaction = <T>(fn: () => Promise<T>) => Promise<T>;

const RevokedApiKeySchema = z.object({ id: z.string(), status: z.enum(ApiKeyStatus) });
export type RevokedApiKey = z.infer<typeof RevokedApiKeySchema>;

/** Exactly what one batch changed for one user, so undo reverts that and nothing else. */
const UserUndoSnapshotSchema = z.object({
  userId: z.string(),
  /** This batch set isBanned / isModerated from false to true. */
  banned: z.literal(true).optional(),
  moderated: z.literal(true).optional(),
  /** The tag this batch added (absent before). */
  tagAdded: z.string().optional(),
  /** Signed ledger delta this batch applied. */
  creditDelta: z.number().optional(),
  apiKeys: z.array(RevokedApiKeySchema).optional(),
});
export type UserUndoSnapshot = z.infer<typeof UserUndoSnapshotSchema>;

export const UndoRecordSchema = z.object({
  batchId: z.string(),
  adminId: z.string(),
  action: z.string(),
  undoExpiresAt: z.string(),
  users: z.array(UserUndoSnapshotSchema).max(ADMIN_USERS_BULK_MAX),
  /** Domains this batch added to blockedEmailDomains (not ones already listed), so undo removes only these. */
  blockedDomains: z.array(z.string()).max(ADMIN_USERS_BULK_MAX).optional(),
});
export type UndoRecord = z.infer<typeof UndoRecordSchema>;

// ms. Kept past the undo window so a request racing the deadline is refused by the expiry check, not a miss.
export const UNDO_RECORD_GRACE_MS = 60_000;
export const UNDO_RECORD_TTL_MS = ADMIN_USERS_BULK_UNDO_WINDOW_MS + UNDO_RECORD_GRACE_MS;
// ms. Execute stops starting new chunks after this and returns a partial result, well inside a request timeout.
export const EXECUTE_BUDGET_MS = 40_000;
// ms. A user's owner entry must outlive any undo record that names them, which can be written up to a budget later.
export const USER_OWNER_TTL_MS = EXECUTE_BUDGET_MS + UNDO_RECORD_TTL_MS;
// ms. A replay inside this window returns the first result instead of acting again.
export const IDEMPOTENCY_TTL_MS = 10 * 60_000;

export const undoKey = (batchId: string) => `admin-users-bulk:undo:${batchId}`;
/**
 * The latest batch that changed a user, `{ batchId }`, kept as long as an undo record can live. Undo of
 * an older batch refuses a user a newer batch owns, so it never reverts what the newer batch did.
 */
export const userOwnerKey = (userId: string) => `admin-users-bulk:user:${userId}`;
export const idempotencyKey = (adminId: string, key: string) => `admin-users-bulk:idem:${adminId}:${key}`;

// Users run in parallel up to this many at a time; each holds its own transaction.
export const USERS_BULK_CONCURRENCY = 8;

export const errorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error));
