import {
  ADMIN_AUDIT_DEFAULT_CRITICAL_GRANT_CREDITS,
  ConflictError,
  ForbiddenError,
  HTTPError,
  NotFoundError,
  approvalParamsHash,
  canonicalApprovalJson,
  hasAdminPermission,
  isFullAdmin,
  missingAdminPermissionMessage,
  type AdminApproval,
  type AdminApprovalAction,
  type AdminApprovalStatus,
  type AdminPermissionId,
  type AuditTarget,
} from '@bike4mind/common';
import { adminApprovalRepository, adminSettingsRepository } from '@bike4mind/database';
import { getSettingsMap, getSettingsValue } from '@bike4mind/utils';
import type { Request } from 'express';
import { selfIdsOf } from '@server/admin/usersBulk/actor';
import {
  denySelfAdminAction,
  isSameUserId,
  isSelfOrImpersonator,
  recordAdminActionFromRequest,
} from '@server/utils/adminAudit';
import { approvalAuditDetails } from './auditWriter';

const HOUR_MS = 60 * 60 * 1000;
/** An approved action still `executing` after this long most likely died mid-run. */
export const APPROVAL_STALLED_AFTER_MS = 15 * 60 * 1000;

export type ApprovalPolicy = {
  enabled: boolean;
  bulkUserThreshold: number;
  creditThreshold: number;
  expiryHours: number;
};

export const getApprovalPolicy = async (): Promise<ApprovalPolicy> => {
  const settings = await getSettingsMap(
    { adminSettings: adminSettingsRepository },
    {
      names: [
        'AdminApprovalsEnabled',
        'AdminApprovalBulkUserThreshold',
        'AdminApprovalCreditThreshold',
        'AdminApprovalExpiryHours',
      ],
    }
  );
  return {
    enabled: getSettingsValue('AdminApprovalsEnabled', settings, false),
    bulkUserThreshold: getSettingsValue('AdminApprovalBulkUserThreshold', settings, 25),
    creditThreshold: getSettingsValue(
      'AdminApprovalCreditThreshold',
      settings,
      ADMIN_AUDIT_DEFAULT_CRITICAL_GRANT_CREDITS
    ),
    expiryHours: getSettingsValue('AdminApprovalExpiryHours', settings, 24),
  };
};

type ApprovalUser = NonNullable<Request['user']>;

const currentUser = (req: Request): ApprovalUser => {
  if (!req.user) throw new ForbiddenError('Unauthorized. Admin access required.');
  return req.user;
};

const displayNameOf = (user: ApprovalUser) => user.name || user.username || user.email || user.id;

const approvalTarget = (approval: AdminApproval): AuditTarget => ({
  kind: 'system',
  id: approval.id,
  displayName: approval.summary,
});

const expiredError = () => new HTTPError(410, 'This approval request has expired. Submit a new request.');

const tamperedError = () =>
  new ConflictError('The stored request no longer matches what was requested. It was not run.');

const isExpired = (approval: AdminApproval, now: Date) => approval.expiresAt.getTime() <= now.getTime();

/** The requester, or anyone impersonating or impersonated by them, never decides their own request. */
const isOwnRequest = (user: ApprovalUser, approval: AdminApproval) =>
  [approval.requestedBy.id, ...approval.requestedBy.selfIds].some(id => isSelfOrImpersonator(user, id));

const canDecideAs = (user: ApprovalUser, approval: AdminApproval) =>
  hasAdminPermission(user, approval.requiredPermission) && (!approval.requiresFullAdmin || isFullAdmin(user));

const loadApproval = async (id: string): Promise<AdminApproval> => {
  const approval = /^[a-f0-9]{24}$/i.test(id) ? await adminApprovalRepository.findById(id) : null;
  if (!approval) throw new NotFoundError('Approval request not found');
  return approval;
};

/** A pending record past its expiry is closed as expired so it leaves the queue. */
const assertPendingAndLive = async (approval: AdminApproval, now: Date): Promise<void> => {
  if (approval.status === 'expired') throw expiredError();
  if (approval.status !== 'pending') throw new ConflictError(`This request is already ${approval.status}`);
  if (isExpired(approval, now)) {
    await adminApprovalRepository.finish(approval.id, 'pending', 'expired');
    throw expiredError();
  }
};

const errorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error));

export type RequestApprovalInput = {
  action: AdminApprovalAction;
  params: unknown;
  summary: string;
  reason: string;
  requiredPermission: AdminPermissionId;
  /** True when the direct route requires raw isAdmin, so a delegated admin cannot approve and run it. */
  requiresFullAdmin: boolean;
};

export type ApprovalPendingBody = { approvalId: string; status: 'pending'; expiresAt: Date };

