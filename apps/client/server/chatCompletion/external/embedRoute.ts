import express, { type Request, type Response, type Express } from 'express';
import {
  buildMetaEvent,
  buildPublicSSEEvent,
  formatSSEError,
  resolveRequestId,
  serializeSSEEvent,
  SSE_DONE_SIGNAL,
  SSE_KEEPALIVE,
  REQUEST_ID_HEADER,
  LEGACY_REQUEST_ID_HEADER,
  type IMessage,
} from '@bike4mind/common';
import { Logger } from '@bike4mind/observability';
import {
  executeCompletion,
  assertOwnerHasCredits,
  assertKeySpendWithinCap,
  resolveQuestErrorCode,
  buildSharedTools,
  apiKeyService,
  type ToolBuilderDeps,
  type ToolBuilderCallbacks,
} from '@bike4mind/services';
import { getSettingsByNames } from '@bike4mind/utils';
import {
  getAvailableModels,
  getLlmByModel,
  type ApiKeyTable,
  type ICompletionOptionTools,
} from '@bike4mind/llm-adapters';
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
  projectRepository,
  fabFileRepository,
  fabFileChunkRepository,
  dataLakeRepository,
} from '@bike4mind/database';
import { verifyEmbedApiKey, verifyEmbedKeyById, type ApiKeyInfo } from '@server/cli/auth';
import { verifyEmbedSessionToken } from '@server/embed/embedSessionToken';
import { isEmbedOriginAllowed } from '@server/embed/firstPartyOrigin';
import { checkApiKeyRateLimit } from '@server/utils/apiKeyRateLimitCheck';
import { checkEmbedSessionRateLimit } from '@server/utils/embedSessionRateLimit';
import { embedCors } from '@server/middlewares/embedCors';
import { flattenHeaders } from '@server/utils/flattenHeaders';
import { getFilesStorage, getGeneratedImageStorage } from '@server/utils/storage';
import { hydrateEmbedAgent } from './embedAgentHydration';
import { resolveEmbedTools } from './embedToolResolver';
import { Config } from '@server/utils/config';
import { z } from 'zod';

/**
 * Public embed chat endpoint (`POST /api/embed/chat`), served by the always-on
 * ChatCompletion service (Fargate) so the SSE stream isn't bounded by a Lambda
 * timeout. Runs a *configured agent* (persona hydrated from AgentModel) for an
 * anonymous end-user, billing the embed key's organization. Reachable by
 * browsers only via CloudFront (the router forwards the route + Origin/OPTIONS).
 *
 * Unlike the CLI completions route, all auth/origin/balance/rate-limit gates run
 * BEFORE any SSE bytes flush, so a rejection returns a real HTTP status (401/403/
 * 422/429) instead of an SSE error frame. Only failures once the stream is open
 * (mid-completion) surface as SSE errors.
 *
 * Stateless: end-user turns are never persisted to any owner's session history -
 * the route never passes a sessionId and never calls persistRunAsQuest.
 *
 * Tools: server-side execution with a hard gate. KB retrieval is on by default but
 * confined to the bound agent's Project file set (kbScope, fail-closed to empty);
 * everything else is opt-in from a curated universe, deny wins. See
 * buildEmbedServerTools below and embedToolResolver.ts.
 */

