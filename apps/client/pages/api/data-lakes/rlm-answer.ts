import { Request, Response } from 'express';
import { z } from 'zod';
import { randomUUID } from 'crypto';
import { adminSettingsRepository, apiKeyRepository } from '@bike4mind/database';
import { apiKeyService } from '@bike4mind/services';
import { ReActAgent, ReplSession, BudgetExceededError, makeCodeExecuteTool } from '@bike4mind/agents';
import { getSettingsByNames } from '@bike4mind/utils';
import { getAvailableModels, getLlmByModel } from '@bike4mind/llm-adapters';
import { baseApi } from '@server/middlewares/baseApi';
import { rateLimit } from '@server/middlewares/rateLimit';
import { buildDataLakeTools } from '@server/tavern/rlm/tools';
import { REPL_TOOL_SYSTEM_PROMPT } from '@server/tavern/rlm/dataLakeReplPrompts';
import { resolveAccessibleLakes } from '@server/dataLakes';

/**
 * POST /api/data-lakes/rlm-answer
 *
 * AFTER substrate for the RLM contradiction-detection spike. Spins up a
 * minimal ReActAgent with exactly one tool - `code_execute` - and runs
 * it against a data-lake query.
 *
 * Architecture per docs/07-PERSISTENT-REPL-TOOL.md:
 *   1. Auth: session/api-key, then fail-closed unless the caller can access at
 *      least one data lake (each lake declares its own tag/entitlement gate)
 *   2. Resolve API keys + spin up a Sonnet-routed ICompletionBackend
 *   3. Create a ReplSession scoped to this request (per-call sandbox)
 *   4. Inject data-lake tools (semanticSearch, keywordSearch, listArticles,
 *      getArticle, subAgentQuery) into the REPL via session.setTools()
 *   5. Register the `code_execute` tool with the agent - the ONLY tool
 *      the agent has direct access to. All retrieval flows through code.
 *   6. Run the agent loop with the persona query as the prompt
 *   7. Dispose the session and return the trajectory + final answer
 *
 * Spike design choice: agent has ONLY `code_execute`. This forces every
 * retrieval to be code-orchestrated - apples-to-apples with BEFORE
 * (keyword + Sonnet synth) and MIDDLE (vector + Sonnet synth). No direct
 * agent tool calls would muddy the attribution story.
 *
 * Production hardening (Quest 3) replaces:
 * - HTTP loopback in tools.ts with in-process service calls
 * - Per-request session disposal with longer-lived agent sessions
 * - vm.runInContext with a real sandbox (isolated-vm or worker pool)
 *
 * See: apps/client/server/tavern/docs/07-PERSISTENT-REPL-TOOL.md
 */

// Server-side hard cap on the cost a single request can authorize. The
// caller-provided `budget.max_cost_usd` is clamped to this - without it,
// any Opti-tagged user could authorize a $50 spend per request and chain
// requests to drain the platform Anthropic key. Combined with the
// rate-limit middleware below, total exposure is bounded to
// (HARD_PER_REQUEST_COST_CAP * limit) per minute per user.
const HARD_PER_REQUEST_COST_CAP_USD = 5;

const RlmAnswerInput = z.object({
  query: z.string().min(1).max(8000),
  /** Override the root LLM model id. Default: latest Sonnet via Bedrock. */
  model: z.string().optional(),
  /** Cap agent ReAct iterations. Default 12. */
  max_iterations: z.number().int().min(1).max(40).optional(),
  /** Override sub-LLM (haiku) budget caps. */
  budget: z
    .object({
      max_executions: z.number().int().min(1).max(100).optional(),
      max_sub_llm_calls: z.number().int().min(1).max(1000).optional(),
      max_cost_usd: z.number().min(0.01).max(HARD_PER_REQUEST_COST_CAP_USD).optional(),
    })
    .optional(),
});

const DEFAULT_MODEL = 'global.anthropic.claude-sonnet-4-6';
// No hardcoded fallback model id - `getAvailableModels()` returns the live
// roster, so if DEFAULT_MODEL isn't found we pick the first available model
// whose id contains "sonnet" (or fall back to the first available, period).
// Avoids a stale-id failure mode when Anthropic deprecates a specific dated
// snapshot.
// 25 matches the per-session execution budget; v1 ran with 12 and clipped
// T3 trajectories mid-orchestration. See doc 13-before-vs-middle-vs-after.md.
const DEFAULT_MAX_ITERATIONS = 25;
// Frontend Lambda is configured for 60s in `infra/web.ts`. AWS will SIGKILL
// the function past that - `AbortSignal.timeout` would never fire. Cap our
// internal timeout to fit within Lambda + ~5s buffer for response
// serialization. Endpoint comments said "9 min" but that was infra-incorrect.
// If we want long-running agent runs in production, that needs its own
// Lambda with a higher `timeout` (or move to async-job + polling).
const HARD_TIMEOUT_MS = 55_000;

