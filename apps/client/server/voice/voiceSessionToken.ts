import jwt from 'jsonwebtoken';
import { z } from 'zod';
import { AuthOriginSchema, type AuthOrigin } from '@bike4mind/common';
import { Config } from '@server/utils/config';

// Voice v2 session token - a short-lived signed JWT that binds an ElevenLabs
// voice call to a specific B4M user/session. It is minted by POST /sessions and
// forwarded by the browser to ElevenLabs as `custom_llm_extra_body.b4m_session`;
// ElevenLabs echoes it on every Custom-LLM request to the proxy, which verifies
// it. The proxy trusts ONLY the claims inside the verified token - never raw
// request-body fields - so a caller who reaches the proxy URL cannot impersonate
// another user by supplying their userId.
//
// Audience scopes the token to this one endpoint so a leaked token can't be
// replayed against other JWT-accepting routes (login, websocket, CLI auth).
const VOICE_TOKEN_AUDIENCE = 'voice-v2-llm-proxy';

export const VoiceSessionContextSchema = z
  .object({
    userId: z.string().min(1),
    organizationId: z.string(),
    sessionId: z.string().min(1),
    reasoningModelId: z.string().min(1),
    // How the minting request was authenticated; the proxy forwards it to the turn's tools
    // (ToolContext.authOrigin). Optional on the wire only for a token minted before the claim existed
    // (see the transform); signVoiceSessionToken takes the transform's output type, which requires it.
    authOrigin: AuthOriginSchema.optional(),
    // The `b4m_live_` key that minted the token, when one did, forwarded as ToolContext.apiKeyId.
    apiKeyId: z.string().min(1).optional(),
    // ISO start of the credit hold this call bills against, so its activity marks only that hold.
    // Optional: tokens minted before the claim existed still verify until they expire.
    // Follow-up: make it required once one token TTL has passed after deploy, deleting the proxy's claimless branch.
    voiceHoldStartedAt: z.string().datetime().optional(),
  })
  // A pre-claim token carried the key id alone: keep it a key turn, and fail anything else closed.
  .transform((ctx): typeof ctx & { authOrigin: AuthOrigin } => ({
    ...ctx,
    authOrigin: ctx.authOrigin ?? (ctx.apiKeyId ? 'apiKey' : 'internal'),
  }));

export type VoiceSessionContext = z.infer<typeof VoiceSessionContextSchema>;

/** Sign a session-bound token valid for `ttlSeconds`. */
export function signVoiceSessionToken(ctx: VoiceSessionContext, ttlSeconds: number): string {
  // Spread only the known claims so we never accidentally embed extra fields.
  const payload: VoiceSessionContext = VoiceSessionContextSchema.parse(ctx);
  return jwt.sign(payload, Config.JWT_SECRET, {
    audience: VOICE_TOKEN_AUDIENCE,
    expiresIn: ttlSeconds,
  });
}

/**
 * Verify and decode a session token. Throws (JsonWebTokenError / TokenExpiredError
 * / ZodError) if the signature, audience, expiry, or claim shape is invalid.
 */
export function verifyVoiceSessionToken(token: string): VoiceSessionContext {
  const decoded = jwt.verify(token, Config.JWT_SECRET, { audience: VOICE_TOKEN_AUDIENCE });
  return VoiceSessionContextSchema.parse(decoded);
}
