import { asyncHandler } from '@server/middlewares/asyncHandler';
import { baseApi } from '@server/middlewares/baseApi';
import {
  Organization,
  User,
  userRepository,
  friendshipRepository,
  withTransaction,
  TelemetryAuditLogModel,
} from '@bike4mind/database';
import { userService } from '@bike4mind/services';
import { redactUserSecretsForSelf } from '@bike4mind/common';
import { triggerTelemetryDeletion } from '@server/utils/telemetryDeletion';
import { getClientIp, truncateIp } from '@server/utils/ip';

const VALID_TELEMETRY_LEVELS = ['none', 'basic', 'enhanced'] as const;

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

const handler = baseApi().put(
  asyncHandler<{}, unknown, unknown, { id?: string }>(async (req, res) => {
    const userId = req.query.id!;
    const currentUser = req.user;

    // Detect context telemetry consent changes for GDPR audit logging (logged after successful update)
    const body = req.body as Record<string, unknown>;
    const incomingPrefs = body?.preferences as Record<string, unknown> | undefined;
    const incomingTelemetryLevel = incomingPrefs?.contextTelemetryLevel as string | undefined;

    // Non-admin users can only update their own profile
    if (!currentUser.isAdmin && currentUser.id !== userId) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    // Lockout guard: an explicit demote (isAdmin -> false) must not remove the
    // ONLY remaining Super Admin, and an admin must not remove their OWN Super
    // Admin role (self-demote). The old checkbox UI allowed both - a pre-existing
    // footgun the Roles radio (admin-roles-product-access-redesign M1) closes here,
    // at the actual write path, not just in the UI.
    if (currentUser.isAdmin && body?.isAdmin === false) {
      const targetUser = (await User.findById(userId).select('isAdmin').lean()) as Record<string, unknown> | null;
      if (targetUser?.isAdmin) {
        if (currentUser.id === userId) {
          return res.status(400).json({ error: 'You cannot remove your own Super Admin role.' });
        }
        const adminCount = await userRepository.count({ isAdmin: true });
        if (adminCount <= 1) {
          return res.status(400).json({ error: 'Cannot remove the last remaining Super Admin.' });
        }
      }
    }

    if (
      incomingTelemetryLevel &&
      !VALID_TELEMETRY_LEVELS.includes(incomingTelemetryLevel as (typeof VALID_TELEMETRY_LEVELS)[number])
    ) {
      return res.status(400).json({ error: 'Invalid contextTelemetryLevel' });
    }

    // Read previous telemetry level before the update
    let previousTelemetryLevel: string | undefined;
    if (incomingTelemetryLevel) {
      const currentUserDoc = await User.findById(userId).select('preferences.contextTelemetryLevel').lean();
      previousTelemetryLevel =
        (currentUserDoc as Record<string, unknown> & { preferences?: { contextTelemetryLevel?: string } })?.preferences
          ?.contextTelemetryLevel ?? 'basic';
      // Record consent timestamp only when level actually changes (GDPR Article 7(3) proof)
      if (previousTelemetryLevel !== incomingTelemetryLevel && incomingPrefs) {
        incomingPrefs.contextTelemetryConsentedAt = new Date();
      }
    }

    if (currentUser.isAdmin) {
      req.logger.updateMetadata({ body: req.body });
      await withTransaction(() =>
        userService.adminUpdateUser(
          currentUser.id,
          {
            ...(req.body as any),
            id: userId,
          },
          {
            db: {
              users: userRepository,
              organizations: Organization,
              friendship: friendshipRepository,
            },
          }
        )
      );

      // Log consent change only after successful update
      if (incomingTelemetryLevel) {
        await handleTelemetryConsentChange(userId, previousTelemetryLevel, incomingTelemetryLevel, req);
      }

      // Double-check we have the latest state
      const finalUser = await User.findById(userId);
      return res.json(redactUserSecretsForSelf(finalUser?.toJSON()));
    } else {
      await userService.updateUser(userId, req.body as any, {
        db: {
          users: userRepository,
        },
      });

      // Log consent change only after successful update
      if (incomingTelemetryLevel) {
        await handleTelemetryConsentChange(userId, previousTelemetryLevel, incomingTelemetryLevel, req);
      }

      // Same for non-admin updates
      const finalUser = await User.findById(userId);
      return res.json(redactUserSecretsForSelf(finalUser?.toJSON()));
    }
  })
);

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
