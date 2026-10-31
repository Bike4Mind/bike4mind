import { asyncHandler } from '@server/middlewares/asyncHandler';
import { baseApi } from '@server/middlewares/baseApi';
import {
  adminSettingsRepository,
  Organization,
  User,
  userRepository,
  friendshipRepository,
  creditTransactionRepository,
  TelemetryAuditLogModel,
  realtimeConnectionRepository,
} from '@bike4mind/database';
import { userApiKeyRepository } from '@bike4mind/database/auth';
import { userService } from '@bike4mind/services';
import { commitWithSessionEnd, type SessionEndReason } from '@server/auth/endUserSessions';
import {
  ApiKeyScope,
  ForbiddenError,
  redactUserSecretsForSelf,
  selfUserProfileResponseSchema,
} from '@bike4mind/common';
import { respond } from '@server/utils/respond';
import { triggerTelemetryDeletion } from '@server/utils/telemetryDeletion';
import { getClientIp, truncateIp } from '@bike4mind/server-utils/utils/ip';
import * as z from 'zod';
import { requireStepUp } from '@server/auth/stepUp';
import { propagateAccountRisk } from '@server/billing/linkedAccounts';
import {
  diffProfileFields,
  profileFieldsSent,
  readProfileSnapshot,
  recordProfileUpdate,
} from '@server/users/profileUpdateAudit';
import {
  denySelfAdminAction,
  isSameUserId,
  isSelfOrImpersonator,
  parseAdminActionReason,
  recordAdminActionFromRequest,
} from '@server/utils/adminAudit';

const idParamSchema = z.object({ id: z.string() });

const updateUserResponseSchema = selfUserProfileResponseSchema.extend({
  ignoredFields: z.array(z.string()).optional(),
});

/** Fields that change how the account signs in; see the credential gates in the handler. */
const CREDENTIAL_FIELDS = ['password', 'email'] as const;

const writesCredentialFields = (body: unknown): boolean => {
  const fields = (body ?? {}) as Record<string, unknown>;
  return CREDENTIAL_FIELDS.some(field => fields[field] !== undefined && fields[field] !== null);
};

async function getPreviousConsentLevel(
  userId: string,
  incomingLevel: string,
  prefs: { contextTelemetryConsentedAt?: Date } | null | undefined
): Promise<string | undefined> {
  const currentUserDoc = await User.findById(userId).select('preferences.contextTelemetryLevel').lean();
  const previousLevel =
    (currentUserDoc as Record<string, unknown> & { preferences?: { contextTelemetryLevel?: string } })?.preferences
      ?.contextTelemetryLevel ?? 'basic';
  if (previousLevel !== incomingLevel && prefs) {
    prefs.contextTelemetryConsentedAt = new Date();
  }
  return previousLevel;
}

/**
 * Log a telemetry consent level change for GDPR compliance.
 * Fire-and-forget - never blocks the response.
 */
function logConsentToggle(
  userId: string,
  previousLevel: string,
  newLevel: string,
  req: { ip?: string; headers: Record<string, unknown> }
) {
  TelemetryAuditLogModel.create({
    action: 'consent_toggle',
    userId: userId,
    questId: 'N/A',
    sourceIp: truncateIp(getClientIp(req as Parameters<typeof getClientIp>[0])),
    userAgent: (req.headers['user-agent'] as string) ?? 'unknown',
    outcome: 'success',
    durationMs: 0,
    metadata: { previousLevel, newLevel, source: 'user_preferences' },
  }).catch(err =>
    console.warn('[TelemetryAudit] Failed to log consent toggle:', err instanceof Error ? err.message : 'Unknown error')
  );
}

/**
 * Handle telemetry consent changes: log the toggle and trigger deletion if opted out.
 * Deletion is awaited (GDPR Article 17 requires verified deletion).
 * On failure, preference is still set to 'none' (stops future collection) and failure is audited.
 */
