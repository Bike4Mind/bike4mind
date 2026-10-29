import type { Request } from 'express';
import {
  ADMIN_AUDIT_CREDIT_GRANT_ACTIONS,
  ADMIN_AUDIT_DEFAULT_CRITICAL_GRANT_CREDITS,
  ADMIN_AUDIT_DEFAULT_DAILY_GRANT_CREDITS,
  AdminActionReasonSchema,
  BadRequestError,
  ForbiddenError,
  type AdminAuditAction,
  type AuditActor,
  type AuditEntry,
  type AuditTarget,
  type StoredAuditContext,
} from '@bike4mind/common';
import { adminAuditLogRepository, adminSettingsRepository } from '@bike4mind/database';
import { userRepository } from '@bike4mind/database/auth';
import { adminAuditService } from '@bike4mind/services';
import { getClientIp } from '@bike4mind/server-utils/utils/ip';
import { getSettingsMap, getSettingsValue } from '@bike4mind/utils';

// Typed routes pass Request<unknown, ...>; this accepts those as well as the express default.
type AuditRequest = Request<unknown, unknown, unknown, unknown, Record<string, unknown>>;

export type RecordAdminActionFromRequestInput = Omit<adminAuditService.RecordAdminActionInput, 'actor' | 'context'> & {
  actorScope?: AuditActor['scope'];
};

type ActorIdentity = Pick<NonNullable<Request['user']>, 'id' | 'username' | 'name' | 'email' | 'isAdmin'>;

export const toUserActor = (user: ActorIdentity, scope: AuditActor['scope']): AuditActor => ({
  kind: 'user',
  scope,
  userId: user.id,
  email: user.email ?? undefined,
  name: user.name || user.username,
  wasAdmin: user.isAdmin,
});

const lookUpImpersonator = async (req: AuditRequest, impersonatedBy: string) => {
  try {
    return await userRepository.findById(impersonatedBy);
  } catch (error) {
    // Attribution must not abort the admin operation; the fallback actor still names who acted.
    const meta = { impersonatedBy, error };
    if (req.logger) req.logger.error('[ADMIN_AUDIT_ACTOR_LOOKUP_FAILED]', meta);
    else console.error('[ADMIN_AUDIT_ACTOR_LOOKUP_FAILED]', meta);
    return null;
  }
};

const resolveActor = async (req: AuditRequest, scope: AuditActor['scope']): Promise<AuditActor> => {
  const { user, apiKeyInfo } = req;
  if (!user) throw new Error('recordAdminActionFromRequest requires an authenticated request');

  // Declared locally: the `impersonatedBy` augmentation lives in apps/client/global.d.ts, which a
  // program importing this file from outside apps/client does not load.
  const { impersonatedBy } = user as typeof user & { impersonatedBy?: string };
  // The acting identity is the real admin; req.user is the account being impersonated.
  const admin = impersonatedBy ? await lookUpImpersonator(req, impersonatedBy) : undefined;
  const base: AuditActor = !impersonatedBy
    ? toUserActor(user, scope)
    : {
        ...(admin
          ? toUserActor(admin, scope)
          : { kind: 'user', scope, userId: impersonatedBy, name: 'Unknown admin', wasAdmin: true }),
        impersonatedUserId: user.id,
      };

  return apiKeyInfo ? { ...base, kind: 'apiKey', apiKeyId: apiKeyInfo.keyId } : base;
};

const buildContext = (req: AuditRequest): StoredAuditContext => ({
  ip: getClientIp(req),
  userAgent: req.headers['user-agent'],
  requestId: req.requestId,
  route: req.url.split('?')[0],
  source: req.apiKeyInfo ? 'api_key' : 'admin_ui',
});

/** Reads the grant thresholds from AdminSettings; recordAdminAction escalates a grant above either. */
export const loadCreditGrantPolicy = async (): Promise<adminAuditService.CreditGrantPolicy> => {
  const settings = await getSettingsMap(
    { adminSettings: adminSettingsRepository },
    { names: ['AdminAuditCriticalGrantCredits', 'AdminAuditDailyGrantCredits'] }
  );
  return {
    singleGrantCredits: getSettingsValue(
      'AdminAuditCriticalGrantCredits',
      settings,
      ADMIN_AUDIT_DEFAULT_CRITICAL_GRANT_CREDITS
    ),
    dailyTotalCredits: getSettingsValue(
      'AdminAuditDailyGrantCredits',
      settings,
      ADMIN_AUDIT_DEFAULT_DAILY_GRANT_CREDITS
    ),
    sumCreditsGranted: (actorUserId, since) => adminAuditLogRepository.sumCreditsGranted(actorUserId, since),
  };
};

