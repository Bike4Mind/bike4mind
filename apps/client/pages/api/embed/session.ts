/**
 * POST /api/embed/session
 *
 * Mints a short-lived embed session token from a long-lived embed:chat API key,
 * so the key secret never has to reach the browser. The caller presents the
 * embed key (server-to-server, or from the embedding site's backend); this
 * verifies it, then returns a token the widget forwards to POST /api/embed/chat.
 * The token - not the key - is the browser-held, rate-limited, revocable handle.
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
import { isOriginPermitted } from '@bike4mind/common';
import { randomUUID } from 'crypto';
import { flattenHeaders } from '@server/utils/flattenHeaders';
import { signEmbedSessionToken, EMBED_SESSION_TTL_SECONDS } from '@server/embed/embedSessionToken';

/** Per-IP flood backstop on this unauth mint surface. */
const MINT_RATE_LIMIT = 60;
const RATE_WINDOW_MS = 60_000;

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
    const origin = headers.origin;
    if (origin && !isOriginPermitted(origin, info.allowedOrigins)) {
      return res.status(403).json({ error: 'forbidden', error_description: 'Origin not allowed for this embed key' });
    }

    const token = signEmbedSessionToken(
      {
        keyId: info.keyId,
        agentId: info.agentId!,
        organizationId: info.organizationId!,
        sessionId: randomUUID(),
      },
      EMBED_SESSION_TTL_SECONDS
    );

    return res.status(200).json({
      session_token: token,
      token_type: 'Bearer',
      expires_in: EMBED_SESSION_TTL_SECONDS,
      agentId: info.agentId,
    });
  });

export const config = { api: { externalResolver: true } };
export default handler;