async function handleTelemetryConsentChange(
  userId: string,
  previousLevel: string | undefined,
  newLevel: string,
  req: { ip?: string; headers: Record<string, unknown> }
) {
  if (!previousLevel || previousLevel === newLevel) return;
  logConsentToggle(userId, previousLevel, newLevel, req);
  if (newLevel === 'none') {
    try {
      await triggerTelemetryDeletion(userId, req);
    } catch (err) {
      console.error(
        '[Telemetry] Deletion failed, user preference still set to none:',
        err instanceof Error ? err.message : 'Unknown error'
      );
      // Audit the failure so admins can monitor and manually retry
      await TelemetryAuditLogModel.create({
        action: 'delete',
        userId,
        questId: 'bulk-opt-out',
        sourceIp: truncateIp(getClientIp(req as Parameters<typeof getClientIp>[0])),
        userAgent: (req.headers['user-agent'] as string) ?? 'unknown',
        outcome: 'failure',
        durationMs: 0,
        metadata: { error: err instanceof Error ? err.message : 'Unknown error', reason: 'user_opt_out' },
      }).catch(() => {}); // Audit failure is truly non-blocking
    }
  }
}

type AccountStateSnapshot = Parameters<typeof userService.entersBlockedState>[0] & {
  isAdmin?: boolean;
  isModerated?: boolean;
  email?: string | null;
};

type AuditTargetSnapshot = {
  isAdmin?: boolean;
  isBanned?: boolean;
  isModerated?: boolean;
  currentCredits?: number;
  name?: string;
  username?: string;
  email?: string | null;
};

const userAuditTarget = (userId: string, user: AuditTargetSnapshot | null) => ({
  kind: 'user' as const,
  id: userId,
  displayName: user?.name || user?.username || user?.email || userId,
});

/** The status flags an admin update can flip, each with its own audit action pair. */
const STATUS_FLAGS = [
  {
    field: 'isBanned',
    on: { action: 'user.suspended', summary: 'suspended the account' },
    off: { action: 'user.reinstated', summary: 'reinstated the account' },
  },
  {
    field: 'isModerated',
    on: { action: 'user.restricted', summary: 'restricted the account' },
    off: { action: 'user.restriction_lifted', summary: 'lifted the restriction' },
  },
] as const;

/**
 * The flags this body actually flips. Generic edits resend the whole user, so a flag sent with its
 * current value is not a change and needs no reason.
 */
const statusFlagChanges = (body: userService.AdminUpdateUserParameters, before: AuditTargetSnapshot | null) =>
  STATUS_FLAGS.filter(({ field }) => body[field] !== undefined && body[field] !== !!before?.[field]);

/** Whether an admin update body asks to move the balance; mirrors adminUpdateUser's delta rule. */
const requestsCreditChange = (body: userService.AdminUpdateUserParameters, currentCredits: number | undefined) =>
  body.creditDelta !== undefined
    ? body.creditDelta !== 0
    : body.currentCredits !== undefined && body.currentCredits !== (currentCredits ?? 0);

/**
 * Why an admin edit must sign the target out everywhere, if it must. Entering a blocked state wins
 * so the audit names the strongest cause when one edit does several things.
 */
function adminEditSessionEndReason(
  passwordSet: boolean,
  before: AccountStateSnapshot | null,
  after: AccountStateSnapshot | null
): SessionEndReason | undefined {
  if (!before || !after) return undefined;
  if (userService.entersBlockedState(before, after)) return 'account_blocked';
  if (passwordSet) return 'password_changed';
  if (after.email !== before.email) return 'email_changed';
  return undefined;
}

