import { createHash } from 'crypto';
import type { AdminPermissionId } from '../../adminPermissions';

/**
 * Two-person approval for high-risk admin actions. The requester's params are stored as canonical JSON
 * plus its sha256, and an approval executes exactly those params; the record is kept as audit evidence.
 */

export const ADMIN_APPROVAL_ACTIONS = [
  'users.bulk',
  'org.credits.grant',
  'org.credits.top_up',
  'user.subscription.grant',
  'user.impersonate_admin',
  'user.delete_admin',
] as const;
export type AdminApprovalAction = (typeof ADMIN_APPROVAL_ACTIONS)[number];

/**
 * pending -> executing -> executed | failed on approve; pending -> approved -> executed for an action the
 * requester redeems themselves (impersonation); pending -> rejected | expired otherwise.
 */
export const ADMIN_APPROVAL_STATUSES = [
  'pending',
  'executing',
  'approved',
  'executed',
  'rejected',
  'expired',
  'failed',
] as const;
export type AdminApprovalStatus = (typeof ADMIN_APPROVAL_STATUSES)[number];

/** `selfIds` are the requester's own id plus any impersonating admin, so neither can approve. */
export type AdminApprovalRequester = { id: string; name: string; email: string; selfIds: string[] };
export type AdminApprovalDecider = { id: string; name: string };

export type AdminApproval = {
  id: string;
  action: AdminApprovalAction;
  paramsJson: string;
  paramsHash: string;
  summary: string;
  requestedBy: AdminApprovalRequester;
  reason: string;
  requiredPermission: AdminPermissionId;
  requiresFullAdmin: boolean;
  status: AdminApprovalStatus;
  expiresAt: Date;
  createdAt: Date;
  decidedBy?: AdminApprovalDecider;
  decidedAt?: Date;
  decisionReason?: string;
  executedAt?: Date;
  result?: unknown;
  error?: string;
};

export type NewAdminApproval = Omit<
  AdminApproval,
  'id' | 'status' | 'createdAt' | 'decidedBy' | 'decidedAt' | 'decisionReason' | 'executedAt' | 'result' | 'error'
>;

export type AdminApprovalUpdate = Partial<
  Pick<AdminApproval, 'decidedBy' | 'decidedAt' | 'decisionReason' | 'executedAt' | 'result' | 'error'>
>;

/** A claim only matches an unexpired record; at most one of the requester conditions is set. */
export type AdminApprovalClaimGuard = { now: Date; requestedBy?: string; notRequestedBy?: string };

export type AdminApprovalListQuery = {
  status?: AdminApprovalStatus;
  before?: Date;
  beforeId?: string;
  now?: Date;
  limit: number;
};

export interface IAdminApprovalRepository {
  create(approval: NewAdminApproval): Promise<AdminApproval>;
  findById(id: string): Promise<AdminApproval | null>;
  /** Newest first. */
  list(query: AdminApprovalListQuery): Promise<AdminApproval[]>;
  /** Atomic `from` -> `to` transition; null when another caller won, the record expired, or the guard missed. */
  claim(
    id: string,
    from: AdminApprovalStatus,
    to: AdminApprovalStatus,
    guard: AdminApprovalClaimGuard,
    set?: AdminApprovalUpdate
  ): Promise<AdminApproval | null>;
  /** Atomic `from` -> `to` transition with no expiry check, for recording an outcome. */
  finish(
    id: string,
    from: AdminApprovalStatus,
    to: AdminApprovalStatus,
    set?: AdminApprovalUpdate
  ): Promise<AdminApproval | null>;
}

const canonicalize = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === 'object' && !(value instanceof Date)) {
    const record = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(record)
        .sort()
        .filter(key => record[key] !== undefined)
        .map(key => [key, canonicalize(record[key])])
    );
  }
  return value;
};

/** JSON with object keys sorted at every depth; array order is meaningful and kept. */
export const canonicalApprovalJson = (value: unknown): string => JSON.stringify(canonicalize(value));

export const approvalParamsHash = (paramsJson: string): string => createHash('sha256').update(paramsJson).digest('hex');
