import type { DeferredToolRegistry, ToolSearchLogger } from '@bike4mind/agents';
import type { ModelInfo } from '@bike4mind/common';
import type { ICompletionBackend, ICompletionOptionTools } from '@bike4mind/llm-adapters';
import { ToolSearchLlmBackend } from '../llm/ToolSearchLlmBackend.js';
import { createCliToolSearchTool } from '../tools/cliToolSearchTool.js';

export interface BuildToolSearchInput {
  /** The main agent's backend, before FallbackLlmBackend wraps it. */
  llm: ICompletionBackend;
  models: readonly ModelInfo[];
  registry: DeferredToolRegistry;
  logger?: ToolSearchLogger;
  /** Holder wired to the agent's live tools array once the agent exists (see buildAgent). */
  agentToolsRef: { current: ICompletionOptionTools[] | null };
}

/**
 * The main agent's tool_search and the backend that shapes its requests per model: native tool search
 * (`toolReference` + `defer_loading`) where the model serves it, `mutateTools` everywhere else. With no
 * deferred tools there is no tool_search and the backend is returned unwrapped.
 */
export function buildToolSearch(input: BuildToolSearchInput): {
  llm: ICompletionBackend;
  toolSearchTool: ICompletionOptionTools | null;
} {
  const { llm, models, registry, logger, agentToolsRef } = input;
  if (registry.size() === 0) return { llm, toolSearchTool: null };

  const toolSearchLlm = new ToolSearchLlmBackend(llm, registry, models);
  const toolSearchTool = createCliToolSearchTool({
    registry,
    logger,
    toolListAccessor: () => {
      if (!agentToolsRef.current) throw new Error('tool_search invoked before agent context was wired');
      return agentToolsRef.current;
    },
    useToolReference: () => toolSearchLlm.servesToolReference(),
  });
  return { llm: toolSearchLlm, toolSearchTool };
}
