import {
  createToolSearchTool,
  type DeferredToolRegistry,
  type ToolListAccessor,
  type ToolReferenceBlock,
  type ToolSearchLogger,
} from '@bike4mind/agents';
import type { ICompletionOptionTools } from '@bike4mind/llm-adapters';

export const TOOL_SEARCH_TOOL_NAME = 'tool_search';

export interface CliToolSearchToolOptions {
  registry: DeferredToolRegistry;
  logger?: ToolSearchLogger;
  toolListAccessor: ToolListAccessor;
  /** Read per call: true when the model that just asked for tools serves native tool search. */
  useToolReference: () => boolean;
}

/**
 * The `tool_reference` blocks a `toolReference` tool_search result serializes to, or null for any
 * other text (a no-match hint, a mutateTools result, or a result with an appended warning).
 * Extra keys are tolerated so a field added to the core serializer does not silently disable the
 * native path, and dropped because the provider rejects a `tool_reference` block with any other field.
 */
export function parseToolReferences(text: string): ToolReferenceBlock[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed) || parsed.length === 0) return null;
  const isReference = (block: unknown): block is ToolReferenceBlock =>
    typeof block === 'object' &&
    block !== null &&
    (block as ToolReferenceBlock).type === 'tool_reference' &&
    typeof (block as ToolReferenceBlock).tool_name === 'string';
  return parsed.every(isReference) ? parsed.map(({ type, tool_name }) => ({ type, tool_name })) : null;
}

/**
 * The CLI's `tool_search`: one schema, with the load strategy picked per call so a `/model` switch or a
 * fallback model takes effect on the next search. Both strategies share the registry's search and
 * ranking. With `toolReference` the matched tools are still added to the live list, because the agent
 * executes only tools it holds; ToolSearchLlmBackend keeps them deferred on the wire.
 */
export function createCliToolSearchTool(options: CliToolSearchToolOptions): ICompletionOptionTools {
  const { registry, logger, toolListAccessor, useToolReference } = options;
  const mutating = createToolSearchTool({ registry, logger, toolListAccessor });
  const referencing = createToolSearchTool({ registry, logger, loadStrategy: 'toolReference' });

  return {
    toolSchema: mutating.toolSchema,
    toolFn: async params => {
      if (!useToolReference()) return mutating.toolFn(params);

      const result = await referencing.toolFn(params);
      const references = parseToolReferences(result);
      if (references) {
        const liveTools = toolListAccessor();
        const liveNames = new Set(liveTools.map(t => t.toolSchema.name));
        for (const tool of registry.getByNames(references.map(r => r.tool_name))) {
          if (liveNames.has(tool.toolSchema.name)) continue;
          liveNames.add(tool.toolSchema.name);
          liveTools.push(tool);
        }
      }
      return result;
    },
  };
}
