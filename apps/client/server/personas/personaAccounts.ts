import type { Request } from 'express';
import { z } from 'zod';
import {
  PERSONA_MAX_LIVE_DEFAULT,
  PERSONA_MINT_DAILY_LIMIT_DEFAULT,
  PERSONA_TTL_DAYS_DEFAULT,
  RESERVED_USERNAME_PREFIX,
  canAccessAdmin,
  internalStaffEmailRegex,
  parseInternalStaffDomains,
  personalEmailProviders,
  regionalPersonalEmailProviders,
  type AuditActor,
  type IUserDocument,
  type StoredAuditContext,
} from '@bike4mind/common';
import {
  User,
  adminAuditLogRepository,
  adminSettingsRepository,
  authSessionRepository,
  realtimeConnectionRepository,
  userRepository,
} from '@bike4mind/database';
import { adminAuditService, userService } from '@bike4mind/services';
import { getSettingsMap, getSettingsValue } from '@bike4mind/utils';
import type { Logger } from '@bike4mind/observability';
import { getClientIp } from '@bike4mind/server-utils/utils/ip';
import { entitlementsForEmail } from '@bike4mind/server-utils/lib/entitlements/registry';
import { partnerSignupGrantForEmail } from '@bike4mind/server-utils/entitlements/partnerRules';

/** The name a caller picks; it becomes the username middle and, on production, the mailbox. */
export const PERSONA_NAME_PATTERN = /^[a-z0-9]{1,24}$/;

/** Every persona username the server builds matches this; nothing else is a persona. */
export const PERSONA_USERNAME_PATTERN = /^persona-[a-z0-9]{1,24}-\d+$/;

/** The only body the mint route accepts: unknown keys (role, credits, flags, email) are a 400. */
export const MintPersonaBodySchema = z.strictObject({
  name: z.string().regex(PERSONA_NAME_PATTERN, 'name must be 1-24 lowercase letters or digits'),
});

const HOSTNAME_PATTERN = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

const DAY_MS = 24 * 60 * 60 * 1000;
const SWEEP_BATCH = 200;

export type PersonaSettings = {
  /** PersonaMintEnabled: off (the default) refuses every mint, whatever the key. */
  enabled: boolean;
  dailyLimit: number;
  maxLive: number;
  ttlDays: number;
  /** Null when unset, malformed or refused by personaEmailDomainRefusal: production minting stays off. */
  emailDomain: string | null;
};

/**
 * Why `domain` must not be the persona mail domain, or null when it is safe. A persona's address is
 * verified at mint, so on a domain that confers anything to verified addresses (env or partner-rule
 * entitlement grants, staff status, domain-gated shares) every persona would get it, and on a
 * public mail provider a persona would squat a real person's address. A partner-rule lookup failure
 * refuses.
 */
export async function personaEmailDomainRefusal(domain: string): Promise<string | null> {
  if (personalEmailProviders.includes(domain) || regionalPersonalEmailProviders.includes(domain)) {
    return 'a public mail provider';
  }
  const probe = `persona-domain-probe@${domain}`;
  if (entitlementsForEmail(probe, true).size > 0) return 'an entitlement grant domain';
  if (internalStaffEmailRegex(parseInternalStaffDomains(process.env.NEXT_PUBLIC_INTERNAL_STAFF_DOMAINS))?.test(probe)) {
    return 'an internal staff domain';
  }
  try {
    if ((await partnerSignupGrantForEmail(probe, true)).matched) return 'a partner signup rule domain';
  } catch {
    return 'a domain whose partner signup rules could not be read';
  }
  return null;
}

export async function loadPersonaSettings(logger?: Logger): Promise<PersonaSettings> {
  const settings = await getSettingsMap(
    { adminSettings: adminSettingsRepository },
    {
      names: ['PersonaMintEnabled', 'PersonaMintDailyLimit', 'PersonaMaxLive', 'PersonaTtlDays', 'PersonaEmailDomain'],
    }
  );
  const domain = String(getSettingsValue('PersonaEmailDomain', settings, '') ?? '')
    .trim()
    .toLowerCase();
  let emailDomain: string | null = HOSTNAME_PATTERN.test(domain) ? domain : null;
  if (emailDomain) {
    const refusal = await personaEmailDomainRefusal(emailDomain);
    if (refusal) {
      logger?.error('[PersonaMint] PersonaEmailDomain refused', { domain: emailDomain, refusal });
      emailDomain = null;
    }
  }
  return {
    enabled: getSettingsValue('PersonaMintEnabled', settings, false) === true,
    dailyLimit: getSettingsValue('PersonaMintDailyLimit', settings, PERSONA_MINT_DAILY_LIMIT_DEFAULT),
    maxLive: getSettingsValue('PersonaMaxLive', settings, PERSONA_MAX_LIVE_DEFAULT),
    ttlDays: getSettingsValue('PersonaTtlDays', settings, PERSONA_TTL_DAYS_DEFAULT),
    emailDomain,
  };
}

/**
 * The username and email for a new persona, both built here from the validated name. Production
 * mail goes to `<name>@<PersonaEmailDomain>` (null when the domain is unset, so minting stays off);
 * every other stage uses the `-<testId>-<digits>-e2e@test.com` shape the e2e cleanup already sweeps
 * (buildE2EEmailPattern in server/utils/e2eCleanupScope.ts, testId `persona<name>`).
 */
export function personaIdentity(
  name: string,
  options: { production: boolean; emailDomain: string | null; now: Date }
): { username: string; email: string } | null {
  if (!PERSONA_NAME_PATTERN.test(name)) return null;
  const digits = String(options.now.getTime()).slice(-10);
  const username = `${RESERVED_USERNAME_PREFIX}${name}-${digits}`;
  if (!options.production) return { username, email: `b4m-persona${name}-${digits}-e2e@test.com` };
  return options.emailDomain ? { username, email: `${name}@${options.emailDomain}` } : null;
}

