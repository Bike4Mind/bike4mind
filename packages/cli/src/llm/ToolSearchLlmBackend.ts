import type { DeferredToolRegistry, ToolReferenceBlock } from '@bike4mind/agents';
import { completionsSupportsToolSearch, type IMessage, type ModelInfo } from '@bike4mind/common';
import type {
  CompletionInfo,
  ICompletionBackend,
  ICompletionOptions,
  ICompletionOptionTools,
} from '@bike4mind/llm-adapters';
import { parseToolReferences, TOOL_SEARCH_TOOL_NAME } from '../tools/cliToolSearchTool.js';

/**
 * Same gate the completions endpoint applies (cliCompletionsToolSearch.ts), so the CLI never sends
 * `tool_reference` blocks the server would refuse. A model missing from `models` reads false.
 */
export function modelServesToolReference(models: readonly ModelInfo[], modelId: string): boolean {
  const model = models.find(m => m.id === modelId);
  return model !== undefined && completionsSupportsToolSearch(model);
}

type ContentBlock = { type?: unknown; id?: unknown; name?: unknown; tool_use_id?: unknown; content?: unknown };

function toolSearchCallIds(messages: IMessage[]): Set<string> {
  const ids = new Set<string>();
  for (const message of messages) {
    if (message.role !== 'assistant' || !Array.isArray(message.content)) continue;
    for (const block of message.content as ContentBlock[]) {
      if (block?.type === 'tool_use' && block.name === TOOL_SEARCH_TOOL_NAME && typeof block.id === 'string') {
        ids.add(block.id);
      }
    }
  }
  return ids;
}

/**
 * Rewrites the content of each tool_search result that holds serialized references. `rewrite`
 * returning undefined leaves that result as is. Returns `messages` itself when nothing changed.
 */
function rewriteToolSearchResults(
  messages: IMessage[],
  rewrite: (references: ToolReferenceBlock[]) => string | ToolReferenceBlock[] | undefined
): IMessage[] {
  const callIds = toolSearchCallIds(messages);
  if (callIds.size === 0) return messages;

  let changed = false;
  const result = messages.map(message => {
    if (message.role !== 'user' || !Array.isArray(message.content)) return message;
    let messageChanged = false;
    const content = (message.content as ContentBlock[]).map(block => {
      if (block?.type !== 'tool_result' || typeof block.content !== 'string') return block;
      if (typeof block.tool_use_id !== 'string' || !callIds.has(block.tool_use_id)) return block;
      const references = parseToolReferences(block.content);
      const replacement = references ? rewrite(references) : undefined;
      if (replacement === undefined) return block;
      messageChanged = true;
      return { ...block, content: replacement };
    });
    if (!messageChanged) return message;
    changed = true;
    return { ...message, content } as IMessage;
  });
  return changed ? result : messages;
}

function asDeferred(tool: ICompletionOptionTools): ICompletionOptionTools {
  // A deferred tool cannot carry cache_control (the endpoint 400s), whatever its source set.
  const { cache_control: _cacheControl, ...toolSchema } = tool.toolSchema as ICompletionOptionTools['toolSchema'] & {
    cache_control?: unknown;
  };
  return { ...tool, toolSchema: { ...toolSchema, defer_loading: true } };
}

export interface ToolSearchRequest {
  messages: IMessage[];
  tools: ICompletionOptionTools[];
}

/**
 * Shapes one request's tools and tool_search results for the model it is sent to. History keeps
 * tool_search results as the serialized text the tool returned, so it stays valid across a model switch.
 *
 * - Native tool search: the live tools other than registry ones, then every registry tool in registry
 *   order with `defer_loading: true`, so the array stays byte-identical across a tool load and the
 *   prompt cache holds. Serialized references become `tool_reference` blocks. A registry tool the live
 *   list holds with no reference left in history (loaded by mutateTools before a model switch, or by
 *   the unknown-tool resolver) is sent non-deferred so it stays callable.
 * - Otherwise: tools unchanged, and any references from an earlier native turn become text, since
 *   the endpoint refuses `tool_reference` there. Referenced tools are already in the live list.
 *
 * Requests without `tool_search` (sub-agents, summaries) pass through untouched.
 */
