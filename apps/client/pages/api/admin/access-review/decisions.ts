import {
  AccessReviewDecisionSchema,
  BadRequestError,
  ConflictError,
  NotFoundError,
  sortAdminPermissions,
  type AccessReviewDecision,
  type AccessReviewReviewer,
} from '@bike4mind/common';
import {
  AdminAuditLogModel,
  User,
  adminAccessReviewRepository,
  adminRoleRepository,
  withTransaction,
} from '@bike4mind/database';
import {
  ACCESS_REVIEW_DEFAULT_DORMANT_DAYS,
  quarterStart,
  reviewQuarter,
} from '@bike4mind/server-utils/security/accessReview/accessReview';
import { ACCESS_REVIEW_ADMIN_FILTER } from '@bike4mind/server-utils/security/accessReview/accessReviewData';
import {
  denySelfAdminAction,
  isSameUserId,
  isSelfOrImpersonator,
  recordAdminActionFromRequest,
} from '@bike4mind/server-utils/utils/adminAudit';
import { adminApi } from '@server/middlewares/adminApi';
import { csrfProtection } from '@server/middlewares/csrfProtection';
import { assertAccessReviewer } from '@server/admin/accessReview';

type TargetDoc = {
  email?: string | null;
  name?: string | null;
  username?: string | null;
  isAdmin?: boolean;
  adminPermissions?: string[] | null;
  adminRoleIds?: unknown[] | null;
};

type RevocationEntry = {
  _id: unknown;
  action: string;
  changes?: { field: string; before?: unknown }[];
};

const REVOCATION_ACTIONS = ['user.permissions.updated', 'user.role.admin_revoked'];

const holdsAdminAccess = (user: TargetDoc) =>
  user.isAdmin === true || (user.adminPermissions?.length ?? 0) > 0 || (user.adminRoleIds?.length ?? 0) > 0;

/**
 * Records a keep/revoke decision for one admin in this quarter's review. A revoke is never performed
 * here: it is accepted only once the account already holds no admin access and this quarter's audit
 * log shows the change that removed it (the permissions or role PUT), so the record cannot claim a
 * revocation that did not happen. Nobody can decide on their own access.
 */
const handler = adminApi({ auth: 'jwtOnly', adminPermissions: { POST: 'settings:manage' } })
  .use(csrfProtection())
  .post(async (req, res) => {
    assertAccessReviewer(req.user);
    const parsed = AccessReviewDecisionSchema.safeParse(req.body);
    if (!parsed.success) throw new BadRequestError('Choose an admin account and a decision of confirmed or revoked');
    const { userId, decision, dormantDays = ACCESS_REVIEW_DEFAULT_DORMANT_DAYS } = parsed.data;
    const action = decision === 'confirmed' ? 'access_review.confirmed' : 'access_review.revoked';

    if (isSelfOrImpersonator(req.user, userId)) {
      await denySelfAdminAction(req, {
        action: 'access_review.denied',
        attempted: action,
        target: { kind: 'user', id: userId, displayName: userId },
        message: 'Another admin must review your access.',
      });
    }

    const now = new Date();
    const quarter = reviewQuarter(now);
    const reviewer: AccessReviewReviewer = {
      userId: req.user.id,
      name: req.user.name || req.user.username || req.user.id,
    };

    const result = await withTransaction(async () => {
      const target = await User.findById(userId)
        .select('email name username isAdmin adminPermissions adminRoleIds')
        .lean<TargetDoc>();
      if (!target) throw new NotFoundError('User not found');
      const displayName = target.name || target.username || userId;

      let entry: AccessReviewDecision;
      if (decision === 'confirmed') {
        if (!holdsAdminAccess(target)) {
          throw new ConflictError('This account no longer holds admin access. Reload the review.');
        }
        const roles = await adminRoleRepository.findByIds((target.adminRoleIds ?? []).map(String));
        entry = {
          userId,
          email: target.email ?? null,
          fullAdmin: target.isAdmin === true,
          permissions: sortAdminPermissions([
            ...(target.adminPermissions ?? []),
            ...roles.flatMap(role => role.permissions),
          ]),
          decision,
          reviewer,
          decidedAt: now,
        };
      } else {
        if (holdsAdminAccess(target)) {
          throw new ConflictError(
            'Remove this admin access through the permission change first, then record the revocation.'
          );
        }
        const revocation = await AdminAuditLogModel.findOne({
          'target.kind': 'user',
          'target.id': userId,
          action: { $in: REVOCATION_ACTIONS },
          occurredAt: { $gte: quarterStart(now) },
        })
          .sort({ occurredAt: -1 })
          .select('_id action changes')
          .lean<RevocationEntry>();
        if (!revocation) {
          throw new ConflictError('No admin access removal for this account is on the audit log this quarter.');
        }
        const removed = revocation.changes?.find(change => change.field === 'adminPermissions')?.before;
        entry = {
          userId,
          email: target.email ?? null,
          fullAdmin: revocation.action === 'user.role.admin_revoked',
          permissions: Array.isArray(removed) ? removed.map(String) : [],
          decision,
          reviewer,
          decidedAt: now,
          auditEntryId: String(revocation._id),
        };
      }

      let record = await adminAccessReviewRepository.recordDecision(quarter, dormantDays, reviewer, entry);
      await recordAdminActionFromRequest(req, {
        action,
        target: { kind: 'user', id: userId, displayName },
        summary: `${decision} admin access in the ${quarter} access review`,
        details: { quarter, ...(entry.auditEntryId && { auditEntryId: entry.auditEntryId }) },
      });

      const admins = await User.find(ACCESS_REVIEW_ADMIN_FILTER, { _id: 1 }).lean<{ _id: unknown }[]>();
      const decided = new Set(record.decisions.map(({ userId: id }) => id));
      const pending = admins.map(({ _id }) => String(_id)).filter(id => !decided.has(id));
      let completed = false;
      if (pending.length === 0 && !record.completedAt) {
        record = (await adminAccessReviewRepository.markCompleted(quarter, now, reviewer)) ?? record;
        completed = true;
        await recordAdminActionFromRequest(req, {
          action: 'access_review.completed',
          target: { kind: 'system', id: `access-review-${quarter}`, displayName: `Access review ${quarter}` },
          summary: `completed the ${quarter} access review`,
          details: { quarter, decisions: record.decisions.length },
        });
      }
      // The reviewer's own row needs another admin, so a lone remaining self row cannot be finished here.
      const pendingSelf = pending.length === 1 && isSameUserId(pending[0], req.user.id);
      return { record, completed, pending: pending.length, pendingSelf };
    });

    return res.json(result);
  });

export const config = { api: { externalResolver: true, bodyParser: { sizeLimit: '4kb' } } };
export default handler;
