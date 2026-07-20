import jwt from 'jsonwebtoken';
import { z } from 'zod';
import { Config } from '@server/utils/config';

// Embed session token - a short-lived signed JWT minted by POST /api/embed/session
// so the long-lived embed API key secret never reaches the browser. The widget
// forwards this token to the chat route, which trusts ONLY the claims inside the
// verified token (never raw request-body fields), so a caller cannot swap the
// bound agent or organization by supplying their own ids.
//
// Audience scopes the token to the embed chat surface, so a leaked token can't be
// replayed against other JWT-accepting routes (login, websocket, CLI, voice).
//
// Revocation: this token is only a short-lived session handle, not a standalone
// bearer of the key's authority. The chat route re-loads the live key by id on
// every request (verifyEmbedKeyById re-checks ACTIVE + expiry + scope + the
// credential class), so a revoked/expired key or an allowedOrigins edit takes
// effect immediately - not TTL-bounded. The short TTL is a backstop, not the
// revocation mechanism.
const EMBED_TOKEN_AUDIENCE = 'embed-chat';

/** Session token lifetime. Short as a backstop on a leaked token (see revocation note). */
export const EMBED_SESSION_TTL_SECONDS = 5 * 60; // 300s

export const EmbedSessionContextSchema = z.object({
  keyId: z.string().min(1),
  agentId: z.string().min(1),
  organizationId: z.string().min(1),
  /** Fresh per mint; the per-session rate-limit and abuse-attribution handle. */
  sessionId: z.string().min(1),
});

export type EmbedSessionContext = z.infer<typeof EmbedSessionContextSchema>;

/** Sign a session-bound embed token valid for `ttlSeconds`. */
export function signEmbedSessionToken(ctx: EmbedSessionContext, ttlSeconds: number): string {
  // Parse first so only the known claims are embedded - never stray fields.
  const payload: EmbedSessionContext = EmbedSessionContextSchema.parse(ctx);
  return jwt.sign(payload, Config.JWT_SECRET, {
    audience: EMBED_TOKEN_AUDIENCE,
    expiresIn: ttlSeconds,
  });
}

/**
 * Verify and decode an embed session token. Throws (JsonWebTokenError /
 * TokenExpiredError / ZodError) if the signature, audience, expiry, or claim
 * shape is invalid.
 */
export function verifyEmbedSessionToken(token: string): EmbedSessionContext {
  const decoded = jwt.verify(token, Config.JWT_SECRET, { audience: EMBED_TOKEN_AUDIENCE });
  return EmbedSessionContextSchema.parse(decoded);
}
