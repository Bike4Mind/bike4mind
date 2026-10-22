import { AgentStep, ReActAgent } from '@bike4mind/agents';
import type { SubagentOrchestrator } from '../agents/SubagentOrchestrator.js';
import { formatStep } from '../utils';
import { useCliStore } from '../store';
import { PENDING_ASSISTANT_CONTENT, type Message } from '../storage';
import { bridgePresence } from '../features/bridgePresence/index.js';

/** Apply `update` to the in-flight assistant message, if one is pending. */
function updatePendingAssistant(update: (message: Message) => Message): void {
  const { pendingMessages, updatePendingMessage } = useCliStore.getState();
  const lastIdx = pendingMessages.length - 1;
  if (lastIdx >= 0 && pendingMessages[lastIdx].role === 'assistant') {
    updatePendingMessage(lastIdx, update(pendingMessages[lastIdx]));
  }
}

export interface WireAgentEventsInput {
  agent: ReActAgent;
  orchestrator: SubagentOrchestrator;
}

/**
 * Wire the main agent's step events to the UI store and the tavern transcript,
 * and mirror the same handlers onto delegated subagents via the orchestrator's
 * before/after-run callbacks.
 *
 * Bootstrap seam: no React hooks, no useRef, no subscriptions. It reads/writes
 * the Zustand store via `getState()` (the same runtime-access pattern the agent
 * step handlers already used) and emits tavern events through the bridge
 * singleton; neither owns React-lifecycle state.
 */
