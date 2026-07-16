import express, { type Request, type Response, type Express } from 'express';
import {
  buildMetaEvent,
  buildSSEEvent,
  formatSSEError,
  isOriginPermitted,
  resolveRequestId,
  serializeSSEEvent,
  SSE_DONE_SIGNAL,
  SSE_KEEPALIVE,
  REQUEST_ID_HEADER,
  LEGACY_REQUEST_ID_HEADER,
  getQuestErrorCode,
  type IMessage,
} from '@bike4mind/common';
import { Logger } from '@bike4mind/observability';
import { executeCompletion, assertOwnerHasCredits } from '@bike4mind/services';
import {
  connectDB,
  mongoose,
  adminSettingsRepository,
  apiKeyRepository,
  creditTransactionRepository,
  userRepository,
  usageEventRepository,
  organizationRepository,
  agentRepository,
} from '@bike4mind/database';
import { verifyEmbedApiKey, verifyEmbedKeyById } from '@server/cli/auth';
import { verifyEmbedSessionToken } from '@server/embed/embedSessionToken';
import { checkApiKeyRateLimit } from '@server/utils/apiKeyRateLimitCheck';
import { checkEmbedSessionRateLimit } from '@server/utils/embedSessionRateLimit';
import { embedCors } from '@server/middlewares/embedCors';
import { hydrateEmbedAgent } from './embedAgentHydration';
import { Config } from '@server/utils/config';
import { z } from 'zod';

/**
 * Public embed chat endpoint (`POST /api/embed/chat`), served by the always-on
 * ChatCompletion service (Fargate) so the SSE stream isn't bounded by a Lambda
 * timeout. Runs a *configured agent* (persona hydrated from AgentModel) for an
 * anonymous end-user, billing the embed key's organization. Reachable by
 * browsers only via CloudFront (M6 wires the route + Origin/OPTIONS forwarding).
 *
 * Unlike the CLI completions route, all auth/origin/balance/rate-limit gates run
 * BEFORE any SSE bytes flush, so a rejection returns a real HTTP status (401/403/
 * 422/429) instead of an SSE error frame. Only failures once the stream is open
 * (mid-completion) surface as SSE errors.
 *
 * Stateless: end-user turns are never persisted to any owner's session history -
 * the route never passes a sessionId and never calls persistRunAsQuest.
 */

const EMBED_CHAT_ENDPOINT = '/api/embed/chat';
const HEARTBEAT_INTERVAL_MS = 10_000;

const EmbedChatRequestSchema = z.object({
  messages: z.array(z.object({ role: z.enum(['user', 'assistant', 'system']), content: z.string() })).min(1),
  /** Optional echo of the bound agent id; if present it MUST match the key's agent. */
  agentId: z.string().optional(),
  stream: z.boolean().optional(),
});

interface EmbedContext {
  keyId: string;
  userId: string;
  agentId: string;
  organizationId: string;
  allowedOrigins?: string[];
  rateLimit: { requestsPerMinute: number; requestsPerDay: number };
  /** Present only on the session-token path; enables the per-session rate limit. */
  sessionId?: string;
}

function flattenHeaders(headers: Request['headers']): Record<string, string | undefined> {
  const flat: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(headers)) {
    flat[key.toLowerCase()] = Array.isArray(value) ? value[0] : value;
  }
  return flat;
}

/**
 * Resolve tenant/owner/agent SOLELY from the credential - never the request body.
 * Two paths, both ending at a freshly-loaded, re-validated key:
 *   - session token (browser): verify the token, then re-load the key by id so a
 *     token cannot outlive a revoked/disabled key within its TTL.
 *   - raw embed key (server-to-server): verifyEmbedApiKey.
 * @throws Error (mapped to 401 by the caller) on any invalid credential.
 */
