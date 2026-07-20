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
  userApiKeyRepository,
} from '@bike4mind/database';
import { verifyEmbedApiKey, verifyEmbedKeyById, type ApiKeyInfo } from '@server/cli/auth';
import { verifyEmbedSessionToken } from '@server/embed/embedSessionToken';
import { checkApiKeyRateLimit } from '@server/utils/apiKeyRateLimitCheck';
import { checkEmbedSessionRateLimit } from '@server/utils/embedSessionRateLimit';
import { embedCors } from '@server/middlewares/embedCors';
import { flattenHeaders } from '@server/utils/flattenHeaders';
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
  // Only user/assistant turns from the client. The system persona is set
  // server-side from the bound agent (prepended below); allowing a client
  // `system` turn would let an anonymous end-user override the configured
  // agent's constraints, which defeats the point of a constrained embed agent.
  // Content must be non-empty, and the last turn must be the user's - both are
  // rejected here as a clean 400 rather than surfacing as a mid-stream provider
  // error (most backends require a non-empty, user-terminated conversation).
  messages: z
    .array(z.object({ role: z.enum(['user', 'assistant']), content: z.string().min(1) }))
    .min(1)
    .refine(m => m[m.length - 1]?.role === 'user', { message: 'the last message must be from the user' }),
  /** Optional echo of the bound agent id; if present it MUST match the key's agent. */
  agentId: z.string().optional(),
  // No `stream` field: this surface is SSE-only, so advertising a toggle it ignores
  // would be misleading. Add a non-streaming mode here if a client ever needs one.
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

function toContext(info: ApiKeyInfo, sessionId?: string): EmbedContext {
  return {
    keyId: info.keyId,
    userId: info.userId,
    agentId: info.agentId!,
    organizationId: info.organizationId!,
    allowedOrigins: info.allowedOrigins,
    rateLimit: info.rateLimit,
    ...(sessionId && { sessionId }),
  };
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

  // A bearer that is NOT a raw b4m_ key is the minted session token (a JWT always
  // starts with `eyJ`). This discriminator is coupled to the `b4m_` key prefix that
  // extractApiKeyFromHeaders keys on - if that prefix ever changes, both move together.
  if (bearer && !bearer.startsWith('b4m_')) {
    const claims = verifyEmbedSessionToken(bearer);
    const info = await verifyEmbedKeyById(claims.keyId);
    if (info.agentId !== claims.agentId || info.organizationId !== claims.organizationId) {
      throw new Error('Session token does not match the embed key');
    }
    return toContext(info, claims.sessionId);
  }

  return toContext(await verifyEmbedApiKey(headers));
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
      // A sandboxed iframe without allow-same-origin sends the literal `Origin: null`;
      // treat that like an absent Origin (let the credential decide) rather than a
      // hard 403 that would break a legitimate embed without stopping a real attacker
      // (who can just omit the header anyway).
      const requestOrigin = headers.origin && headers.origin !== 'null' ? headers.origin : undefined;
      if (requestOrigin && !isOriginPermitted(requestOrigin, ctx.allowedOrigins)) {
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

      // Both reads are independent and their ids are known now, so fetch in parallel;
      // the checks below still run in priority order (agent 404/403 before credits 422).
      const [agent, org] = await Promise.all([
        agentRepository.findById(ctx.agentId),
        organizationRepository.findById(ctx.organizationId),
      ]);

      // Resolve the agent SOLELY from the key. Reject deleted or cross-tenant agents.
      if (!agent || agent.deletedAt) {
        return res.status(404).json({ error: 'not_found', error_description: 'Bound agent not found' });
      }
      // Require POSITIVE ownership by the key, fail-closed: the bound agent must be
      // an org-shared agent of the key's org, or a personal agent of the key owner.
      // Checking only for a mismatch would let a system/global agent (isSystem, with
      // neither organizationId nor userId set) through both clauses - an embed key
      // must never run an agent it does not own. An org-shared agent is the usual
      // case; the admin UI that mints embed keys (#634) surfaces that constraint.
      const ownedByOrg = agent.organizationId != null && agent.organizationId === ctx.organizationId;
      const ownedByUser = agent.userId != null && agent.userId === ctx.userId;
      if (!ownedByOrg && !ownedByUser) {
        return res.status(403).json({ error: 'forbidden', error_description: 'Agent is not owned by the embed key' });
      }

      const hydrated = hydrateEmbedAgent(agent);
      if (!hydrated.model) {
        return res
          .status(422)
          .json({ error: 'unprocessable', error_description: 'Bound agent has no configured model' });
      }

      // A key can outlive its org (org deleted while the key stayed active). That is a
      // data-integrity condition, not a balance one - fail closed with a clear 403
      // rather than a misleading 422, and never fall back to any other pool.
      if (!org) {
        return res.status(403).json({ error: 'forbidden', error_description: 'Embed key organization not found' });
      }

      // Unconditional pre-flight balance check against the owner org (runs even when
      // enforceCredits is off). Must precede any stream bytes so it can 422. This is a
      // coarse floor (requiredCredits defaults to 1) - exact settlement/refusal happens
      // inside executeCompletion; a broke-but-nonzero org can still trip the mid-stream
      // InsufficientCreditsError. A rough per-model pre-estimate here is a later refinement.
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

      // Prepend the agent's hydrated persona as a leading system message - the
      // embed run's configured behavior. Kept at the call site so executeCompletion
      // stays a plain message-list consumer.
      const messages: IMessage[] = [
        { role: 'system', content: hydrated.systemPrompt },
        ...(body.messages as IMessage[]),
      ];

      try {
        await executeCompletion({
          userId: ctx.userId,
          model: hydrated.model,
          messages,
          options: { temperature: hydrated.temperature, maxTokens: hydrated.maxTokens, stream: true },
          db: {
            adminSettings: adminSettingsRepository,
            apiKeys: apiKeyRepository,
            creditTransactions: creditTransactionRepository,
            users: userRepository,
            usageEvents: usageEventRepository,
            organizations: organizationRepository,
            // Per-key spend metering (spend-cap enforcement). NOT the provider-LLM
            // key repo above (apiKeys) - this one holds the embed UserApiKey docs.
            userApiKeys: userApiKeyRepository,
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
