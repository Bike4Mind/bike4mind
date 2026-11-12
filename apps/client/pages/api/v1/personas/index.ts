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
import { AdminSettings, isTransientTransactionError, userRepository, withTransaction } from '@bike4mind/database';
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
    const login = await issuePersonaLoginCode(persona.id, new Date());
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

  // The shared setting write serializes all name/cap decisions with creation. It also conflicts
  // with disabling the endpoint. Every transaction retry re-reads the name and rolling counts.
  for (let cleanupAttempt = 0; cleanupAttempt < 3; cleanupAttempt++) {
    try {
      const outcome = await withTransaction(async () => {
        const guard = await AdminSettings.updateOne(
          { settingName: 'PersonaMintEnabled', settingValue: true },
          { $inc: { __v: 1 } }
        );
        if (guard.matchedCount !== 1) return { kind: 'off' as const };
        const attemptNow = new Date();
        const existing = await findPersonaByName(name);
        if (existing) {
          if (existing.isBanned === true || isPersonaExpired(existing, attemptNow)) {
            return { kind: 'delete' as const, persona: existing };
          }
          if (existing.personaOwnerId !== req.user.id) return { kind: 'conflict' as const };
          return { kind: 'ready' as const, status: 200 as const, persona: existing };
        }
        const refusal = personaCapRefusal(settings, await countPersonaCaps(attemptNow));
        if (refusal) return { kind: 'limited' as const, error: refusal };
        const identity = personaIdentity(name, {
          production: isProduction(),
          emailDomain: settings.emailDomain,
          now: attemptNow,
        });
        if (!identity) return { kind: 'unconfigured' as const };
        const expiresAt = personaExpiresAt(attemptNow, settings.ttlDays);
        const created = await userService.createUser(
          {
            username: identity.username,
            email: identity.email,
            name: `Persona ${name}`,
            isAdmin: false,
            initialCredits: settings.startingCredits,
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
          details: {
            username: created.username,
            expiresAt: expiresAt.toISOString(),
            startingCredits: settings.startingCredits,
          },
        });
        return {
          kind: 'ready' as const,
          status: 201 as const,
          persona: { id: created.id, username: created.username, email: created.email, personaExpiresAt: expiresAt },
        };
      });
      switch (outcome.kind) {
        case 'off':
          return res.status(404).json({ error: 'Not found', errorCode: PERSONA_ENDPOINT_OFF_CODE });
        case 'unconfigured':
          return res.status(503).json({ error: 'Persona minting is not configured on this deployment' });
        case 'conflict':
          return res.status(409).json({ error: `Another user holds a live persona named "${name}"` });
        case 'limited':
          return res.status(429).json({ error: outcome.error });
        case 'ready':
          return respond(outcome.status, outcome.persona);
        case 'delete':
          // Deletion can revoke sessions and cancel subscriptions. Keep those effects outside the
          // retried transaction, then start a fresh guarded lookup rather than reuse this decision.
          await deletePersonaAccount(req, outcome.persona, 'removed disabled test persona before re-minting');
      }
    } catch (error) {
      if (isTransientTransactionError(error)) throw error;
      if (isDuplicateKeyError(error) || (error instanceof Error && error.message.includes('already in use'))) {
        return res.status(409).json({ error: `A persona named "${name}" already exists on this deployment` });
      }
      throw error;
    }
  }
  return res.status(409).json({ error: 'Persona changed during cleanup; retry the request' });
});

export const config = {
  api: { externalResolver: true },
};

export default route;