/** Stores the request and audits it; the gated route answers 202 with the returned body. */
export async function requestApproval(
  req: Request,
  input: RequestApprovalInput,
  policy?: ApprovalPolicy
): Promise<ApprovalPendingBody> {
  const user = currentUser(req);
  const { expiryHours } = policy ?? (await getApprovalPolicy());
  const paramsJson = canonicalApprovalJson(input.params);
  const approval = await adminApprovalRepository.create({
    action: input.action,
    paramsJson,
    paramsHash: approvalParamsHash(paramsJson),
    summary: input.summary,
    requestedBy: { id: user.id, name: displayNameOf(user), email: user.email ?? '', selfIds: selfIdsOf(user) },
    reason: input.reason,
    requiredPermission: input.requiredPermission,
    requiresFullAdmin: input.requiresFullAdmin,
    expiresAt: new Date(Date.now() + expiryHours * HOUR_MS),
  });
  try {
    await recordAdminActionFromRequest(req, {
      action: 'admin.approval.requested',
      target: approvalTarget(approval),
      summary: `requested approval: ${approval.summary}`,
      reason: approval.reason,
      details: { approval: { id: approval.id, action: approval.action }, params: JSON.parse(paramsJson) },
    });
  } catch (error) {
    // The request write is strict: an unaudited request must not stay approvable.
    await adminApprovalRepository.finish(approval.id, 'pending', 'failed', { error: 'audit write failed' });
    throw error;
  }
  return { approvalId: approval.id, status: 'pending', expiresAt: approval.expiresAt };
}

export type ApproveOutcome = { approval: AdminApproval; result?: unknown };

/**
 * Approves and, for every action but impersonation, runs the stored params as the approver.
 * 404 unknown id, 403 own request or missing permission, 410 expired, 409 tampered params or already decided.
 */
export async function approveApproval(req: Request, id: string): Promise<ApproveOutcome> {
  const approver = currentUser(req);
  const approval = await loadApproval(id);
  const target = approvalTarget(approval);
  if (isOwnRequest(approver, approval)) {
    await denySelfAdminAction(req, {
      action: 'admin.approval.denied',
      attempted: 'admin.approval.approved',
      target,
      message: 'You cannot approve your own request. Another admin must approve it.',
    });
  }
  if (!canDecideAs(approver, approval)) {
    throw new ForbiddenError(
      approval.requiresFullAdmin
        ? 'Only a full admin can approve this request.'
        : missingAdminPermissionMessage(approval.requiredPermission)
    );
  }
  const now = new Date();
  await assertPendingAndLive(approval, now);
  if (approvalParamsHash(approval.paramsJson) !== approval.paramsHash) throw tamperedError();

  const redeemedByRequester = approval.action === 'user.impersonate_admin';
  const to: AdminApprovalStatus = redeemedByRequester ? 'approved' : 'executing';
  const claimed = await adminApprovalRepository.claim(
    approval.id,
    'pending',
    to,
    { now, notRequestedBy: approver.id },
    { decidedBy: { id: approver.id, name: displayNameOf(approver) }, decidedAt: now }
  );
  if (!claimed) throw new ConflictError('This request was already decided or has expired.');
  // The claim re-reads the record, and these are the params that run.
  if (approvalParamsHash(claimed.paramsJson) !== claimed.paramsHash) {
    await adminApprovalRepository.finish(claimed.id, to, 'failed', { error: 'stored params changed' });
    throw tamperedError();
  }

  const details = { approval: approvalAuditDetails(claimed), action: claimed.action };
  try {
    await recordAdminActionFromRequest(req, {
      action: 'admin.approval.approved',
      target,
      summary: `approved: ${claimed.summary}`,
      reason: claimed.reason,
      details,
    });
  } catch (error) {
    await adminApprovalRepository.finish(claimed.id, to, 'failed', { error: 'audit write failed' });
    throw error;
  }
  if (redeemedByRequester) return { approval: claimed };

  let result: unknown;
  try {
    // Loaded here so a gated route importing requestApproval does not pull in every executor's dependencies.
    const { approvalExecutors } = await import('./executors');
    result = await approvalExecutors[claimed.action](JSON.parse(claimed.paramsJson), {
      req,
      approval: claimed,
    });
  } catch (error) {
    await adminApprovalRepository.finish(claimed.id, 'executing', 'failed', { error: errorMessage(error) });
    await recordAdminActionFromRequest(req, {
      action: 'admin.approval.failed',
      target,
      summary: `approved request failed: ${claimed.summary}`,
      details: { ...details, error: errorMessage(error) },
    });
    throw error;
  }
  // The action already ran: a failed bookkeeping write is logged, never reported as a failed action.
  let executed: AdminApproval | null = null;
  try {
    executed = await adminApprovalRepository.finish(claimed.id, 'executing', 'executed', {
      executedAt: new Date(),
      result,
    });
  } catch (error) {
    req.logger.error('[ADMIN_APPROVAL_FINISH_FAILED]', { approvalId: claimed.id, error });
  }
  try {
    await recordAdminActionFromRequest(req, {
      action: 'admin.approval.executed',
      target,
      summary: `executed approved request: ${claimed.summary}`,
      details,
    });
  } catch (error) {
    req.logger.error('[ADMIN_APPROVAL_EXECUTED_AUDIT_FAILED]', { approvalId: claimed.id, error });
  }
  return { approval: executed ?? claimed, result };
}

