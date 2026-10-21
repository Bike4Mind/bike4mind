import type { ICompletionOptionTools } from '@bike4mind/llm-adapters';
import { z } from 'zod';
import type { DeferredToolRegistry, ToolSearchLogger } from './DeferredToolRegistry';

/**
 * Default number of tools returned for a keyword search. Matches Claude
 * Code's ToolSearch convention. 5 keeps the response payload small while
 * surfacing enough alternatives for the model to refine its query.
 */
const DEFAULT_MAX_RESULTS = 5;
/**
 * Hard cap to prevent the model from requesting an unreasonable batch
 * (e.g. `max_results: 1000`). 20 covers any realistic MCP server today
 * (GitHub MCP has 41 tools and even there a single search rarely needs
 * more than ~10 matches). Bump if a server with denser tool families
 * ever justifies it.
 */
const HARD_MAX_RESULTS = 20;

/**
 * Get-or-mutate closure for the live agent.context.tools array.
 *
 * Why a closure: the ReActAgent is constructed after the tool list is
 * assembled, so we can't capture `agent.context.tools` directly. Instead
 * we capture a getter that resolves to the live array at call time.
 *
 * The getter MUST return the same array instance that the agent reads
 * from each iteration - pushing into a copy will not make schemas
 * available to subsequent iterations.
 */
export type ToolListAccessor = () => ICompletionOptionTools[];

/** A `tool_reference` content block, as Anthropic expects inside a `tool_result`. */
export interface ToolReferenceBlock {
  type: 'tool_reference';
  tool_name: string;
}

/**
 * How matched tools reach the model:
 * - `mutateTools` (default): push the schemas into the live agent tool list so they
 *   are callable next iteration, and echo them as text.
 * - `toolReference`: leave the tool list alone and answer with `tool_reference` blocks,
 *   which a provider with native tool search expands server-side.
 */
export type ToolLoadStrategyName = 'mutateTools' | 'toolReference';

export type ToolSearchToolOptions = {
  registry: DeferredToolRegistry;
  logger?: ToolSearchLogger;
} & (
  | { loadStrategy?: 'mutateTools'; toolListAccessor: ToolListAccessor }
  | { loadStrategy: 'toolReference'; toolListAccessor?: undefined }
);

/**
 * Runtime validation for tool_search params. The LLM produces these
 * values, so we validate at this boundary rather than trusting the
 * shape. Coerces `max_results` from string->number for models that emit
 * numeric-looking strings.
 */
const ToolSearchParamsSchema = z.object({
  query: z.string().min(1, 'query must be a non-empty string'),
  max_results: z.coerce.number().int().min(1).max(HARD_MAX_RESULTS).optional(),
});

/**
 * Parse the query string. Two forms:
 *   - `select:name1,name2,...` - exact-name selection
 *   - free text - keyword search across name + description
 */
function parseQuery(query: string): { mode: 'select'; names: string[] } | { mode: 'search'; text: string } {
  const trimmed = query.trim();
  const selectMatch = trimmed.match(/^select:(.+)$/i);
  if (selectMatch) {
    const names = selectMatch[1]
      .split(',')
      .map(n => n.trim())
      .filter(n => n.length > 0);
    return { mode: 'select', names };
  }
  return { mode: 'search', text: trimmed };
}

/**
 * Format the loaded-tools response. Mirrors Claude Code's convention:
 * one <function>{...}</function> line per matched tool. The model has
 * already seen this format in its tool-registration system messages, so
 * it parses without additional explanation.
 *
 * Note: the schemas are *also* injected into context.tools by the caller,
 * so on the next iteration the model gets them as native tool definitions.
 * The text response here is for in-turn awareness and audit trail.
 */
function renderToolsBlock(tools: ICompletionOptionTools[]): string {
  if (tools.length === 0) return '';
  const lines = tools.map(tool => {
    const schema = {
      description: tool.toolSchema.description,
      name: tool.toolSchema.name,
      parameters: tool.toolSchema.parameters,
    };
    return `<function>${JSON.stringify(schema)}</function>`;
  });
  return `<functions>\n${lines.join('\n')}\n</functions>`;
}

