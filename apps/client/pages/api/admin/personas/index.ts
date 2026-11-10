import type { Request, Response } from 'express';
import { CURRENT_POLICY_VERSION } from '@bike4mind/common';
import {
  adminAuditLogRepository,
  isTransientTransactionError,
  userRepository,
  withTransaction,
} from '@bike4mind/database';
import { adminAuditService, userService } from '@bike4mind/services';
import { isProduction } from '@bike4mind/server-utils/utils/config';
import { rateLimit } from '@bike4mind/server-utils/middlewares/rateLimit';
import { asyncHandler } from '@server/middlewares/asyncHandler';
import { baseApi } from '@server/middlewares/baseApi';
import { issueSessionForRequest } from '@server/auth/issueSession';
import { ACCESS_TOKEN_TTL_SECONDS } from '@server/auth/tokenGenerator';
import {
  PERSONA_ADMIN_KEY_HEADER,
  isValidPersonaAdminKey,
  readPersonaAdminKey,
} from '@server/personas/personaAdminKey';
import {
  MintPersonaBodySchema,
  PERSONA_KEY_ACTOR,
  countPersonaCaps,
  disableExpiredPersonas,
  loadPersonaSettings,
  personaAuditContext,
  personaAuditTarget,
  personaCapRefusal,
  personaExpiresAt,
  personaIdentity,
} from '@server/personas/personaAccounts';

// The returned refresh token dies unused after a day; the expiry sweep revokes every session at expiresAt.
const MINTED_SESSION_IDLE_MS = 24 * 60 * 60 * 1000;

/**
 * POST /api/admin/personas - mint a synthetic test-persona account for QA bots, so they never go
 * through the public signup (and its Turnstile challenge). Authenticated only by the stage's
 * PERSONA_ADMIN_KEY in the x-persona-admin-key header: no session, no API key. Unset key = 404.
 *
 * The fence is server-side: the body is exactly `{ name }`, the server builds the username and the
 * email, forces isPersona/isSynthetic, grants no credits and no role. Mints are capped per 24 hours
 * and by live count (AdminSettings PersonaMintDailyLimit / PersonaMaxLive), and every mint is in the
 * admin audit log. Returns a session for that account only: a 30-minute access token and a refresh
 * token that expires after a day unused. DELETE is personas/[id].ts.
 */
const handler = baseApi({ auth: false })
  // Before the key check, so guessing at the key is throttled too.
  .use(rateLimit({ limit: 10, windowMs: 60 * 1000, bucket: 'admin-personas' }))
  .post(
    asyncHandler(async (req: Request, res: Response) => {
      const expectedKey = readPersonaAdminKey();
      if (!expectedKey) return res.status(404).json({ error: 'Not found' });
      if (!isValidPersonaAdminKey(req.headers[PERSONA_ADMIN_KEY_HEADER], expectedKey)) {
        return res.status(401).json({ error: 'Invalid persona admin key' });
      }

      const parsed = MintPersonaBodySchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        return res.status(400).json({ error: 'Body must be exactly { name }', details: parsed.error.issues });
      }
      const { name } = parsed.data;

      const settings = await loadPersonaSettings();
      const now = new Date();
      const identity = personaIdentity(name, { production: isProduction(), emailDomain: settings.emailDomain, now });
      if (!identity) {
        return res.status(503).json({ error: 'Persona minting is not configured on this stage (PersonaEmailDomain)' });
      }

      try {
        await disableExpiredPersonas({ now, logger: req.logger, context: personaAuditContext(req) });
      } catch (error) {
        // Expired personas still count as live, so a failed sweep can only make the cap stricter.
        req.logger.error('[PersonaMint] expiry sweep failed', { error });
      }
      const refusal = personaCapRefusal(settings, await countPersonaCaps(now));
      if (refusal) return res.status(429).json({ error: refusal });

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
                aupAcceptedVersion: CURRENT_POLICY_VERSION,
              },
            },
            { db: { users: userRepository } }
          );
          await adminAuditService.recordAdminAction(
            {
              action: 'user.persona.created',
              actor: PERSONA_KEY_ACTOR,
              target: personaAuditTarget(created),
              summary: `created test persona ${created.username}`,
              details: { username: created.username, expiresAt: expiresAt.toISOString() },
              context: personaAuditContext(req),
            },
            { db: { adminAuditLog: adminAuditLogRepository }, logger: req.logger }
          );
          return created;
        });
      } catch (error) {
        if (isTransientTransactionError(error)) throw error;
        if (error instanceof Error && error.message.includes('already in use')) {
          return res.status(409).json({ error: `A persona named "${name}" already exists on this stage` });
        }
        throw error;
      }

      const { accessToken, refreshToken } = await issueSessionForRequest(req, user.id, {
        createdVia: 'persona-mint',
        tokenVersion: user.tokenVersion ?? 0,
        refreshTtlMs: Math.min(MINTED_SESSION_IDLE_MS, expiresAt.getTime() - now.getTime()),
      });

      return res.status(201).json({
        user: { id: user.id, username: user.username, email: user.email, isPersona: true, expiresAt },
        accessToken,
        accessTokenExpiresInSeconds: ACCESS_TOKEN_TTL_SECONDS,
        refreshToken,
      });
    })
  );

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