async function resolveEmbedContext(headers: Record<string, string | undefined>): Promise<EmbedContext> {
  const auth = headers.authorization;
  const bearer = auth && /^bearer /i.test(auth) ? auth.slice(7).trim() : undefined;

  // A bearer that is NOT a raw b4m_ key is the minted session token.
  if (bearer && !bearer.startsWith('b4m_')) {
    const claims = verifyEmbedSessionToken(bearer);
    const info = await verifyEmbedKeyById(claims.keyId);
    if (info.agentId !== claims.agentId || info.organizationId !== claims.organizationId) {
      throw new Error('Session token does not match the embed key');
    }
    return {
      keyId: info.keyId,
      userId: info.userId,
      agentId: info.agentId!,
      organizationId: info.organizationId!,
      allowedOrigins: info.allowedOrigins,
      rateLimit: info.rateLimit,
      sessionId: claims.sessionId,
    };
  }

  const info = await verifyEmbedApiKey(headers);
  return {
    keyId: info.keyId,
    userId: info.userId,
    agentId: info.agentId!,
    organizationId: info.organizationId!,
    allowedOrigins: info.allowedOrigins,
    rateLimit: info.rateLimit,
  };
}

/**
 * Register `POST /api/embed/chat` (and its OPTIONS preflight) on the
 * ChatCompletion Express app. `track` joins the SIGTERM drain set (see sseRoute).
 */