export function prepareToolSearchRequest(
  request: ToolSearchRequest,
  registry: DeferredToolRegistry,
  native: boolean
): ToolSearchRequest {
  const { messages, tools } = request;
  if (registry.size() === 0 || !tools.some(t => t.toolSchema.name === TOOL_SEARCH_TOOL_NAME)) return request;

  if (!native) {
    const textMessages = rewriteToolSearchResults(
      messages,
      references =>
        `Loaded ${references.length} tool schema(s): ${references.map(r => r.tool_name).join(', ')}. These are now callable in your next message.`
    );
    return textMessages === messages ? request : { messages: textMessages, tools };
  }

  const registryTools = registry.getAll();
  const wireTools = tools.filter(t => !registry.has(t.toolSchema.name));
  const wireNames = new Set([...wireTools, ...registryTools].map(t => t.toolSchema.name));
  const referenced = new Set<string>();
  const wireMessages = rewriteToolSearchResults(messages, references => {
    // A reference to a tool no longer offered (e.g. an MCP server disconnected) is dropped, and the
    // result is rewritten to the resolved subset, so one stale name does not un-defer the rest.
    const resolved = references.filter(r => wireNames.has(r.tool_name));
    if (resolved.length === 0) return undefined;
    for (const reference of resolved) referenced.add(reference.tool_name);
    return resolved.length === references.length ? references : resolved;
  });

  const liveNames = new Set(tools.map(t => t.toolSchema.name));
  for (const tool of registryTools) {
    const name = tool.toolSchema.name;
    wireTools.push(liveNames.has(name) && !referenced.has(name) ? tool : asDeferred(tool));
  }

  // Defensive only: tool_search itself is never a deferred registry tool, so every tool cannot be
  // deferred in the current wiring.
  if (wireTools.every(t => t.toolSchema.defer_loading === true)) return request;
  return { messages: wireMessages, tools: wireTools };
}

/**
 * Decorator that applies prepareToolSearchRequest per call, for the model each call actually goes to.
 * Sits inside FallbackLlmBackend so a fallback model is shaped for itself.
 */
export class ToolSearchLlmBackend implements ICompletionBackend {
  private lastToolSearchRequestNative = false;

  constructor(
    private readonly inner: ICompletionBackend,
    private readonly registry: DeferredToolRegistry,
    private readonly models: readonly ModelInfo[]
  ) {}

  get currentModel(): string {
    return this.inner.currentModel;
  }

  set currentModel(model: string) {
    this.inner.currentModel = model;
  }

  /** Whether the last request offering tool_search went to a native tool search model. */
  servesToolReference(): boolean {
    return this.lastToolSearchRequestNative;
  }

  async complete(
    model: string,
    messages: IMessage[],
    options: Partial<ICompletionOptions>,
    callback: (text: (string | null | undefined)[], completionInfo?: CompletionInfo) => Promise<void>
  ): Promise<void> {
    const tools = options.tools ?? [];
    if (!tools.some(t => t.toolSchema.name === TOOL_SEARCH_TOOL_NAME)) {
      return this.inner.complete(model, messages, options, callback);
    }
    const native = modelServesToolReference(this.models, model);
    this.lastToolSearchRequestNative = native;
    const prepared = prepareToolSearchRequest({ messages, tools }, this.registry, native);
    const preparedOptions = prepared.tools === tools ? options : { ...options, tools: prepared.tools };
    return this.inner.complete(model, prepared.messages, preparedOptions, callback);
  }

  pushToolMessages(
    messages: IMessage[],
    tool: { name: string; id: string; parameters: string },
    result: string,
    thinkingBlocks?: unknown[]
  ): void {
    this.inner.pushToolMessages(messages, tool, result, thinkingBlocks);
  }

  async getModelInfo(): Promise<ModelInfo[]> {
    return this.inner.getModelInfo();
  }
}