const writerAdapters = async (
  req: AuditRequest,
  action: AdminAuditAction,
  preloadedPolicy?: () => Promise<adminAuditService.CreditGrantPolicy>
): Promise<adminAuditService.RecordAdminActionAdapters> => ({
  db: { adminAuditLog: adminAuditLogRepository },
  creditGrantPolicy: ADMIN_AUDIT_CREDIT_GRANT_ACTIONS.includes(action)
    ? await (preloadedPolicy ?? loadCreditGrantPolicy)()
    : undefined,
  logger: req.logger,
});

/**
 * `options.creditGrantPolicy` lets a caller writing many entries (a bulk batch) read the AdminSettings
 * thresholds once instead of once per entry.
 */
export const recordAdminActionFromRequest = async (
  req: AuditRequest,
  { actorScope, ...input }: RecordAdminActionFromRequestInput,
  options: { creditGrantPolicy?: () => Promise<adminAuditService.CreditGrantPolicy> } = {}
): Promise<AuditEntry | null> =>
  adminAuditService.recordAdminAction(
    { ...input, actor: await resolveActor(req, actorScope ?? 'platform'), context: buildContext(req) },
    await writerAdapters(req, input.action, options.creditGrantPolicy)
  );

/** For routes with no req.user (returnToAdmin authenticates by cookie): the caller names the actor. */
export const recordAdminActionForActor = async (
  req: AuditRequest,
  actor: AuditActor,
  input: Omit<adminAuditService.RecordAdminActionInput, 'actor' | 'context'>
): Promise<AuditEntry | null> =>
  adminAuditService.recordAdminAction(
    { ...input, actor, context: buildContext(req) },
    await writerAdapters(req, input.action)
  );

/**
 * Shown when the request carries no `reason` key at all. A bundle new enough to send the key also
 * renders the field, so an absent key means the tab predates the reason prompt - point at the reload
 * instead of a validation error about a field the reader cannot see.
 */
export const ADMIN_ACTION_REASON_MISSING_MESSAGE =
  'This page is running an outdated version of the app. Reload the page and try again.';

/** Validates a reason-required admin action's reason; a missing or short reason is a 400. */
export const parseAdminActionReason = (value: unknown): string => {
  if (value === undefined) throw new BadRequestError(ADMIN_ACTION_REASON_MISSING_MESSAGE);
  const parsed = AdminActionReasonSchema.safeParse(value);
  if (!parsed.success) throw new BadRequestError(parsed.error.issues[0]?.message ?? 'A reason is required');
  return parsed.data;
};

export const definedKeys = (data: Record<string, unknown>): string[] =>
  Object.keys(data).filter(key => data[key] !== undefined);

// Ids compare case-insensitively: Mongo resolves an upper-case hex id to the same user.
export const isSameUserId = (left: string, right: string) => left.toLowerCase() === right.toLowerCase();

// Under impersonation req.user is the impersonated account, so the real admin must be checked too.
export const isSelfOrImpersonator = (user: { id: string }, targetId: string): boolean => {
  const { impersonatedBy } = user as typeof user & { impersonatedBy?: string };
  return isSameUserId(user.id, targetId) || (!!impersonatedBy && isSameUserId(impersonatedBy, targetId));
};

type DeniedAction = Extract<AdminAuditAction, `${string}.denied`>;

/**
 * No self-service privilege: records the attempt as a critical `*.denied` entry, then throws a 403.
 * The denied entry is best-effort, so a failed write never turns the 403 into a 500.
 */
export const denySelfAdminAction = async (
  req: AuditRequest,
  {
    action,
    attempted,
    target,
    message = 'Admins cannot perform this action on their own account.',
  }: { action: DeniedAction; attempted: AdminAuditAction; target: AuditTarget; message?: string }
): Promise<never> => {
  await recordAdminActionFromRequest(req, {
    action,
    target,
    summary: `blocked ${attempted} on their own account`,
    details: { attemptedAction: attempted },
  });
  throw new ForbiddenError(message);
};

export const systemAuditActor = (name: string): AuditActor => ({
  kind: 'system',
  scope: 'platform',
  name,
  wasAdmin: false,
});

/** Audit target for the account an admin action is taken against. */
export const userAuditTarget = async (userId: string) => {
  const user = await userRepository.findById(userId);
  return { kind: 'user' as const, id: userId, displayName: user?.email ?? user?.username ?? userId };
};
