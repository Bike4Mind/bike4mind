import { createHash, randomBytes } from 'crypto';
import type { Request } from 'express';
import {
  ConflictError,
  PERSONA_NAME_PATTERN,
  hasDeveloperUserTag,
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
import { persistedIsAdmin } from '@bike4mind/server-utils/auth/apiKeyAdminScope';
import { recordAdminActionFromRequest } from '@bike4mind/server-utils/utils/adminAudit';
import { hardDeleteUser } from '@server/services/hardDeleteUser';
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
import { entitlementsForEmail } from '@bike4mind/server-utils/lib/entitlements/registry';
import { partnerSignupGrantForEmail } from '@bike4mind/server-utils/entitlements/partnerRules';

/** Every persona username the server builds matches this; nothing else is a persona. */
export const PERSONA_USERNAME_PATTERN = /^persona-[a-z0-9]{1,24}-\d+$/;

/** How long a persona login code stays redeemable. A bot redeems it within seconds of the mint. */
export const PERSONA_LOGIN_CODE_TTL_MS = 5 * 60 * 1000;

/** The login code's wire shape: 32 random bytes, base64url. Anything else is refused before a lookup. */
export const PERSONA_LOGIN_CODE_PATTERN = /^[A-Za-z0-9_-]{43}$/;

type PersonaCaller = Pick<IUserDocument, 'id' | 'tags' | 'isPersona' | 'isBanned'> & { isAdmin?: boolean | null };

/**
 * Whether the caller may mint or delete personas: an admin or a developer-tagged user, and never a
 * persona. Re-checked on every call, so removing the role or tag stops the owner's key at once.
 * Uses the persisted admin flag, because apiKeyAuth withholds isAdmin from keys without admin:*.
 */
export function canMintPersonas(user: PersonaCaller | null | undefined): boolean {
  if (!user || user.isPersona === true || user.isBanned === true) return false;
  return persistedIsAdmin(user as Parameters<typeof persistedIsAdmin>[0]) || hasDeveloperUserTag(user.tags);
}

/** Whether `user` may act on a persona owned by `ownerId`: its owner, or an admin. */
export function mayManagePersona(user: PersonaCaller, ownerId: string | null | undefined): boolean {
  return (!!ownerId && ownerId === user.id) || persistedIsAdmin(user as Parameters<typeof persistedIsAdmin>[0]);
}

export const hashPersonaLoginCode = (code: string) => createHash('sha256').update(code, 'utf8').digest('hex');

/**
 * Gives the persona a fresh single-use login code, replacing any pending one. Only the hash is
 * stored; the code itself is returned once, to the minting caller.
 */
export async function issuePersonaLoginCode(personaId: string, now: Date): Promise<{ code: string; expiresAt: Date }> {
  const code = randomBytes(32).toString('base64url');
  const expiresAt = new Date(now.getTime() + PERSONA_LOGIN_CODE_TTL_MS);
  const result = await User.updateOne(
    { _id: personaId, isPersona: true },
    { $set: { personaLoginCodeHash: hashPersonaLoginCode(code), personaLoginCodeExpiresAt: expiresAt } }
  );
  if (result.matchedCount !== 1) throw new ConflictError('This account is no longer a persona account');
  return { code, expiresAt };
}

/**
 * Consumes a login code atomically: the first redemption clears it, so a code signs in once. Returns
 * the persona, or null when the code is unknown, used, expired, or belongs to a disabled persona.
 */
export async function redeemPersonaLoginCode(code: string, now: Date) {
  if (!PERSONA_LOGIN_CODE_PATTERN.test(code)) return null;
  const user = await User.findOneAndUpdate(
    {
      personaLoginCodeHash: hashPersonaLoginCode(code),
      personaLoginCodeExpiresAt: { $gt: now },
      isPersona: true,
      isBanned: { $ne: true },
    },
    { $unset: { personaLoginCodeHash: 1, personaLoginCodeExpiresAt: 1 } },
    { new: true }
  ).lean();
  if (!user) return null;
  const persona = { ...user, id: String(user._id) };
  return isPersonaAccount(persona) ? persona : null;
}

/** The most recent persona minted under `name`, live or not, or null. */
export async function findPersonaByName(name: string) {
  const user = await User.findOne({ isPersona: true, personaName: name }).sort({ createdAt: -1 }).lean();
  return user ? { ...user, id: String(user._id) } : null;
}

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
  // These reads participate in the guarded mint transaction, so run them sequentially.
  const mintedLast24h = await adminAuditLogRepository.countActionsSince(
    ['user.persona.created'],
    new Date(now.getTime() - DAY_MS)
  );
  const live = await User.countDocuments({ isPersona: true, isBanned: { $ne: true } });
  return { mintedLast24h, live };
}

export const personaExpiresAt = (now: Date, ttlDays: number) => new Date(now.getTime() + ttlDays * DAY_MS);

const PERSONA_SWEEP_ACTOR: AuditActor = {
  kind: 'system',
  scope: 'platform',
  name: 'Persona expiry sweep',
  wasAdmin: false,
};

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

/**
 * Hard-deletes a persona: signs it out everywhere, then deletes through the shared hardDeleteUser
 * path, which re-checks the persona fence inside the transaction and writes the audit entry there.
 */
export async function deletePersonaAccount(
  req: Request,
  target: { id: string; username?: string | null; email?: string | null },
  summary: string
): Promise<void> {
  const id = target.id;
  await revokePersonaSessions(id, req.logger);
  await hardDeleteUser(
    id,
    {
      deletedBy: req.user?.id ?? 'persona-api',
      initiatedBy: 'admin',
      logger: req.logger,
      assertInTransaction: async () => {
        if (!isPersonaAccount(await userRepository.findById(id))) {
          throw new ConflictError('This account is no longer a persona account');
        }
      },
      recordInTransaction: async deleted => {
        const subject = deleted ?? target;
        await recordAdminActionFromRequest(req, {
          action: 'user.persona.deleted',
          target: personaAuditTarget({ id, username: subject.username, email: subject.email }),
          summary: `${summary} ${subject.username}`,
        });
      },
    },
    users => users.delete(id)
  );
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