const EMBED_CHAT_ENDPOINT = '/api/embed/chat';
const HEARTBEAT_INTERVAL_MS = 10_000;
// Lower than the backend default (10): an anonymous caller must not drive the full loop
// depth on the owner org's credits. KB search + retrieve + one follow-up is plenty.
const EMBED_MAX_TOOL_CALLS = 5;

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
  /** Spend ceiling in credits. Present 0 = real cap; absent = uncapped. */
  spendCap?: number;
  /** Cumulative settled spend in credits at validation time. */
  currentSpend?: number;
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
    spendCap: info.spendCap,
    currentSpend: info.currentSpend,
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
 * Materialize the embed run's server-side tools, or undefined when tools are off.
 *
 * Security posture (all fail-closed):
 *   - The tool set derives ONLY from the resolver over the agent's server-side config
 *     (see embedToolResolver); nothing in the request can name or enable a tool.
 *   - KB is always scoped to the bound agent's Project file set. The project must be
 *     owned by the key's user, or - for an org-owned agent - by a member of the key's
 *     org (org agents' projects are routinely created by a teammate, and the agent
 *     authorization itself is org-scoped). Anything else (no projectId, missing/
 *     deleted project, cross-org owner) resolves to an EMPTY scope (KB tools present,
 *     read nothing) - never owner-wide. Files curated into an authorized project are
 *     readable by the embed audience even when owned by another user: curation IS
 *     the grant.
 *   - No orchestration deps (agentStore/dagDispatcher), so delegate/coordinate tools
 *     are structurally impossible; entitlementKeys stays [] so even a bug that reached
 *     data-lake resolution would resolve nothing.
 *   - Tool callbacks are no-ops: tool names/params/results never reach the SSE wire.
 *   - Any resolution failure (owner or backend missing) returns undefined - the
 *     completion still runs persona-only rather than 500ing the request.
 */