/** Whether the persona key may act on this account: flagged, persona-shaped, and holding no admin access. */
export function isPersonaAccount(
  user: Pick<IUserDocument, 'username' | 'isPersona' | 'isAdmin' | 'adminPermissions'> | null | undefined
): boolean {
  return (
    !!user &&
    user.isPersona === true &&
    PERSONA_USERNAME_PATTERN.test(user.username ?? '') &&
    !user.isAdmin &&
    !canAccessAdmin(user)
  );
}

/** Why a mint must be refused under the caps, or null to proceed. Counts are taken by the caller. */
export function personaCapRefusal(
  settings: Pick<PersonaSettings, 'dailyLimit' | 'maxLive'>,
  counts: { mintedLast24h: number; live: number }
): string | null {
  if (counts.mintedLast24h >= settings.dailyLimit) {
    return `Persona mint limit reached (${settings.dailyLimit} per 24 hours)`;
  }
  if (counts.live >= settings.maxLive) return `Live persona limit reached (${settings.maxLive})`;
  return null;
}

/**
 * Mints in the last 24 hours, read from the append-only audit log rather than the users collection,
 * so deleting personas does not hand the day's allowance back.
 */
export async function countPersonaCaps(now: Date): Promise<{ mintedLast24h: number; live: number }> {
  const [mintedLast24h, live] = await Promise.all([
    adminAuditLogRepository.countActionsSince(['user.persona.created'], new Date(now.getTime() - DAY_MS)),
    User.countDocuments({ isPersona: true, isBanned: { $ne: true } }),
  ]);
  return { mintedLast24h, live };
}

export const personaExpiresAt = (now: Date, ttlDays: number) => new Date(now.getTime() + ttlDays * DAY_MS);

/** The audit actor for everything done with the persona key; there is no user behind it. */
export const PERSONA_KEY_ACTOR: AuditActor = {
  kind: 'script',
  scope: 'platform',
  name: 'Persona mint key',
  wasAdmin: false,
};

const PERSONA_SWEEP_ACTOR: AuditActor = {
  kind: 'system',
  scope: 'platform',
  name: 'Persona expiry sweep',
  wasAdmin: false,
};

/** Audit context for a persona-key request: a script caller, not the admin UI or a user API key. */
export const personaAuditContext = (req: Request): StoredAuditContext => ({
  ip: getClientIp(req),
  userAgent: req.headers['user-agent'],
  requestId: req.requestId,
  route: req.url?.split('?')[0],
  source: 'script',
});

export const personaAuditTarget = (user: { id: string; username?: string | null; email?: string | null }) => ({
  kind: 'user' as const,
  id: user.id,
  displayName: user.email || user.username || user.id,
});

/** Signs the persona out everywhere: tokenVersion bump, every refresh session, open sockets. */
export async function revokePersonaSessions(userId: string, logger?: Logger): Promise<void> {
  await userService.revokeUserSessions(userId, {
    db: {
      users: userRepository,
      authSessions: authSessionRepository,
      realtimeConnections: realtimeConnectionRepository,
    },
    logger,
  });
}

/** PersonaMintEnabled alone, for the sweep: it needs no domain check. */
export async function readPersonaMintEnabled(): Promise<boolean> {
  const settings = await getSettingsMap({ adminSettings: adminSettingsRepository }, { names: ['PersonaMintEnabled'] });
  return getSettingsValue('PersonaMintEnabled', settings, false) === true;
}

/**
 * Disables every persona whose `personaExpiresAt` has passed (or, with `all`, every live persona,
 * which is what turning PersonaMintEnabled off does): suspends it and signs it out everywhere.
 * Idempotent; the update is conditioned on the persona flag, so it can never suspend an ordinary
 * account. Run by the persona mint route before it counts the caps, and by the hourly
 * personaExpirySweep cron (apps/workers/src/cron/personaExpirySweep.ts).
 */
export async function disableExpiredPersonas(
  options: { now?: Date; all?: boolean; logger?: Logger; context?: StoredAuditContext } = {}
): Promise<{ disabled: number }> {
  const now = options.now ?? new Date();
  const expired = await User.find(
    {
      isPersona: true,
      isBanned: { $ne: true },
      ...(options.all ? {} : { personaExpiresAt: { $lte: now } }),
    },
    { _id: 1, username: 1, email: 1 }
  )
    .limit(SWEEP_BATCH)
    .lean();

  let disabled = 0;
  for (const doc of expired) {
    const id = String(doc._id);
    const result = await User.updateOne(
      { _id: doc._id, isPersona: true, isBanned: { $ne: true } },
      { $set: { isBanned: true } }
    );
    if (result.modifiedCount !== 1) continue;
    disabled++;
    try {
      await revokePersonaSessions(id, options.logger);
    } catch (error) {
      // Suspended already: the refresh gate refuses a banned account, so a failed revoke only delays sign-out.
      options.logger?.error('[PersonaExpiry] session revoke failed', { userId: id, error });
    }
    await adminAuditService.recordAdminAction(
      {
        action: 'user.persona.expired',
        actor: PERSONA_SWEEP_ACTOR,
        target: personaAuditTarget({ id, username: doc.username, email: doc.email }),
        summary: options.all
          ? `disabled test persona ${doc.username} (persona minting turned off)`
          : `disabled expired test persona ${doc.username}`,
        context: options.context ?? { source: 'worker' },
      },
      { db: { adminAuditLog: adminAuditLogRepository }, logger: options.logger }
    );
  }
  return { disabled };
}
