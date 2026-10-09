/**
 * GET    /api/embed/history - the identified user's stored conversation with the bound agent
 * DELETE /api/embed/history - erase it
 *
 * Identified embed sessions only (a session token minted with `endUserId`, see
 * ./session.ts). An anonymous token has no history by design, so it gets a 403 rather
 * than an empty list that would read as "nothing yet".
 *
 * Unauthenticated at the baseApi layer (auth:false): the session token is verified
 * in-handler, and the bound key is re-loaded so a revoked key stops working at once
 * (same rule as the chat route in server/chatCompletion/external/embedRoute.ts).
 */

import { baseApi } from '@server/middlewares/baseApi';
import { rateLimit } from '@server/middlewares/rateLimit';
import { embedCors } from '@server/middlewares/embedCors';
import { flattenHeaders } from '@server/utils/flattenHeaders';
import type { EmbedSessionContext } from '@server/embed/embedSessionToken';
import { isEmbedOriginAllowed } from '@server/embed/firstPartyOrigin';
import { reauthorizeIdentifiedSession } from '@server/embed/identifiedEmbedUser';
import { extractBearer, resolveEmbedSessionToken } from '@server/embed/resolveEmbedSessionToken';
import { embedConversationRepository } from '@bike4mind/database';

/** Per-IP flood backstop; the widget reads history once per load. */
const HISTORY_RATE_LIMIT = 60;
const RATE_WINDOW_MS = 60_000;

type Resolved = { claims: EmbedSessionContext & { endUserId: string } } | { status: number; body: object };

async function resolveIdentifiedSession(
  rawHeaders: Parameters<typeof flattenHeaders>[0],
  logger: { warn: (message: string) => void }
): Promise<Resolved> {
  const headers = flattenHeaders(rawHeaders);
  const bearer = extractBearer(headers.authorization);
  if (!bearer) {
    return { status: 401, body: { error: 'unauthorized', error_description: 'Missing session token' } };
  }

  let resolved: Awaited<ReturnType<typeof resolveEmbedSessionToken>>;
  try {
    resolved = await resolveEmbedSessionToken(bearer);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Invalid session token';
    return { status: 401, body: { error: 'unauthorized', error_description: message } };
  }
  const { claims, info } = resolved;

  const origin = headers.origin && headers.origin !== 'null' ? headers.origin : undefined;
  if (origin && !isEmbedOriginAllowed(origin, info.allowedOrigins, headers.host)) {
    return { status: 403, body: { error: 'forbidden', error_description: 'Origin not allowed for this embed key' } };
  }

  const { endUserId, oauthClientId } = claims;
  if (!endUserId || !oauthClientId) {
    return {
      status: 403,
      body: { error: 'forbidden', error_description: 'History is available to identified embed sessions only' },
    };
  }
  const reauthorized = await reauthorizeIdentifiedSession({
    userId: endUserId,
    clientId: oauthClientId,
    allowedClientIds: info.identifiedClientIds,
    logger,
  });
  if ('rejection' in reauthorized) {
    const { status, ...body } = reauthorized.rejection;
    return { status, body };
  }
  return { claims: { ...claims, endUserId } };
}

const handler = baseApi({ auth: false })
  .use(embedCors({ methods: 'GET, DELETE, OPTIONS' }))
  .use(rateLimit({ limit: HISTORY_RATE_LIMIT, windowMs: RATE_WINDOW_MS, bucket: 'embed-history' }))
  .get(async (req, res) => {
    const resolved = await resolveIdentifiedSession(req.headers, req.logger);
    if ('status' in resolved) return res.status(resolved.status).json(resolved.body);
    const { endUserId, agentId } = resolved.claims;

    const messages = await embedConversationRepository.getMessages(endUserId, agentId);
    return res.status(200).json({
      agentId,
      messages: messages.map(m => ({ role: m.role, content: m.content, createdAt: m.createdAt })),
    });
  })
  .delete(async (req, res) => {
    const resolved = await resolveIdentifiedSession(req.headers, req.logger);
    if ('status' in resolved) return res.status(resolved.status).json(resolved.body);
    const { endUserId, agentId } = resolved.claims;

    await embedConversationRepository.deleteConversation(endUserId, agentId);
    return res.status(204).end();
  });

export const config = { api: { externalResolver: true } };
export default handler;
