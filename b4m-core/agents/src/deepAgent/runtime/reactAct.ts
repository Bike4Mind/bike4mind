import { randomUUID } from 'crypto';
import type { ICompletionBackend, ICompletionOptionTools } from '@bike4mind/llm-adapters';
import type { Logger } from '@bike4mind/observability';
import { ReActAgent } from '../../ReActAgent';
import { ReplSession } from '../../rlm/ReplSession';
import { makeCodeExecuteTool } from '../../rlm/codeExecuteTool';
import type { AgentResult } from '../../types';
import { buildActQuery, buildActSystemPrompt } from './prompts';
import { resolveToolbeltProfile } from './toolbelts';
import type { ActContext, ActResult } from './types';

/**
 * Maps a ReActAgent run result into the wake cycle's `ActResult`.
 *
 * Pure - the testable core of the executor. Action steps become `actionsTaken`,
 * observation steps + the final answer become `observations`, and token spend
 * comes from the run's completion info. `succeeded` reflects that the call was
 * made (per-step success detection is a later refinement); `costUsd` is left 0
 * here - credit->USD conversion happens upstream of this layer.
 */
export function agentResultToActResult(result: AgentResult): ActResult {
  const actionsTaken = result.steps
    .filter(s => s.type === 'action')
    .map(s => ({
      tool: s.metadata?.toolName ?? 'unknown',
      input: s.metadata?.toolInput,
      succeeded: true,
    }));

  const observations = result.steps
    .filter(s => s.type === 'observation')
    .map(s => ({ kind: 'tool_result', summary: s.content }));
  if (result.finalAnswer) {
    observations.push({ kind: 'final_answer', summary: result.finalAnswer });
  }

  return {
    actionsTaken,
    observations,
    tokensSpent: result.completionInfo.totalTokens,
    costUsd: 0,
  };
}

/**
 * Materializes a profile's named tools into executable tools, scoped to the
 * agent's owner. Host-supplied and async (it resolves the owner user + builds
 * the toolbelt). `ownerUserId` comes from the charter at call time.
 */
export type ToolMaterializer = (enabledToolNames: string[], ownerUserId: string) => Promise<ICompletionOptionTools[]>;

/** What a mission inherits from its linked host agent at act time. */
export interface LinkedAgentContext {
  /** The agent's system prompt - leads the act prompt so the persona stays intact. */
  systemPrompt?: string;
  /** Tool whitelist; when non-empty, the mission profile is intersected with it. */
  allowedTools?: string[];
  /** Tool blacklist; always subtracted. */
  deniedTools?: string[];
}

/**
 * Intersect a mission profile's tool names with the linked agent's policy:
 * profile ∩ allowedTools (when the whitelist is non-empty) - deniedTools.
 * Pure - the deterministic seam between agent configuration and mission tools.
 */
export function applyAgentToolPolicy(profileToolNames: string[], linked?: LinkedAgentContext | null): string[] {
  if (!linked) return profileToolNames;
  const allowed = linked.allowedTools?.length ? new Set(linked.allowedTools) : null;
  const denied = new Set(linked.deniedTools ?? []);
  return profileToolNames.filter(name => (!allowed || allowed.has(name)) && !denied.has(name));
}

export interface ReActRunActConfig {
  llm: ICompletionBackend;
  model: string;
  logger: Logger;
  /**
   * Turns a profile's `enabledToolNames` into real tools. The heavyweight
   * builder lives in the host; until it is wired, a builder returning `[]`
   * yields a tool-less reasoning act.
   */
  buildTools: ToolMaterializer;
  /**
   * Mission inheritance: resolves the linked host agent's persona + tool policy
   * when the charter carries `linkedAgentId`. Looked up fresh each wake so
   * agent edits propagate to in-flight missions. Optional - standalone deep
   * agents skip it.
   */
  loadLinkedAgent?: (linkedAgentId: string) => Promise<LinkedAgentContext | null>;
}

/**
 * Build an act executor backed by a ReActAgent. The agent's toolbelt + run
 * budget come from the charter role's profile; the run is driven by the policy
 * decision and mapped back into an `ActResult` for the wake cycle.
 */
export function createReActRunAct(config: ReActRunActConfig): (ctx: ActContext) => Promise<ActResult> {
  return async (ctx: ActContext): Promise<ActResult> => {
    const profile = resolveToolbeltProfile(ctx.charter.identity.role);

    // Mission inheritance: persona + tool policy from the linked host agent.
    const linkedAgentId = ctx.charter.identity.linkedAgentId;
    let linked: LinkedAgentContext | null = null;
    let orphanedLink = false;
    if (linkedAgentId && config.loadLinkedAgent) {
      linked = await config.loadLinkedAgent(linkedAgentId);
      // Linked agent vanished (deleted). Fail CLOSED on tools rather than
      // widening to the raw profile default - the deleted agent may have
      // restricted its toolset, and deletion must never grant tools back.
      if (!linked) orphanedLink = true;
    }
    const toolNamesToBuild = orphanedLink ? [] : applyAgentToolPolicy(profile.enabledToolNames, linked);
    if (orphanedLink) {
      config.logger.warn('[deepAgent.act] linked agent missing — running tool-less', {
        agentId: ctx.charter.identity.agentId,
        linkedAgentId,
      });
    }

    const tools = await config.buildTools(toolNamesToBuild, ctx.charter.identity.ownerUserId);

    // Give the agent a sandboxed JS REPL - the web-safe compute lever. Fresh
    // per wake (in-process; switch to 'worker' for production isolation).
    let session: ReplSession | undefined;
    if (profile.codeExecute) {
      session = new ReplSession({
        sessionId: `deepagent-${ctx.charter.identity.agentId}-${randomUUID()}`,
        label: `${ctx.charter.identity.role} wake`,
        budget: { maxExecutions: 30, maxSubLlmCalls: 50, maxCostUsd: 2 },
      });
      tools.push(makeCodeExecuteTool({ session, logger: config.logger }));
    }

    const toolNames = tools.map(t => t.toolSchema?.name).filter(Boolean);
    config.logger.info('[deepAgent.act] starting', {
      agentId: ctx.charter.identity.agentId,
      role: ctx.charter.identity.role,
      actionKind: ctx.policy.actionKind,
      tools: toolNames,
      codeExecute: profile.codeExecute,
    });

    try {
      const agent = new ReActAgent({
        userId: ctx.charter.identity.ownerUserId,
        logger: config.logger,
        llm: config.llm,
        model: config.model,
        tools,
        maxIterations: profile.maxIterations,
        maxTotalTokens: profile.maxTotalTokens,
        temperature: profile.temperature,
        systemPrompt: buildActSystemPrompt(ctx, linked?.systemPrompt),
      });

      // Stream the trajectory to the logs so a wake is watchable live.
      agent.on('action', step =>
        config.logger.info(`[deepAgent.act] → tool ${step.metadata?.toolName ?? '?'}`, {
          input: JSON.stringify(step.metadata?.toolInput ?? {}).slice(0, 300),
        })
      );
      agent.on('observation', step =>
        config.logger.info('[deepAgent.act] ← observation', { result: String(step.content).slice(0, 300) })
      );

      const result = await agent.run(buildActQuery(ctx));
      config.logger.info('[deepAgent.act] done', {
        toolCalls: result.completionInfo.toolCalls,
        iterations: result.completionInfo.iterations,
        tokens: result.completionInfo.totalTokens,
      });
      return agentResultToActResult(result);
    } finally {
      await session?.dispose();
    }
  };
}
