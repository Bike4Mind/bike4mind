/**
 * POST /api/v1/agent-executions - start a tool-using agent (ReAct) run over REST.
 *
 * The REST twin of the `agent_execute` WebSocket `start` command, and the reason this
 * exists: the agent pipeline was previously reachable only over WebSocket, so an
 * API-key caller could reproduce a chat turn but not an agent run. Both transports go
 * through `startAgentExecution`, so the guards and the documents they create are the
 * same; this handler only resolves REST-shaped defaults (model, billing org) and maps
 * the service's outcome onto HTTP.
 *
 * Auth mode, scopes and body validation all come from `startAgentExecutionContract`.
 */

import { BadRequestError, ConflictError, NotFoundError, BadGatewayError } from '@server/utils/errors';
import { getSettingsMap, getSettingsValue } from '@bike4mind/utils';
import { adminSettingsRepository } from '@bike4mind/database';
import { startAgentExecutionContract } from '@bike4mind/common';
import { nextRouteForContract } from '@server/middlewares/defineNextRoute';
import { rateLimit } from '@server/middlewares/rateLimit';
import { resolveUserRateLimitPerMin } from '@server/utils/userRateTier';
import { isChatModelUsable, resolveDefaultChatModel } from '@server/utils/chatCompletionDefaults';
import { startAgentExecution } from '@server/utils/startAgentExecution';
import { HEADLESS_CONNECTION_ID } from '@server/utils/headlessConnection';

const handler = nextRouteForContract(startAgentExecutionContract, {
  rateLimit: rateLimit({
    limit: req => resolveUserRateLimitPerMin(req.user),
    windowMs: 60 * 1000,
  }),
}).post(async (req, res) => {
  const body = req.validated;

  // Same model-resolution ladder as POST /api/chat: an explicit model wins, else the
  // admin default, which on a local-only self-host box may itself need a fallback - so
  // only probe when nothing was supplied.
  let model = body.model;
  if (!model) {
    const settings = await getSettingsMap({ adminSettings: adminSettingsRepository });
    const resolved = await resolveDefaultChatModel({
      configuredModel: getSettingsValue('DefaultAPIModel', settings),
      userId: req.user.id,
      logger: req.logger,
    });
    model = resolved.model;
    // Self-host guard: apiKeys/models are populated only there. Fail fast with
    // actionable guidance rather than a cryptic error deep inside the executor.
    if (resolved.apiKeys && resolved.models) {
      const info = resolved.models.find(m => m.id === model);
      if (!isChatModelUsable(resolved.apiKeys, info, req.logger)) {
        throw new BadRequestError(
          'No usable default chat model is configured. Set a provider key (e.g. ANTHROPIC_API_KEY) in ' +
            '.env.selfhost, enable local models via OLLAMA_BASE_URL, or pass an explicit "model" from GET /api/models.'
        );
      }
    }
  }

  // Billing target is an explicit, opt-in choice: omitted means the run is billed to
  // the caller personally. The membership check lives in `startAgentExecution` - one
  // gate, shared with the WebSocket transport, rather than a second one here that
  // would disagree with it about who counts as a member.
  const result = await startAgentExecution(
    {
      userId: req.user.id,
      sessionId: body.session_id,
      // Back-reference the session, matching what the WebSocket client sends. The
      // prompt Quest the service creates is a separate, real id, returned below.
      questId: body.session_id,
      query: body.message,
      model,
      // No WebSocket peer on this transport: the caller polls instead of streaming.
      connectionId: HEADLESS_CONNECTION_ID,
      organizationId: body.organization_id,
      agentId: body.agent_id,
      enabledTools: body.tools,
      maxIterations: body.max_iterations,
      messageFileIds: body.file_ids,
      sessionFabFileIds: body.session_file_ids,
      temperature: body.temperature,
      maxTokens: body.max_tokens,
      thinking: body.thinking,
      enableMementos: body.enable_mementos,
      enableLattice: body.enable_lattice,
      // No `routingSource`: that field records which UI signal routed a send to the
      // agent pipeline, and a REST caller chose the pipeline outright. Its enum has no
      // value for "the API asked", and inventing one would be rejected by the Quest
      // schema and swallowed as a best-effort write failure.
    },
    req.logger
  );

  if (!result.ok) {
    switch (result.reason) {
      case 'session_not_found':
        // Also covers "exists but is not yours" - deliberately indistinguishable, so
        // the endpoint cannot be used to probe which session ids exist.
        throw new NotFoundError('Session not found');
      case 'organization_not_found':
        // Same reasoning as the session case: "no such org" and "not your org" are one
        // response, so membership cannot be probed.
        throw new NotFoundError('Organization not found');
      case 'concurrent_limit':
        throw new ConflictError(result.message);
      case 'dispatch_failed':
        throw new BadGatewayError(result.message);
    }
  }

  return res.status(202).json({
    id: result.executionId,
    status: 'pending' as const,
    session_id: body.session_id,
    model,
    timestamp: new Date().toISOString(),
    tracking_info: {
      execution_id: result.executionId,
      ...(result.questId ? { quest_id: result.questId } : {}),
      poll_url: `/api/v1/agent-executions/${result.executionId}`,
    },
  });
});

export default handler;
