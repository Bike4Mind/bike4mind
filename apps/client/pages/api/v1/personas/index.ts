/**
 * POST /api/v1/personas - mint a throwaway test-persona account for QA bots, or hand back the
 * caller's live persona of that name, with a single-use login code. The code is redeemed at
 * pages/api/personas/redeem.ts: this route never issues a session itself, because a route an API
 * key can reach must not (sessionGrantRoutesRejectApiKeys.test.ts).
 *
 * Callers: admins and developer-tagged users only, by JWT or by a key with personas:mint, re-checked
 * here on every call. The fence is server-side: the server builds the username and email, forces
 * isPersona/isSynthetic, and grants no credits and no role. Mints are capped per 24 hours and by
 * live count (AdminSettings PersonaMintDailyLimit / PersonaMaxLive) and audited.
 */
import {
  CURRENT_POLICY_VERSION,
  PERSONA_ENDPOINT_OFF_CODE,
  PERSONA_REDEEM_PATH,
  mintPersonaContract,
} from '@bike4mind/common';
import { cacheRepository, isTransientTransactionError, userRepository, withTransaction } from '@bike4mind/database';
import { userService } from '@bike4mind/services';
import { isPersonaExpired } from '@bike4mind/services/userService/accountState';
import { isProduction } from '@bike4mind/server-utils/utils/config';
import { ForbiddenError } from '@bike4mind/server-utils/utils/errors';
import { recordAdminActionFromRequest } from '@bike4mind/server-utils/utils/adminAudit';
import { nextRouteForContract } from '@server/middlewares/defineNextRoute';
import { perUserRateLimit } from '@server/middlewares/perUserRateLimit';
import {
  canMintPersonas,
  countPersonaCaps,
  deletePersonaAccount,
  disableExpiredPersonas,
  findPersonaByName,
  issuePersonaLoginCode,
  loadPersonaSettings,
  personaAuditTarget,
  personaCapRefusal,
  personaExpiresAt,
  personaIdentity,
} from '@server/personas/personaAccounts';

const DAY_MS = 24 * 60 * 60 * 1000;
// One counter for every minter, incremented atomically, so concurrent mints cannot all pass the
// audit-log count before any of them commits.
const MINT_RESERVATION_KEY = 'persona-mint:daily-reservations';

const isDuplicateKeyError = (error: unknown) =>
  typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 11000;

const route = nextRouteForContract(mintPersonaContract, {
  rateLimit: perUserRateLimit('POST /api/v1/personas'),
}).post(async (req, res) => {
  if (!canMintPersonas(req.user)) throw new ForbiddenError('Only admins and developers can mint test personas');

  const { name } = req.validated;
  const settings = await loadPersonaSettings(req.logger);
  if (!settings.enabled) {
    return res.status(404).json({ error: 'Not found', errorCode: PERSONA_ENDPOINT_OFF_CODE });
  }
  const now = new Date();
  const identity = personaIdentity(name, { production: isProduction(), emailDomain: settings.emailDomain, now });
  if (!identity) {
    return res
      .status(503)
      .json({ error: 'Persona minting is not configured on this deployment (PersonaEmailDomain unset or refused)' });
  }

  try {
    await disableExpiredPersonas({ now, logger: req.logger });
  } catch (error) {
    // Expired personas still count as live, so a failed sweep can only make the cap stricter.
    req.logger.error('[PersonaMint] expiry sweep failed', { error });
  }

  const respond = async (
    status: 200 | 201,
    persona: { id: string; username: string; email: string | null; personaExpiresAt?: Date | null }
  ) => {
    const login = await issuePersonaLoginCode(persona.id, now);
    return res.status(status).json({
      persona: {
        id: persona.id,
        username: persona.username,
        email: persona.email ?? '',
        expires_at: (persona.personaExpiresAt ?? now).toISOString(),
      },
      created: status === 201,
      login_code: login.code,
      login_code_expires_at: login.expiresAt.toISOString(),
      login_path: `${PERSONA_REDEEM_PATH}?code=${login.code}`,
    });
  };

  const existing = await findPersonaByName(name);
  if (existing) {
    const live = existing.isBanned !== true && !isPersonaExpired(existing, now);
    if (live) {
      if (existing.personaOwnerId !== req.user.id) {
        return res.status(409).json({ error: `Another user holds a live persona named "${name}"` });
      }
      return respond(200, existing);
    }
    // A disabled persona still holds its name and, on production, its mailbox.
    await deletePersonaAccount(req, existing, 'removed disabled test persona before re-minting');
  }

  const refusal = personaCapRefusal(settings, await countPersonaCaps(now));
  if (refusal) return res.status(429).json({ error: refusal });
  const reservation = await cacheRepository.tryIncrementWithinLimitFixedWindow(
    MINT_RESERVATION_KEY,
    settings.dailyLimit,
    DAY_MS
  );
  if (!reservation.success) {
    return res.status(429).json({ error: `Persona mint limit reached (${settings.dailyLimit} per 24 hours)` });
  }

  const expiresAt = personaExpiresAt(now, settings.ttlDays);
  let user: Awaited<ReturnType<typeof userService.createUser>>;
  try {
    // The audit row commits with the account, so no persona exists unaudited.
    user = await withTransaction(async () => {
      const created = await userService.createUser(
        {
          username: identity.username,
          email: identity.email,
          name: `Persona ${name}`,
          isAdmin: false,
          initialCredits: 0,
          tags: [],
          // The server owns the address, so there is nothing for the persona to prove.
          emailVerified: true,
          // The persona- prefix is reserved for exactly this kind of account.
          allowReservedUsername: true,
          record: {
            password: null,
            hasUsablePassword: false,
            isPersona: true,
            isSynthetic: true,
            personaExpiresAt: expiresAt,
            personaName: name,
            personaOwnerId: req.user.id,
            aupAcceptedVersion: CURRENT_POLICY_VERSION,
          },
        },
        { db: { users: userRepository } }
      );
      await recordAdminActionFromRequest(req, {
        action: 'user.persona.created',
        target: personaAuditTarget(created),
        summary: `created test persona ${created.username}`,
        details: { username: created.username, expiresAt: expiresAt.toISOString() },
      });
      return created;
    });
  } catch (error) {
    if (isTransientTransactionError(error)) throw error;
    if (isDuplicateKeyError(error) || (error instanceof Error && error.message.includes('already in use'))) {
      return res.status(409).json({ error: `A persona named "${name}" already exists on this deployment` });
    }
    throw error;
  }

  return respond(201, { id: user.id, username: user.username, email: user.email, personaExpiresAt: expiresAt });
});

export const config = {
  api: { externalResolver: true },
};

export default route;