/** Push matched tools into the live list, skipping ones already loaded. Returns the count added. */
function mutateTools(toolListAccessor: ToolListAccessor, matched: ICompletionOptionTools[]): number {
  const liveTools = toolListAccessor();
  const liveNames = new Set(liveTools.map(t => t.toolSchema.name));
  let added = 0;
  for (const tool of matched) {
    if (!liveNames.has(tool.toolSchema.name)) {
      liveTools.push(tool);
      added++;
    }
  }
  return added;
}

/**
 * Build the tool_search meta-tool over the supplied registry. With the default
 * `mutateTools` strategy the returned tool closes over `toolListAccessor` to push
 * newly-resolved schemas into the live agent context.
 *
 * Idempotent: re-loading a tool that's already in the context is a no-op.
 */
export function createToolSearchTool(options: ToolSearchToolOptions): ICompletionOptionTools {
  const { registry, logger } = options;

  return {
    toolSchema: {
      name: 'tool_search',
      description:
        "Fetches full schema definitions for deferred tools so they can be called. Deferred tools appear by name only in a system reminder; their parameter schemas are NOT loaded by default. Use this tool to load schemas on demand. Query forms: 'select:name1,name2' for exact selection, or free-text keywords to search by name and description. Once a tool's schema is returned, it becomes callable in subsequent turns.",
      parameters: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description:
              "Either 'select:<comma-separated names>' to fetch specific tools, or free-text keywords (e.g. 'github pull request') to rank-search deferred tools.",
          },
          max_results: {
            type: 'number',
            description: `Maximum number of tools to return for keyword search. Defaults to ${DEFAULT_MAX_RESULTS}. Ignored for 'select:' queries.`,
          },
        },
        required: ['query'],
      },
    },
    toolFn: async (params?: unknown) => {
      const parsedParams = ToolSearchParamsSchema.safeParse(params ?? {});
      if (!parsedParams.success) {
        const issue = parsedParams.error.issues[0];
        return `tool_search: invalid parameters \u2014 ${issue.path.join('.') || 'params'}: ${issue.message}`;
      }
      const { query, max_results } = parsedParams.data;
      const parsed = parseQuery(query);

      let matched: ICompletionOptionTools[];
      let unmatched: string[] = [];
      if (parsed.mode === 'select') {
        matched = registry.getByNames(parsed.names);
        const foundNames = new Set(matched.map(t => t.toolSchema.name));
        unmatched = parsed.names.filter(n => !foundNames.has(n));
      } else {
        // max_results only applies to keyword search; `select:` returns
        // whatever names matched regardless of count.
        const max = max_results ?? DEFAULT_MAX_RESULTS;
        matched = registry.searchByKeywords(parsed.text, max);
      }

      if (matched.length === 0) {
        const hint =
          parsed.mode === 'select'
            ? `tool_search: no deferred tools matched ${parsed.names.join(', ')}. Use a free-text query to search.`
            : `tool_search: no deferred tools matched query "${parsed.text}".`;
        return hint;
      }

      if (options.loadStrategy === 'toolReference') {
        const references: ToolReferenceBlock[] = matched.map(t => ({
          type: 'tool_reference',
          tool_name: t.toolSchema.name,
        }));
        logger?.debug(`[tool_search] query="${query}" matched=${matched.length} strategy=toolReference`);
        // toolFn is typed to return a string, so the blocks travel serialized.
        return JSON.stringify(references);
      }

      const added = mutateTools(options.toolListAccessor, matched);
      logger?.debug(
        `[tool_search] query="${query}" matched=${matched.length} added=${added} alreadyLoaded=${matched.length - added}`
      );

      const block = renderToolsBlock(matched);
      const summary = `Loaded ${added} new tool schema(s)${
        added < matched.length ? ` (${matched.length - added} already loaded)` : ''
      }. These are now callable in your next message.${
        unmatched.length > 0 ? `\n\nNot found: ${unmatched.join(', ')}` : ''
      }`;

      return `${summary}\n\n${block}`;
    },
  };
}