const handler = baseApi()
  .use(
    // Cost-driven endpoint - each call can authorize up to
    // HARD_PER_REQUEST_COST_CAP_USD of LLM spend. Tighter limit than
    // the chat endpoints (3 req/min vs 10) because individual calls are
    // 10-100x more expensive.
    rateLimit({
      limit: process.env.NODE_ENV === 'development' ? 30 : 3,
      windowMs: 60 * 1000,
    })
  )
  .post(async (req: Request, res: Response) => {
    const t0 = Date.now();

    // --- Access gate: lake-scoped, fail-closed ---
    // This endpoint spends real LLM budget per request (cost cap below), so
    // unlike the cheap browse endpoints it refuses outright when the caller
    // has no accessible lakes instead of returning an empty answer. Access is
    // defined by each lake's own declared gate (requiredUserTag /
    // requiredEntitlement), not by any product.
    if ((await resolveAccessibleLakes(req)).length === 0) {
      return res.status(403).json({ error: 'No accessible data lakes' });
    }

    // safeParse so validation failures surface as 400 with structured
    // error details rather than throwing ZodError to the global handler.
    // Mirrors the /api/data-lakes/semantic-search pattern.
    const parseResult = RlmAnswerInput.safeParse(req.body || {});
    if (!parseResult.success) {
      return res.status(400).json({
        error: 'Invalid request body',
        details: parseResult.error.flatten(),
      });
    }
    const parsed = parseResult.data;

    // --- Resolve API keys ---
    // Root LLM is routed through whatever provider getLlmByModel picks for the
    // requested modelId - for `global.anthropic.*` that's Bedrock (no Anthropic
    // API key needed; AWS creds handle it). For sub-LLM calls inside the REPL,
    // tools.ts uses the Anthropic SDK directly, so we need a direct Anthropic
    // key. Fall back to env if the user-scoped key isn't configured (spike
    // deployment is local-dev; production will route sub-LLM through Bedrock too).
    const dbAdapters = {
      db: { apiKeys: apiKeyRepository, adminSettings: adminSettingsRepository },
      getSettingsByNames,
    };
    const userId = req.user?.id || 'system';
    const apiKeyTable = await apiKeyService.getEffectiveLLMApiKeys(userId, dbAdapters);
    const subLlmAnthropicKey = apiKeyTable?.anthropic || process.env.ANTHROPIC_API_KEY || '';
    if (!subLlmAnthropicKey) {
      return res.status(500).json({
        error:
          'No Anthropic API key available for sub-LLM calls. ' +
          'Configure user/system Anthropic key or set ANTHROPIC_API_KEY env var.',
      });
    }

    // We need the local B4M API key for the in-REPL data-lake tools to call
    // /api/data-lakes/* on this same server. Use the request's incoming key (the
    // caller already authenticated with it) - falls back to env if missing.
    const localApiKey = (req.headers['x-api-key'] as string | undefined) || process.env.B4M_LOCAL_API_KEY || '';
    if (!localApiKey) {
      return res.status(500).json({
        error: 'No B4M local API key available for in-REPL data-lake tool calls',
      });
    }

    // --- Resolve the root LLM backend ---
    const models = await getAvailableModels(apiKeyTable);
    const requestedModel = parsed.model ?? DEFAULT_MODEL;
    let modelInfo = models.find(m => m.id === requestedModel);
    if (!modelInfo) {
      // Live fallback: prefer any available Sonnet, else the first
      // available model. Avoids hardcoding a dated model id that could
      // go stale when Anthropic deprecates a specific snapshot.
      modelInfo = models.find(m => /sonnet/i.test(m.id)) ?? models[0];
    }
    if (!modelInfo) {
      return res.status(500).json({
        error: `Model "${requestedModel}" not available, and no fallback model could be resolved`,
        availableModelIds: models.slice(0, 10).map(m => m.id),
      });
    }
    const llm = getLlmByModel(apiKeyTable, { modelInfo, logger: req.logger, endUserId: req.user?.id });
    if (!llm) {
      return res.status(500).json({ error: `Failed to construct backend for model ${modelInfo.id}` });
    }

    // --- Construct a per-request ReplSession ---
    const sessionId = `rlm-answer-${randomUUID()}`;
    const baseUrl = `http://localhost:${process.env.PORT ?? '3000'}`;
    const session = new ReplSession({
      sessionId,
      label: 'rlm-answer',
      perCallTimeoutMs: 60_000,
      budget: {
        maxExecutions: parsed.budget?.max_executions ?? 25,
        maxSubLlmCalls: parsed.budget?.max_sub_llm_calls ?? 200,
        maxCostUsd: parsed.budget?.max_cost_usd ?? HARD_PER_REQUEST_COST_CAP_USD,
      },
    });

    // Wire data-lake tools into the REPL (NOT into the agent's tool array)
    session.setTools(
      buildDataLakeTools({
        baseUrl,
        apiKey: localApiKey,
        anthropicApiKey: subLlmAnthropicKey,
        session,
      })
    );

    // The agent gets exactly one tool: code_execute. Pure RLM mode. Pass the
    // data-lake tool names so the tool description tells the agent what's
    // actually callable inside the REPL.
    const codeExecuteTool = makeCodeExecuteTool({
      session,
      logger: req.logger,
      toolNames: ['semanticSearch', 'keywordSearch', 'listArticles', 'getArticle', 'subAgentQuery'],
    });

    // --- Compose system prompt ---
    const baseAgentPrompt =
      'You are a research analyst answering questions over the data lake. ' +
      'Your only tool is `code_execute`, which runs JavaScript in a persistent REPL ' +
      'with access to data-lake search functions. You MUST use code_execute for every ' +
      'retrieval step. When you have the information, give a complete, well-organized ' +
      'answer with citations to article filenames in [brackets].';
    const systemPrompt = `${baseAgentPrompt}\n\n${REPL_TOOL_SYSTEM_PROMPT}`;

    // --- Construct + run the agent ---
    const agent = new ReActAgent({
      userId,
      logger: req.logger,
      llm,
      model: modelInfo.id,
      tools: [codeExecuteTool],
      maxIterations: parsed.max_iterations ?? DEFAULT_MAX_ITERATIONS,
      systemPrompt,
      temperature: 0.4,
      maxTokens: 4096,
    });

    let timedOut = false;
    const timeoutSignal = AbortSignal.timeout(HARD_TIMEOUT_MS);
    timeoutSignal.addEventListener('abort', () => {
      timedOut = true;
    });

    let result;
    let runError: string | null = null;
    // Snapshot usage and dispose in finally so the per-request session's
    // resources (vm.Context today, worker thread when executor === 'worker'
    // is enabled) are cleaned up on every code path - including agent.run
    // throwing or the client disconnecting mid-flight.
    let replUsage = session.getUsage();
    try {
      try {
        result = await agent.run(parsed.query, {
          maxIterations: parsed.max_iterations ?? DEFAULT_MAX_ITERATIONS,
          signal: timeoutSignal,
          maxHistoryIterations: 4,
        });
      } catch (e) {
        if (e instanceof BudgetExceededError) {
          runError = `BUDGET_EXCEEDED: ${e.message}`;
        } else if (timedOut) {
          runError = `TIMEOUT after ${HARD_TIMEOUT_MS}ms`;
        } else {
          runError = e instanceof Error ? e.message : String(e);
        }
      }
      replUsage = session.getUsage();
    } finally {
      // Best-effort dispose. A throw here would mask the real error; just log.
      try {
        await session.dispose();
      } catch (e) {
        req.logger.warn(
          `[rlm-answer] session ${sessionId} dispose failed: ${e instanceof Error ? e.message : String(e)}`
        );
      }
    }

    const totalLatencyMs = Date.now() - t0;

    if (!result) {
      return res.status(500).json({
        error: runError ?? 'agent.run() returned no result',
        session_id: sessionId,
        repl_usage: replUsage,
        latency_ms: totalLatencyMs,
      });
    }

    // Compact step trace for the response - full data also accessible via the
    // structured response if a caller wants to dig deeper.
    const trajectory = result.steps.map(s => ({
      type: s.type,
      content: s.type === 'observation' ? s.content.slice(0, 4000) : s.content,
      tool: s.metadata?.toolName,
      timestamp: s.metadata?.timestamp,
    }));

    return res.json({
      answer: result.finalAnswer,
      session_id: sessionId,
      model: modelInfo.id,
      iterations: result.completionInfo.iterations,
      tool_calls: result.completionInfo.toolCalls,
      reached_max_iterations: result.completionInfo.reachedMaxIterations,
      total_tokens: result.completionInfo.totalTokens,
      total_input_tokens: result.completionInfo.totalInputTokens,
      total_output_tokens: result.completionInfo.totalOutputTokens,
      repl_usage: replUsage,
      latency_ms: totalLatencyMs,
      trajectory,
      run_error: runError,
    });
  });

export default handler;
