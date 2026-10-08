/**
 * POST /api/embed/session
 *
 * Mints a short-lived embed session token from a long-lived embed:chat API key.
 * The caller presents the embed key (the served /embed/* widget page, or the
 * embedding site's backend); this verifies it, then returns a token the widget
 * forwards to POST /api/embed/chat, so the key itself never rides the per-turn
 * chat requests. The token is the rate-limited, revocable handle.
 *
 * Identified mode: when the body carries `{ client_id, client_secret, id_token }`, the
 * embedding site's backend is handing over its already-authenticated user. The token
 * is then bound to that B4M user (`endUserId`), who pays from their own balance and
 * whose conversation persists across visits. The key must list the client in
 * `identifiedClientIds`. See server/embed/identifiedEmbedUser.ts.
 * The client_secret makes this a server-to-server call only; a browser Origin on an
 * identified mint is refused.
 *
 * Unauthenticated at the baseApi layer (auth:false): the embed key is verified
 * in-handler via verifyEmbedApiKey, NOT the apiKeyAuth middleware (which would
 * populate the Express req.apiKeyInfo shape that does not carry agentId/
 * allowedOrigins).
 */

import { baseApi } from '@server/middlewares/baseApi';
import { rateLimit } from '@server/middlewares/rateLimit';
import { embedCors } from '@server/middlewares/embedCors';
import { verifyEmbedApiKey } from '@server/cli/auth';
import { randomUUID } from 'crypto';
import { flattenHeaders } from '@server/utils/flattenHeaders';
import { signEmbedSessionToken, EMBED_SESSION_TTL_SECONDS } from '@server/embed/embedSessionToken';
import { isEmbedOriginAllowed } from '@server/embed/firstPartyOrigin';
import { IdentifiedEmbedMintSchema, resolveIdentifiedEmbedUser } from '@server/embed/identifiedEmbedUser';
import { cacheRepository } from '@bike4mind/database';
import { UserApiKeyAuditLog } from '@bike4mind/database/auth';

/** Per-IP flood backstop on this unauth mint surface. */
const MINT_RATE_LIMIT = 60;
const RATE_WINDOW_MS = 60_000;
/** Per-client identified-mint budget; same ceiling as the AI-token exchange. */
const PER_CLIENT_IDENTIFIED_RATE_LIMIT = 300;

const handler = baseApi({ auth: false })
  .use(embedCors())
  .use(rateLimit({ limit: MINT_RATE_LIMIT, windowMs: RATE_WINDOW_MS, bucket: 'embed-session-mint' }))
  .post(async (req, res) => {
    const headers = flattenHeaders(req.headers);

    let info;
    try {
      info = await verifyEmbedApiKey(headers);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Invalid embed key';
      return res.status(401).json({ error: 'unauthorized', error_description: message });
    }

    // Defense-in-depth: if a browser Origin is present it must be on the key's
    // allow-list. A non-browser caller (no Origin) is gated by the key alone.
    // `Origin: null` (sandboxed iframe) is treated as absent, matching the chat
    // route - the credential is the boundary, so a hard 403 here would only break
    // a legitimate sandboxed embed without stopping anyone. Our own serving
    // origin is implicitly permitted: the /embed/* widget page mints from the app
    // host, which can never appear on an allow-list (see firstPartyOrigin.ts).
    const origin = headers.origin && headers.origin !== 'null' ? headers.origin : undefined;
    if (origin && !isEmbedOriginAllowed(origin, info.allowedOrigins, headers.host)) {
      return res.status(403).json({ error: 'forbidden', error_description: 'Origin not allowed for this embed key' });
    }

    // Only the presence of id_token selects identified mode; a partial identified body
    // is a client error, never a silent fallback to an anonymous (org-billed) session.
    const body: unknown = req.body;
    const wantsIdentified = !!body && typeof body === 'object' && 'id_token' in body;
    let endUserId: string | undefined;
    let oauthClientId: string | undefined;
    if (wantsIdentified) {
      if (headers.origin) {
        return res.status(400).json({
          error: 'invalid_request',
          error_description: 'Identified embed sessions must be minted server-to-server',
        });
      }
      const parsed = IdentifiedEmbedMintSchema.safeParse(body);
      if (!parsed.success) {
        return res.status(400).json({ error: 'invalid_request', error_description: parsed.error.message });
      }
      const { client_id } = parsed.data;
      const resolved = await resolveIdentifiedEmbedUser(parsed.data, info.identifiedClientIds, req.logger);
      if ('rejection' in resolved) {
        const { status, ...rejection } = resolved.rejection;
        return res.status(status).json(rejection);
      }
      // After the client is authenticated, so failed-secret probes cannot burn a real
      // client's budget (same ordering as pages/api/oauth/ai-token.ts).
      const rl = await cacheRepository.tryIncrementWithinLimitFixedWindow(
        `rate-limit:embed-identified-mint:${client_id}`,
        PER_CLIENT_IDENTIFIED_RATE_LIMIT,
        RATE_WINDOW_MS
      );
      if (!rl.success) {
        const retryAfter = Math.max(1, Math.ceil((rl.expiresAt.getTime() - Date.now()) / 1000));
        res.setHeader('Retry-After', retryAfter);
        return res.status(429).json({
          error: 'rate_limited',
          error_description: `Rate limit exceeded. Try again in ${retryAfter} seconds.`,
        });
      }
      endUserId = resolved.userId;
      oauthClientId = client_id;
      await UserApiKeyAuditLog.create({
        action: 'mint',
        keyId: info.keyId,
        actorUserId: endUserId,
        actorUserAgent: headers['user-agent'],
        details: { clientId: client_id, flow: 'embed-identified-session' },
      });
    }

    const token = signEmbedSessionToken(
      {
        keyId: info.keyId,
        agentId: info.agentId!,
        organizationId: info.organizationId!,
        sessionId: randomUUID(),
        ...(endUserId && { endUserId, oauthClientId }),
      },
      EMBED_SESSION_TTL_SECONDS
    );

    return res.status(200).json({
      session_token: token,
      token_type: 'Bearer',
      expires_in: EMBED_SESSION_TTL_SECONDS,
      agentId: info.agentId,
      mode: endUserId ? 'identified' : 'anonymous',
    });
  });

export const config = { api: { externalResolver: true } };
export default handler;