const handler = baseApi().put(
  asyncHandler<{}, unknown, unknown, { id?: string }>(async (req, res) => {
    const { id: userId } = idParamSchema.parse(req.query);
    const currentUser = req.user;

    const isSelf = isSameUserId(currentUser.id, userId);
    // An admin editing someone else, or any edit made while impersonating, is mirrored as user.profile.updated.
    const mirrorsProfileUpdate = !isSelf || !!currentUser.impersonatedBy;

    // Non-admin users can only update their own profile
    if (!currentUser.isAdmin && !isSelf) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    // Changing your OWN sign-in credentials needs a browser session that recently re-verified, so
    // an API key can never do it. Only the admin schema accepts `email`. An admin writing ANOTHER
    // user's credentials or granting the admin role is held to the same bar in the admin branch.
    if (isSelf && writesCredentialFields(req.body)) {
      if (req.apiKeyInfo) throw new ForbiddenError('Password and email cannot be changed with an API key.');
      await requireStepUp(req);
    }

    if (currentUser.isAdmin) {
      // The admin branch writes credits, roles and email, so it needs the ADMIN
      // scope - but this route cannot declare `requiredScopes`, because it is also
      // every ordinary user's own profile update. The gate therefore lives on the
      // branch instead. JWT callers are unaffected; an admin driving their own
      // profile update with a narrow key now needs an admin-scoped one.
      // Read `apiKeyInfo` directly rather than via apiKeyAuth's helpers: importing that
      // middleware here would pull the whole auth/ability/model chain into a route that
      // needs one field off the request.
      if (req.apiKeyInfo && !req.apiKeyInfo.scopes.includes(ApiKeyScope.ADMIN)) {
        throw new ForbiddenError('Insufficient API key permissions', { required_scopes: [ApiKeyScope.ADMIN] });
      }

      // Another user's credentials and the admin role are session-only changes: an API key is
      // refused, a browser session must have recently re-verified. Both run before any write.
      // Revoking the role, bans and every other field stay ungated.
      if (!isSelf) {
        const grantsAdminRole =
          (req.body as Record<string, unknown> | undefined)?.isAdmin === true &&
          !((await User.findById(userId).select('isAdmin').lean()) as { isAdmin?: boolean } | null)?.isAdmin;
        if (writesCredentialFields(req.body) || grantsAdminRole) {
          if (req.apiKeyInfo) {
            throw new ForbiddenError('Credential and admin-role changes require a signed-in session.');
          }
          await requireStepUp(req);
        }
      }

      // Parse with the admin schema -- includes email, isAdmin, tags, credits, etc.
      const rawBody = (req.body ?? {}) as Record<string, unknown>;
      // Zod strips unknown keys, so a misnamed admin field (the `adminNote` vs
      // `creditReason` mix-up in useUpdateUserCredits was exactly this) parses away
      // and the 200 reads as "fully applied" when a credit grant, tag, or role
      // change never happened. Report them instead. Mirrors the self-service branch.
      const adminKeys = new Set(Object.keys(userService.adminUpdateUserSchema.shape));
      const ignoredFields = Object.keys(rawBody).filter(key => !adminKeys.has(key));

      // id comes from the route param; the spread ensures it wins over any id in the body.
      const body = userService.adminUpdateUserSchema.parse({ ...rawBody, id: userId });

      const targetBefore = (await User.findById(userId)
        .select('isAdmin isBanned isModerated currentCredits name username email')
        .lean()) as AuditTargetSnapshot | null;
      const auditTarget = userAuditTarget(userId, targetBefore);
      const changesRole = body.isAdmin !== undefined && body.isAdmin !== !!targetBefore?.isAdmin;
      const statusChanges = statusFlagChanges(body, targetBefore);
      const changesCredits = requestsCreditChange(body, targetBefore?.currentCredits);

      // No self-service privilege: an admin cannot change their own admin flag. The attempt is
      // recorded as a critical denied entry and answered with a 403. Self credit adjustments are
      // allowed for now, pending scoped admin permissions, and flagged in their audit entry.
      const targetsSelf = isSelfOrImpersonator(currentUser, userId);
      if (targetsSelf && changesRole) {
        await denySelfAdminAction(req, {
          action: 'user.role.denied',
          attempted: body.isAdmin ? 'user.role.admin_granted' : 'user.role.admin_revoked',
          target: auditTarget,
        });
      }

      // Validated before any write so a missing reason never leaves a half-applied update.
      const roleChangeReason = changesRole ? parseAdminActionReason(body.roleChangeReason) : undefined;
      const creditReason = changesCredits ? parseAdminActionReason(body.creditReason) : undefined;
      const statusChangeReason = statusChanges.length > 0 ? parseAdminActionReason(body.statusChangeReason) : undefined;

      // Lockout guard: an explicit demote must not remove the ONLY remaining Super Admin.
      if (changesRole && body.isAdmin === false) {
        const adminCount = await userRepository.count({ isAdmin: true });
        if (adminCount <= 1) {
          return res.status(400).json({ error: 'Cannot remove the last remaining Super Admin.' });
        }
      }

      const incomingTelemetryLevel = body.preferences?.contextTelemetryLevel;
      const previousTelemetryLevel = incomingTelemetryLevel
        ? await getPreviousConsentLevel(userId, incomingTelemetryLevel, body.preferences)
        : undefined;

      const profileFields = mirrorsProfileUpdate ? profileFieldsSent(body) : [];
      const profileBefore = profileFields.length > 0 ? await readProfileSnapshot(userId, profileFields) : null;

      req.logger.updateMetadata({ updatedFields: Object.keys(body) });
      const { snapshot: blockSnapshot, updated: blockUpdated } = await commitWithSessionEnd(
        req,
        async () => {
          // Read inside the transaction so the reason sees the state the write saw; an
          // outside read can be stale by the time the write commits.
          const snapshot = (await User.findById(userId)
            .select('isAdmin email isBanned isModerated disputePending moderation')
            .lean()) as AccountStateSnapshot | null;
          const { user: updated, creditAdjustment } = await userService.adminUpdateUser(
            currentUser.id,
            changesCredits ? { ...body, creditReason } : { ...body, currentCredits: undefined, creditReason },
            {
              db: {
                users: userRepository,
                organizations: Organization,
                friendship: friendshipRepository,
                userApiKeys: userApiKeyRepository,
                realtimeConnections: realtimeConnectionRepository,
                creditTransactions: creditTransactionRepository,
              },
            }
          );

          // These entries are strict: a failed audit write aborts this transaction, so no role,
          // balance, suspension or restriction change can commit without its record. Role and status
          // entries follow what this write flipped, not the pre-read: a concurrent edit can make the
          // pre-read stale, and a flip it missed still needs its reason, or the 400 rolls it back. No
          // written user (the row vanished) means nothing flipped.
          if (updated && !!snapshot?.isAdmin !== !!updated.isAdmin) {
            await recordAdminActionFromRequest(req, {
              action: updated?.isAdmin ? 'user.role.admin_granted' : 'user.role.admin_revoked',
              target: auditTarget,
              summary: updated?.isAdmin ? 'granted the admin role' : 'revoked the admin role',
              reason: roleChangeReason ?? parseAdminActionReason(body.roleChangeReason),
              changes: [{ field: 'isAdmin', before: !!snapshot?.isAdmin, after: !!updated?.isAdmin }],
            });
          }
          for (const { field, on, off } of updated ? STATUS_FLAGS : []) {
            const before = !!snapshot?.[field];
            const after = !!updated?.[field];
            if (before === after) continue;
            await recordAdminActionFromRequest(req, {
              ...(after ? on : off),
              target: auditTarget,
              reason: statusChangeReason ?? parseAdminActionReason(body.statusChangeReason),
              changes: [{ field, before, after }],
            });
          }
          if (creditAdjustment) {
            const { credits, previousBalance, resultingBalance, creditTransactionId } = creditAdjustment;
            await recordAdminActionFromRequest(req, {
              action: 'user.credits.adjusted',
              target: auditTarget,
              summary: `${credits > 0 ? 'granted' : 'deducted'} ${Math.abs(credits)} credits`,
              reason: creditAdjustment.note,
              changes: [{ field: 'currentCredits', before: previousBalance, after: resultingBalance }],
              details: { credits, selfGrant: targetsSelf },
              related: creditTransactionId ? { creditTransactionId } : undefined,
            });
          }
          return { snapshot, updated };
        },
        // adminUpdateUser returns the user as written, read inside the same transaction.
        ({ snapshot, updated }) => {
          const reason = adminEditSessionEndReason(typeof body.password === 'string', snapshot, updated);
          return reason && { userId, reason, actorUserId: currentUser.id !== userId ? currentUser.id : undefined };
        }
      );

      // A ban, suspension or dispute flag reaches accounts linked by card or network. After commit
      // and never throws, so it cannot undo the admin's change.
      if (blockSnapshot && blockUpdated && userService.entersBlockedState(blockSnapshot, blockUpdated)) {
        await propagateAccountRisk(
          { sourceUserId: userId, trigger: 'blocked by an admin', key: `admin-block:${userId}:${Date.now()}` },
          req.logger
        );
      }

      if (profileFields.length > 0) {
        await recordProfileUpdate(req, {
          target: auditTarget,
          changes: diffProfileFields(profileFields, profileBefore, await readProfileSnapshot(userId, profileFields)),
        });
      }

      // Log consent change only after successful update
      if (incomingTelemetryLevel) {
        await handleTelemetryConsentChange(userId, previousTelemetryLevel, incomingTelemetryLevel, req);
      }

      // Double-check we have the latest state
      const finalUser = await User.findById(userId);
      // Admin branch: symmetric with the admin view of GET /users/[id].
      const safeUser = redactUserSecretsForSelf(finalUser, {
        keep: ['securityQuestions'],
        keepAdminOnly: ['userNotes', 'signupMeta', 'signupGrantAssessment'],
      });
      // safeUser is null when the row vanished mid-request; spreading null there would
      // turn the response into a bare { ignoredFields } that reads as a user document.
      return respond(
        res,
        updateUserResponseSchema.nullable(),
        safeUser && ignoredFields.length > 0 ? { ...safeUser, ignoredFields } : safeUser
      );
    } else {
      // Parse with the self-service schema -- excludes isAdmin, tags, email, etc.
      // secureParameters inside the service strips any keys not in this allowlist.
      const rawBody = (req.body ?? {}) as Record<string, unknown>;
      // A non-admin key here (creditDelta, tags, isAdmin, ...) parses away silently
      // below -- surface it in the response so a 200 can't read as "fully applied"
      // when part of the request was discarded.
      const selfServiceKeys = new Set(Object.keys(userService.updateUserSchema.shape));
      const ignoredFields = Object.keys(rawBody).filter(key => !selfServiceKeys.has(key));

      const body = userService.updateUserSchema.parse(rawBody);

      const incomingTelemetryLevel = body.preferences?.contextTelemetryLevel;
      const previousTelemetryLevel = incomingTelemetryLevel
        ? await getPreviousConsentLevel(userId, incomingTelemetryLevel, body.preferences)
        : undefined;

      const profileFields = mirrorsProfileUpdate ? profileFieldsSent(body) : [];
      const profileBefore = profileFields.length > 0 ? await readProfileSnapshot(userId, profileFields) : null;

      const update = () =>
        userService.updateUser(userId, body, {
          db: {
            users: userRepository,
            adminSettings: adminSettingsRepository,
          },
        });
      // Only a password change needs the transaction; ordinary profile and preference saves skip it.
      // The service treats `""` as a password to write (it only skips undefined/null), so the gate
      // matches that rule rather than truthiness - otherwise an empty-string password changes the
      // credential without ending the sessions minted under it.
      if (typeof body.password === 'string') {
        await commitWithSessionEnd(req, update, () => ({ userId, reason: 'password_changed' }));
      } else {
        await update();
      }

      if (profileFields.length > 0) {
        const targetSnapshot = (await User.findById(userId)
          .select('name username email')
          .lean()) as AuditTargetSnapshot | null;
        await recordProfileUpdate(req, {
          target: userAuditTarget(userId, targetSnapshot),
          changes: diffProfileFields(profileFields, profileBefore, await readProfileSnapshot(userId, profileFields)),
        });
      }

      // Log consent change only after successful update
      if (incomingTelemetryLevel) {
        await handleTelemetryConsentChange(userId, previousTelemetryLevel, incomingTelemetryLevel, req);
      }

      // Non-admin self-update: symmetric with the self view of GET /users/[id], which means
      // no userNotes. This branch's own schema cannot write them either, so nothing is lost.
      const finalUser = await User.findById(userId);
      const safeUser = redactUserSecretsForSelf(finalUser, { keep: ['securityQuestions'] });
      // safeUser is null when the row vanished mid-request; spreading null there would
      // turn the response into a bare { ignoredFields } that reads as a user document.
      return respond(
        res,
        updateUserResponseSchema.nullable(),
        safeUser && ignoredFields.length > 0 ? { ...safeUser, ignoredFields } : safeUser
      );
    }
  })
);

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