export function wireAgentEvents(input: WireAgentEventsInput): void {
  const { agent, orchestrator } = input;

  // Set up step event handlers for real-time UI updates
  // These persist for the lifetime of the agent and update pending messages in the store
  const stepHandler = (step: AgentStep) => {
    updatePendingAssistant(message => ({
      ...message,
      metadata: {
        ...message.metadata,
        steps: [...(message.metadata?.steps || []), formatStep(step)],
      },
    }));
  };

  // Stream the main agent's reply into the pending message as it arrives. The
  // agent restarts its text every iteration, so a new iteration (or a new pending
  // message) starts fresh. Text that ends in a tool call is the preamble: it is
  // re-shown as a thought step, so it is cleared once a thought or action fires.
  // turnController replaces the content with the final answer when the turn ends.
  let liveText = { messageId: '', iteration: -1, text: '' };
  const textDeltaHandler = ({ delta, iteration }: { delta: string; iteration: number }) => {
    updatePendingAssistant(message => {
      const sameStream = liveText.messageId === message.id && liveText.iteration === iteration;
      liveText = { messageId: message.id, iteration, text: (sameStream ? liveText.text : '') + delta };
      return { ...message, content: liveText.text };
    });
  };
  const clearLiveText = () => {
    if (!liveText.text) return;
    liveText = { ...liveText, text: '' };
    updatePendingAssistant(message => ({ ...message, content: PENDING_ASSISTANT_CONTENT }));
  };

  // Subscribe to main agent events
  agent.on('thought', stepHandler);
  agent.on('observation', stepHandler);
  agent.on('action', stepHandler);
  // Main agent only: a subagent's reply is its tool result, not this turn's text.
  agent.on('text_delta', textDeltaHandler);
  agent.on('thought', clearLiveText);
  agent.on('action', clearLiveText);

  // Mirror ReAct events up to the tavern transcript so the modal renders
  // the same shape Observer+ does - `tool_use` -> `tool_result` pairs and
  // the final assistant message as a `message` row. No-op if cc-bridge
  // isn't running.
  //
  // Correlating tool_use -> tool_result in parallel execution is best-
  // effort: we FIFO-queue synthesized ids by toolName so the *usual*
  // sequential case matches cleanly. If two Reads run in parallel their
  // results may mis-pair, which only affects the modal's correlation
  // highlight - all four rows still render. Fixing that correctly would
  // require the agent to pass the observation's originating action id,
  // which is a separate ReAct change.
  const pendingToolUseIds: Map<string, string[]> = new Map();
  const summarizeToolInput = (input: unknown): string | undefined => {
    if (input == null) return undefined;
    if (typeof input === 'string') return input.slice(0, 240);
    try {
      return JSON.stringify(input).slice(0, 240);
    } catch {
      return undefined;
    }
  };
  const tavernActionHandler = (step: AgentStep) => {
    const toolName = step.metadata?.toolName ?? 'tool';
    const toolUseId = `${toolName}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const queue = pendingToolUseIds.get(toolName) ?? [];
    queue.push(toolUseId);
    pendingToolUseIds.set(toolName, queue);
    void bridgePresence.emitEvent({
      type: 'tool_use',
      tool: toolName,
      toolUseId,
      text: summarizeToolInput(step.metadata?.toolInput),
    });
  };
  const tavernObservationHandler = (step: AgentStep) => {
    // `observation` steps don't carry toolName directly on the step -
    // the agent calls emitObservationStep(toolName, observation) and the
    // resulting step's `content` is the observation body. Pull toolName
    // from `formatStep` output shape if present, else match the oldest
    // pending id regardless of tool (single-tool default case).
    const toolName = step.metadata?.toolName;
    let toolUseId: string | undefined;
    if (toolName) {
      const queue = pendingToolUseIds.get(toolName);
      if (queue && queue.length > 0) {
        toolUseId = queue.shift();
        if (queue.length === 0) pendingToolUseIds.delete(toolName);
      }
    }
    if (!toolUseId) {
      // Fallback: pop from whichever queue has pending ids (oldest-first).
      for (const [name, queue] of pendingToolUseIds.entries()) {
        if (queue.length > 0) {
          toolUseId = queue.shift();
          if (queue.length === 0) pendingToolUseIds.delete(name);
          break;
        }
      }
    }
    if (!toolUseId) {
      // No matching action - still emit so the row appears, with a
      // synthetic id. Keeps the transcript complete even under drift.
      toolUseId = `orphan-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    }
    void bridgePresence.emitEvent({
      type: 'tool_result',
      tool: toolName,
      toolUseId,
      text: typeof step.content === 'string' ? step.content.slice(0, 4000) : undefined,
    });
  };
  const tavernFinalAnswerHandler = (step: AgentStep) => {
    const text = typeof step.content === 'string' ? step.content : '';
    if (!text) return;
    void bridgePresence.emitEvent({
      type: 'message',
      role: 'assistant',
      text: text.slice(0, 4000),
    });
  };
  agent.on('action', tavernActionHandler);
  agent.on('observation', tavernObservationHandler);
  agent.on('final_answer', tavernFinalAnswerHandler);
  // Mirror subagent events through the same step + tavern handlers so delegated
  // work surfaces in the transcript. A single registration suffices -
  // SubagentOrchestrator's before/after-run setters are single-slot.
  //
  // Usage tracking: each spawned agent gets a live-usage entry in the store
  // (updated per step, driving the status bar), removed when the run ends.
  // Keyed by a per-run id (agent instances are not reused; names can run
  // concurrently). Final totals reach session.metadata separately via the
  // orchestrator's onSubagentUsage callback (wired in index.tsx).
  const subagentRunState = new WeakMap<ReActAgent, { runId: string; usageHandler: () => void }>();
  let nextSubagentRunId = 0;
  orchestrator.setBeforeRunCallback((subagent, subagentType) => {
    subagent.on('thought', stepHandler);
    subagent.on('observation', stepHandler);
    subagent.on('action', stepHandler);
    subagent.on('action', tavernActionHandler);
    subagent.on('observation', tavernObservationHandler);
    subagent.on('final_answer', tavernFinalAnswerHandler);

    const runId = `run-${nextSubagentRunId++}`;
    const usageHandler = () => {
      useCliStore
        .getState()
        .updateLiveSubagentUsage(runId, subagentType, subagent.getTokenUsage(), subagent.getCreditsUsage());
    };
    subagentRunState.set(subagent, { runId, usageHandler });
    usageHandler();
    // Totals update after each LLM call, before the resulting step events fire.
    subagent.on('thought', usageHandler);
    subagent.on('observation', usageHandler);
    subagent.on('final_answer', usageHandler);
  });
  orchestrator.setAfterRunCallback((subagent, _subagentType) => {
    subagent.off('thought', stepHandler);
    subagent.off('observation', stepHandler);
    subagent.off('action', stepHandler);
    subagent.off('action', tavernActionHandler);
    subagent.off('observation', tavernObservationHandler);
    subagent.off('final_answer', tavernFinalAnswerHandler);

    const runState = subagentRunState.get(subagent);
    if (runState) {
      subagent.off('thought', runState.usageHandler);
      subagent.off('observation', runState.usageHandler);
      subagent.off('final_answer', runState.usageHandler);
      subagentRunState.delete(subagent);
      // Only the live entry is cleared here - the session rollup happens via
      // the orchestrator's onSubagentUsage callback (see index.tsx), which
      // fires exactly once per run on every exit path.
      useCliStore.getState().removeLiveSubagentUsage(runState.runId);
    }
  });
}
