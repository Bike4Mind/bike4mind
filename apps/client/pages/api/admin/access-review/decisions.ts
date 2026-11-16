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

type AccessChangeEntry = {
  _id: unknown;
  action: string;
  changes?: { field: string; before?: unknown; after?: unknown }[];
};

type Removal = { entry: AccessChangeEntry; fullAdmin: boolean; permissions: string[]; roleIds: string[] };

// Grants are read too: they end the run of removals that took the access away.
const ACCESS_CHANGE_ACTIONS = ['user.permissions.updated', 'user.role.admin_granted', 'user.role.admin_revoked'];

const asStrings = (value: unknown) => (Array.isArray(value) ? value.map(String) : []);

/** What one audit entry removed; null when it granted anything or removed nothing. */
const removalOf = (entry: AccessChangeEntry): Removal | null => {
  if (entry.action === 'user.role.admin_revoked') return { entry, fullAdmin: true, permissions: [], roleIds: [] };
  if (entry.action !== 'user.permissions.updated') return null;
  const removal: Removal = { entry, fullAdmin: false, permissions: [], roleIds: [] };
  for (const change of entry.changes ?? []) {
    if (change.field !== 'adminPermissions' && change.field !== 'adminRoleIds') continue;
    const before = asStrings(change.before);
    const after = asStrings(change.after);
    if (after.some(id => !before.includes(id))) return null;
    const gone = before.filter(id => !after.includes(id));
    (change.field === 'adminPermissions' ? removal.permissions : removal.roleIds).push(...gone);
  }
  return removal.permissions.length > 0 || removal.roleIds.length > 0 ? removal : null;
};

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

    await adminAccessReviewRepository.ensureRecord(quarter, dormantDays, reviewer);
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
        const history = await AdminAuditLogModel.find({
          'target.kind': 'user',
          'target.id': userId,
          action: { $in: ACCESS_CHANGE_ACTIONS },
          occurredAt: { $gte: quarterStart(now) },
        })
          .sort({ occurredAt: -1, _id: -1 })
          .select('_id action changes')
          .lean<AccessChangeEntry[]>();
        // A full admin loses the role and the direct permissions in two writes, so every removal since
        // the last grant together is what was revoked.
        const removals: Removal[] = [];
        for (const change of history) {
          const removal = removalOf(change);
          if (!removal) break;
          removals.push(removal);
        }
        if (removals.length === 0) {
          throw new ConflictError('No admin access removal for this account is on the audit log this quarter.');
        }
        const roleIds = [...new Set(removals.flatMap(removal => removal.roleIds))];
        const roles = roleIds.length > 0 ? await adminRoleRepository.findByIds(roleIds) : [];
        entry = {
          userId,
          email: target.email ?? null,
          fullAdmin: removals.some(removal => removal.fullAdmin),
          permissions: sortAdminPermissions([
            ...removals.flatMap(removal => removal.permissions),
            ...roles.flatMap(role => role.permissions),
          ]),
          decision,
          reviewer,
          decidedAt: now,
          auditEntryId: String(removals[0].entry._id),
        };
      }

      const recorded = await adminAccessReviewRepository.recordDecision(quarter, dormantDays, reviewer, entry);
      let { record } = recorded;
      if (recorded.changed) {
        await recordAdminActionFromRequest(req, {
          action,
          target: { kind: 'user', id: userId, displayName },
          summary: `${decision} admin access in the ${quarter} access review`,
          details: { quarter, ...(entry.auditEntryId && { auditEntryId: entry.auditEntryId }) },
        });
      }

      const admins = await User.find(ACCESS_REVIEW_ADMIN_FILTER, { _id: 1 }).lean<{ _id: unknown }[]>();
      // A revoked admin who holds access again (re-granted this quarter) needs a new decision.
      const decided = new Set(
        record.decisions.filter(({ decision: value }) => value === 'confirmed').map(({ userId: id }) => id)
      );
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