async function buildEmbedServerTools(args: {
  ctx: EmbedContext;
  hydrated: { model?: string; projectId?: string; allowedTools: string[]; deniedTools: string[] };
  /**
   * Owner org, or null. Set only when the bound agent passed the ORG-ownership clause -
   * it authorizes a project owned by any org member (org projects are routinely created
   * by a teammate). Null for a personal agent, which restricts to the key owner's own
   * projects. Membership is read from the org's own member list (a User doc carries no
   * org field), so no extra lookup is needed.
   */
  ownerOrg: { userId?: string; userDetails?: Array<{ id: string }> | null } | null;
  logger: Logger;
  getAbortSignal: () => AbortSignal | undefined;
}): Promise<ICompletionOptionTools[] | undefined> {
  const { ctx, hydrated, ownerOrg, logger, getAbortSignal } = args;

  const enabledTools = resolveEmbedTools(hydrated);
  if (enabledTools.length === 0) return undefined;

  // These three reads are independent, so fetch them together (mirrors the
  // agent/org parallel fetch on the request path above).
  const [project, owner, toolApiKeys] = await Promise.all([
    hydrated.projectId ? projectRepository.findById(hydrated.projectId) : Promise.resolve(null),
    userRepository.findById(ctx.userId),
    apiKeyService.getEffectiveLLMApiKeys(ctx.userId, {
      db: { apiKeys: apiKeyRepository, adminSettings: adminSettingsRepository },
      getSettingsByNames,
    }),
  ]);

  let kbFileIds: string[] = [];
  if (project && !project.deletedAt) {
    const isOrgMember = (userId: string): boolean =>
      !!ownerOrg && (ownerOrg.userId === userId || (ownerOrg.userDetails ?? []).some(d => d.id === userId));
    // Authorized when the key owner owns the project, or - for an org agent - any org
    // member does. Anything else fails closed to an empty scope (never owner-wide).
    if (project.userId === ctx.userId || isOrgMember(project.userId)) {
      kbFileIds = project.fileIds ?? [];
    }
  }

  if (!owner) {
    logger.warn('[EMBED_CHAT] Key owner not found; running without tools');
    return undefined;
  }

  const models = await getAvailableModels(toolApiKeys as ApiKeyTable);
  const modelInfo = models.find(m => m.id === hydrated.model);
  const toolLlm = getLlmByModel(toolApiKeys as ApiKeyTable, { modelInfo, logger, endUserId: ctx.userId });
  if (!toolLlm) {
    logger.warn('[EMBED_CHAT] No LLM backend for tool context; running without tools');
    return undefined;
  }
  toolLlm.currentModel = hydrated.model ?? '';

  const deps: ToolBuilderDeps = {
    userId: ctx.userId,
    user: owner,
    logger,
    db: {
      adminSettings: adminSettingsRepository,
      apiKeys: apiKeyRepository,
      fabfiles: fabFileRepository,
      fabfilechunks: fabFileChunkRepository,
      users: userRepository,
      dataLakes: dataLakeRepository,
      organizations: organizationRepository,
      usageEvents: usageEventRepository,
    },
    entitlementKeys: [],
    kbScope: { fileIds: kbFileIds },
    storage: getFilesStorage(),
    imageGenerateStorage: getGeneratedImageStorage(),
    llm: toolLlm,
    model: hydrated.model,
  };
  const callbacks: ToolBuilderCallbacks = {
    onStatusUpdate: async () => {},
    onToolStart: async () => {},
    onToolFinish: async () => {},
  };

  const tools = buildSharedTools(deps, callbacks, { enabledTools, getAbortSignal });
  return tools && tools.length > 0 ? tools : undefined;
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
      // (who can just omit the header anyway). Our own serving origin is implicitly
      // permitted: the /embed/* widget page posts from the app host, which can never
      // appear on an allow-list (see firstPartyOrigin.ts) - must stay in lockstep
      // with the mint gate in pages/api/embed/session.ts.
      const requestOrigin = headers.origin && headers.origin !== 'null' ? headers.origin : undefined;
      if (requestOrigin && !isEmbedOriginAllowed(requestOrigin, ctx.allowedOrigins, headers.host)) {
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
          code: resolveQuestErrorCode(creditErr),
        });
      }

      // Per-key spend-cap gate, the second billing-class check: the org may be
      // solvent while this key has exhausted its own budget. Reads the validation-
      // time snapshot off ctx (no fresh query - the auth layer just loaded the
      // key); the race this leaves open is bounded and accepted, since the cap is
      // a leaked-key backstop, not exact accounting. Not only N parallel streams:
      // settlement is a fire-and-forget write after the stream closes (see
      // cliCompletions.ts), so even back-to-back sequential requests from a fast
      // client can pass this gate before the prior increment lands.
      try {
        assertKeySpendWithinCap({ spendCap: ctx.spendCap, currentSpend: ctx.currentSpend });
      } catch (capErr) {
        const status = (capErr as { statusCode?: number }).statusCode ?? 422;
        return res.status(status).json({
          error: 'spend_cap_exceeded',
          error_description: capErr instanceof Error ? capErr.message : 'Spend cap exceeded',
          code: resolveQuestErrorCode(capErr),
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

      // --- Server-side tools (built pre-stream so a failure is a clean JSON 500) ---
      // Aborting on client disconnect stops the backend stream AND the tool loop, so a
      // closed embed tab cannot keep billing the owner org through the remaining turns.
      const abortController = new AbortController();
      res.on('close', () => abortController.abort());
      const serverTools = await buildEmbedServerTools({
        ctx,
        hydrated,
        // Only an org-owned agent extends KB authorization to org-mate projects.
        ownerOrg: ownedByOrg ? org : null,
        logger,
        getAbortSignal: () => abortController.signal,
      });

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
          // Server-side tool execution (KB scoped to the agent's project; see
          // buildEmbedServerTools). Absent => persona-only, executeTools stays false.
          ...(serverTools ? { serverTools, maxToolCalls: EMBED_MAX_TOOL_CALLS } : {}),
          abortSignal: abortController.signal,
          requestId,
          source: 'api',
          logger,
          onChunk: async (text, info) => {
            // Public/anonymous caller: text + usage/credits only. buildPublicSSEEvent
            // drops server-internal metadata (tool calls, thinking blocks) that the
            // backend reports on tool/reasoning turns. See its contract in sseEvents.ts.
            write(serializeSSEEvent(buildPublicSSEEvent(text, info)));
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
        // Classify billing/policy failures so the embedding client can branch on
        // `code` instead of parsing message text.
        write(serializeSSEEvent(formatSSEError(error, requestId, resolveQuestErrorCode(error))));
        if (!res.writableEnded) res.end();
      } else if (!res.headersSent) {
        res.status(500).json({ error: 'internal_error', error_description: 'Failed to process embed chat request' });
      }
    }
  });
}