/** Another admin rejects, or the requester withdraws, a pending request. */
export async function rejectApproval(req: Request, id: string, reason: string): Promise<AdminApproval> {
  const user = currentUser(req);
  const approval = await loadApproval(id);
  if (!isOwnRequest(user, approval) && !canDecideAs(user, approval)) {
    throw new ForbiddenError(missingAdminPermissionMessage(approval.requiredPermission));
  }
  const now = new Date();
  await assertPendingAndLive(approval, now);
  const rejected = await adminApprovalRepository.claim(
    approval.id,
    'pending',
    'rejected',
    { now },
    { decidedBy: { id: user.id, name: displayNameOf(user) }, decidedAt: now, decisionReason: reason }
  );
  if (!rejected) throw new ConflictError('This request was already decided or has expired.');
  try {
    await recordAdminActionFromRequest(req, {
      action: 'admin.approval.rejected',
      target: approvalTarget(rejected),
      summary: `rejected: ${rejected.summary}`,
      reason,
      details: { approval: approvalAuditDetails(rejected), action: rejected.action },
    });
  } catch (error) {
    // An unaudited rejection must not stand; the request goes back to pending.
    await adminApprovalRepository.finish(rejected.id, 'rejected', 'pending', {
      decidedBy: undefined,
      decidedAt: undefined,
      decisionReason: undefined,
    });
    throw error;
  }
  return rejected;
}

/**
 * The requester spends an approved request they run themselves. `params` must match what was approved.
 * 403 another caller, 409 not approved / already used / params differ, 410 expired.
 */
export async function redeemApproval(
  req: Request,
  id: string,
  action: AdminApprovalAction,
  params: unknown
): Promise<AdminApproval> {
  const user = currentUser(req);
  const approval = await loadApproval(id);
  if (!isSameUserId(user.id, approval.requestedBy.id)) {
    throw new ForbiddenError('Only the admin who requested this can use the approval.');
  }
  const now = new Date();
  if (approval.status === 'expired' || (approval.status === 'approved' && isExpired(approval, now))) {
    throw expiredError();
  }
  if (approval.status !== 'approved') {
    throw new ConflictError(
      approval.status === 'pending' ? 'This request has not been approved yet.' : `This request is ${approval.status}.`
    );
  }
  const paramsHash = approvalParamsHash(canonicalApprovalJson(params));
  if (
    approval.action !== action ||
    paramsHash !== approval.paramsHash ||
    approvalParamsHash(approval.paramsJson) !== approval.paramsHash
  ) {
    throw new ConflictError('This approval was granted for a different action.');
  }
  const redeemed = await adminApprovalRepository.claim(
    approval.id,
    'approved',
    'executed',
    { now, requestedBy: approval.requestedBy.id },
    { executedAt: now }
  );
  if (!redeemed) throw new ConflictError('This approval was already used or has expired.');
  await recordAdminActionFromRequest(req, {
    action: 'admin.approval.executed',
    target: approvalTarget(redeemed),
    summary: `used approved request: ${redeemed.summary}`,
    details: { approval: approvalAuditDetails(redeemed), action: redeemed.action },
  });
  return redeemed;
}

type ApprovalListFlags = { stalled: boolean; canDecide: boolean };

export type VisibleApprovalListRow = Omit<AdminApproval, 'paramsJson'> & ApprovalListFlags & { params: unknown };

export type WithheldApprovalListRow = Pick<AdminApproval, 'id' | 'action' | 'status' | 'createdAt' | 'expiresAt'> &
  ApprovalListFlags & { summary: null; reason: null; params: null };

export type ApprovalListRow = VisibleApprovalListRow | WithheldApprovalListRow;

export const APPROVAL_LIST_MAX = 100;

/**
 * Pending rows past their expiry are reported as expired; the record itself is closed on its next decision.
 * A row the caller neither requested nor may decide is cut down to its id, action, status and dates.
 */
export async function listApprovals(
  req: Request,
  query: { status?: AdminApprovalStatus; before?: Date; limit?: number }
): Promise<ApprovalListRow[]> {
  const user = currentUser(req);
  const now = new Date();
  const approvals = await adminApprovalRepository.list({
    status: query.status,
    before: query.before,
    limit: Math.min(query.limit ?? 50, APPROVAL_LIST_MAX),
  });
  return approvals.map((record): ApprovalListRow => {
    const { paramsJson, ...approval } = record;
    const status: AdminApprovalStatus =
      approval.status === 'pending' && isExpired(record, now) ? 'expired' : approval.status;
    const own = isOwnRequest(user, record);
    const mayDecide = canDecideAs(user, record);
    const flags: ApprovalListFlags = {
      stalled:
        status === 'executing' &&
        now.getTime() - (approval.decidedAt ?? approval.createdAt).getTime() > APPROVAL_STALLED_AFTER_MS,
      canDecide: status === 'pending' && !own && mayDecide,
    };
    if (!own && !mayDecide) {
      const { id, action, createdAt, expiresAt } = approval;
      return { id, action, status, createdAt, expiresAt, summary: null, reason: null, params: null, ...flags };
    }
    return { ...approval, status, params: JSON.parse(paramsJson), ...flags };
  });
}