export function registerEmbedRoutes(app: Express, track: (p: Promise<void>) => void): void {
  app.options(EMBED_CHAT_ENDPOINT, embedCors());

  app.post(EMBED_CHAT_ENDPOINT, embedCors(), express.json({ limit: '1mb' }), async (req: Request, res: Response) => {
    const done = new Promise<void>(resolve => {
      res.on('finish', resolve);
      res.on('close', resolve);
    });
    track(done);

    const headers = flattenHeaders(req.headers);
    const requestId = resolveRequestId(
      headers[REQUEST_ID_HEADER.toLowerCase()],
      headers[LEGACY_REQUEST_ID_HEADER.toLowerCase()]
    );
    const logger = new Logger({ metadata: { service: 'chatCompletion', endpoint: EMBED_CHAT_ENDPOINT, requestId } });

    let streaming = false;
    const write = (chunk: string) => {
      if (!res.writableEnded) res.write(chunk);
    };

    try {
      if (mongoose.connection.readyState !== 1) {
        await connectDB(Config.MONGODB_URI.replace('%STAGE%', Config.STAGE), logger);
      }

      // --- Pre-stream gates (real HTTP status codes) ---

      let ctx: EmbedContext;
      try {
        ctx = await resolveEmbedContext(headers);
      } catch (authErr) {
        const message = authErr instanceof Error ? authErr.message : 'Unauthorized';
        return res.status(401).json({ error: 'unauthorized', error_description: message });
      }

      // Origin gate (defense-in-depth for browsers; the credential is the boundary).
      if (headers.origin && !isOriginPermitted(headers.origin, ctx.allowedOrigins)) {
        return res.status(403).json({ error: 'forbidden', error_description: 'Origin not allowed for this embed key' });
      }

      const parsed = EmbedChatRequestSchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        return res.status(400).json({ error: 'invalid_request', error_description: parsed.error.message });
      }
      const body = parsed.data;

      // A request-supplied agentId may only echo the key's bound agent, never redirect it.
      if (body.agentId && body.agentId !== ctx.agentId) {
        return res.status(403).json({ error: 'forbidden', error_description: 'agentId does not match the embed key' });
      }

      // Resolve the agent SOLELY from the key. Reject deleted or cross-tenant agents.
      const agent = await agentRepository.findById(ctx.agentId);
      if (!agent || agent.deletedAt) {
        return res.status(404).json({ error: 'not_found', error_description: 'Bound agent not found' });
      }
      if (
        (agent.organizationId && agent.organizationId !== ctx.organizationId) ||
        (agent.userId && agent.userId !== ctx.userId)
      ) {
        return res.status(403).json({ error: 'forbidden', error_description: 'Agent is not owned by the embed key' });
      }

      const hydrated = hydrateEmbedAgent(agent);
      if (!hydrated.model) {
        return res
          .status(422)
          .json({ error: 'unprocessable', error_description: 'Bound agent has no configured model' });
      }

      // Unconditional pre-flight balance check against the owner org (runs even when
      // enforceCredits is off). Must precede any stream bytes so it can 422.
      const org = await organizationRepository.findById(ctx.organizationId);
      try {
        assertOwnerHasCredits(org);
      } catch (creditErr) {
        const status = (creditErr as { statusCode?: number }).statusCode ?? 422;
        return res.status(status).json({
          error: 'insufficient_credits',
          error_description: creditErr instanceof Error ? creditErr.message : 'Insufficient credits',
          code: getQuestErrorCode(creditErr),
        });
      }

      // Rate limits: per-key always; per-session additionally on the token path.
      const keyRl = await checkApiKeyRateLimit(ctx.keyId, ctx.rateLimit, {
        userId: ctx.userId,
        endpoint: EMBED_CHAT_ENDPOINT,
        method: req.method,
      });
      if (!keyRl.allowed) {
        if (keyRl.retryAfter) res.setHeader('Retry-After', keyRl.retryAfter);
        return res.status(429).json({ error: 'rate_limited', error_description: keyRl.error });
      }
      if (ctx.sessionId) {
        const sessionRl = await checkEmbedSessionRateLimit(ctx.sessionId, ctx.rateLimit);
        if (!sessionRl.allowed) {
          if (sessionRl.retryAfter) res.setHeader('Retry-After', sessionRl.retryAfter);
          return res.status(429).json({ error: 'rate_limited', error_description: sessionRl.error });
        }
      }

      // --- All gates passed: open the SSE stream ---
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache, no-transform');
      res.setHeader('Connection', 'keep-alive');
      res.flushHeaders();
      streaming = true;
      write(SSE_KEEPALIVE);
      write(serializeSSEEvent(buildMetaEvent(requestId)));
      const heartbeat = setInterval(() => write(SSE_KEEPALIVE), HEARTBEAT_INTERVAL_MS);

      try {
        await executeCompletion({
          userId: ctx.userId,
          model: hydrated.model,
          messages: body.messages as IMessage[],
          options: { temperature: hydrated.temperature, maxTokens: hydrated.maxTokens, stream: true },
          // Persona hydrated from the agent - the embed run's configured behavior.
          systemPrompt: hydrated.systemPrompt,
          db: {
            adminSettings: adminSettingsRepository,
            apiKeys: apiKeyRepository,
            creditTransactions: creditTransactionRepository,
            users: userRepository,
            usageEvents: usageEventRepository,
            organizations: organizationRepository,
          },
          apiKeyInfo: { keyId: ctx.keyId, keyName: 'embed' },
          // Bill the owner org's pool (ownerType: Organization).
          billingOrganizationId: ctx.organizationId,
          // Meter org usage even on a stage with enforceCredits off.
          alwaysRecordUsage: true,
          requestId,
          source: 'api',
          logger,
          onChunk: async (text, info) => {
            write(serializeSSEEvent(buildSSEEvent(text, info)));
          },
        });
        write(SSE_DONE_SIGNAL);
      } finally {
        clearInterval(heartbeat);
      }
      if (!res.writableEnded) res.end();
    } catch (error) {
      logger.error('[EMBED_CHAT] Handler error', {
        error: error instanceof Error ? error.message : String(error),
      });
      if (streaming) {
        write(serializeSSEEvent(formatSSEError(error, requestId)));
        if (!res.writableEnded) res.end();
      } else if (!res.headersSent) {
        res.status(500).json({ error: 'internal_error', error_description: 'Failed to process embed chat request' });
      }
    }
  });
}
