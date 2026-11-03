import {
  BadRequestError,
  completionsSupportsToolChanges,
  completionsSupportsToolSearch,
  isCompletionServerTool,
  isToolChangeMessage,
  isToolChangeBlockType,
  TOOL_SEARCH_BLOCK_TYPES,
  type CompletionCustomTool,
  type CompletionTool,
  type CompletionToolErrorCode,
  type CompletionsToolCapabilityModel,
  ToolChangeMessageContentSchema,
  ToolSearchServerToolSchema,
  type IMessage,
  type ToolSearchServerTool,
} from '@bike4mind/common';

export interface PreparedWireTools {
  tools: CompletionCustomTool[];
  /** Forwarded as ICompletionOptions.providerTools; empty unless the model serves tool search here. */
  providerTools: ToolSearchServerTool[];
}

function toolSearchError(message: string, errorCode: CompletionToolErrorCode): BadRequestError {
  return new BadRequestError(message, { errorCode });
}

type ScannedBlock = { type?: unknown; name?: unknown; content?: unknown };

/**
 * A block only tool search produces. Other server tools (web_search, ...) also emit server_tool_use,
 * and those are left alone here as they were before tool search existed.
 */
function isToolSearchBlock(block: ScannedBlock): boolean {
  if (block.type === 'server_tool_use') {
    return typeof block.name === 'string' && block.name.startsWith('tool_search_tool_');
  }
  return typeof block.type === 'string' && TOOL_SEARCH_BLOCK_TYPES.has(block.type);
}

/** tool_reference blocks sit in a tool_result's content array, or in a tool_search_tool_result's `content.tool_references`. */
function toolReferencesOf(block: ScannedBlock): unknown[] {
  if (block.type === 'tool_result') return Array.isArray(block.content) ? block.content : [];
  if (block.type !== 'tool_search_tool_result') return [];
  const references = (block.content as { tool_references?: unknown } | null | undefined)?.tool_references;
  return Array.isArray(references) ? references : [];
}

function scanMessages(messages: IMessage[]): { referencedTools: unknown[]; echoesToolSearchBlocks: boolean } {
  const referencedTools: unknown[] = [];
  let echoesToolSearchBlocks = false;
  for (const message of messages) {
    if (!Array.isArray(message.content)) continue;
    for (const block of message.content as ScannedBlock[]) {
      if (typeof block?.type !== 'string') continue;
      if (isToolSearchBlock(block)) echoesToolSearchBlocks = true;
      for (const inner of toolReferencesOf(block) as Array<{ type?: unknown; tool_name?: unknown } | null>) {
        if (inner?.type === 'tool_reference') referencedTools.push(inner.tool_name);
      }
    }
  }
  return { referencedTools, echoesToolSearchBlocks };
}

/** An assistant turn ending in a tool search result is one the provider accepts a change after; other server results are refused until verified. */
function endsInToolSearchResult(message: IMessage): boolean {
  if (message.role !== 'assistant' || !Array.isArray(message.content)) return false;
  const last = (message.content as ScannedBlock[]).findLast(block => !isBlankTextBlock(block));
  return last?.type === 'tool_search_tool_result';
}

function isBlankTextBlock(block: unknown): boolean {
  if (typeof block !== 'object' || block === null || !('type' in block) || block.type !== 'text') return false;
  return !('text' in block) || typeof block.text !== 'string' || block.text.trim() === '';
}

/** Must stay in sync with AnthropicBackend.sanitizeMessageContent, which drops these before sending. */
function isBlankMessage(message: IMessage): boolean {
  if (typeof message.content === 'string') return message.content.trim() === '';
  if (!Array.isArray(message.content)) return false;
  return message.content.every(isBlankTextBlock);
}

/** Plain system prompts are hoisted and blank messages are dropped by the Claude adapter. */
function isWireMessage(message: IMessage): boolean {
  return (message.role !== 'system' || isToolChangeMessage(message)) && !isBlankMessage(message);
}

export function hasAssistantPrefill(messages: IMessage[]): boolean {
  const lastMessage = messages.findLast(isWireMessage);
  if (lastMessage?.role !== 'assistant') return false;
  if (!Array.isArray(lastMessage.content)) return true;

  const lastBlock = (lastMessage.content as ScannedBlock[]).findLast(block => !isBlankTextBlock(block));
  // A paused server-tool turn is resumed verbatim, rather than continued from a text prefill.
  return typeof lastBlock?.type !== 'string' || !TOOL_SEARCH_BLOCK_TYPES.has(lastBlock.type);
}

/**
 * Validates the mid-conversation tool changes in `messages` (system messages of tool_addition /
 * tool_removal blocks). Plain system messages and blank messages are skipped when looking at
 * neighbours: the adapter hoists the former into the system prompt and drops the latter, so neither
 * is between turns on the wire.
 */
function validateToolChanges(
  messages: IMessage[],
  customTools: CompletionCustomTool[],
  model: CompletionsToolCapabilityModel | undefined
): void {
  const misplaced = messages.find(
    m => m.role !== 'system' && Array.isArray(m.content) && m.content.some(isToolChangeBlockType)
  );
  if (misplaced) {
    throw toolSearchError(
      `A tool_addition or tool_removal block is only accepted in a system message, not in a ${misplaced.role} message.`,
      'invalid_tool_change'
    );
  }

  const changes = messages.filter(isToolChangeMessage);
  if (changes.length === 0) return;

  const declared = new Set(customTools.map(tool => tool.toolSchema.name));
  const mcpTools = new Set(customTools.filter(tool => tool._isMcpTool).map(tool => tool.toolSchema.name));

  if (!model || !completionsSupportsToolChanges(model)) {
    throw toolSearchError(
      `Model '${model?.id ?? 'unknown'}' does not support mid-conversation tool changes on this endpoint (see supports_tool_changes and backend in GET /api/v1/models). Remove the tool_addition and tool_removal messages.`,
      'tool_changes_unsupported'
    );
  }

  const wire = messages.filter(isWireMessage);
  wire.forEach((message, index) => {
    if (!isToolChangeMessage(message)) return;
    const parsed = ToolChangeMessageContentSchema.safeParse(message.content);
    if (!parsed.success) {
      throw toolSearchError(
        'A tool change message must hold only { type: "tool_addition" | "tool_removal", tool: { type: "tool_reference", name } } blocks.',
        'invalid_tool_change'
      );
    }
    const previous = wire[index - 1];
    const next = wire[index + 1];
    const followsTurn = previous !== undefined && (previous.role === 'user' || endsInToolSearchResult(previous));
    const precedesTurn = next === undefined || next.role === 'assistant';
    if (!followsTurn || !precedesTurn) {
      throw toolSearchError(
        'A tool change message must follow a user message or an assistant message ending in a tool search result, and be the last message or be followed by an assistant message.',
        'invalid_tool_change'
      );
    }
    for (const { tool } of parsed.data) {
      if (mcpTools.has(tool.name)) {
        throw toolSearchError(
          `A tool change cannot name '${tool.name}', an MCP tool; only tools defined in tools can be added or removed.`,
          'invalid_tool_change'
        );
      }
      if (declared.has(tool.name)) continue;
      throw toolSearchError(`A tool change names '${tool.name}', which is not in tools.`, 'unknown_tool_reference');
    }
  });
}

function withoutNativeFields(tool: CompletionCustomTool, keepDeferLoading: boolean): CompletionCustomTool {
  const { cache_control: _cacheControl, defer_loading: deferLoading, ...toolSchema } = tool.toolSchema;
  return {
    ...tool,
    toolSchema:
      keepDeferLoading && deferLoading !== undefined ? { ...toolSchema, defer_loading: deferLoading } : toolSchema,
  };
}

/**
 * Validates the tool search parts of a completions request and splits wire tools into what the adapter
 * receives. Tool search is honoured only where completionsSupportsToolSearch says the resolved adapter
 * forwards it; anywhere else `defer_loading` is dropped (every tool sent as before) and anything that
 * only works with tool search is refused, so the caller never silently gets a different request.
 */
export function prepareWireTools(
  tools: CompletionTool[] | undefined,
  messages: IMessage[],
  model: CompletionsToolCapabilityModel | undefined
): PreparedWireTools {
  const customTools: CompletionCustomTool[] = [];
  const serverTools: ToolSearchServerTool[] = [];
  for (const tool of tools ?? []) {
    if (isCompletionServerTool(tool)) {
      const parsed = ToolSearchServerToolSchema.safeParse(tool.serverTool);
      if (!parsed.success) {
        throw toolSearchError(
          'serverTool must be a tool search server tool (tool_search_tool_regex_20251119 or tool_search_tool_bm25_20251119; see ToolSearchServerToolSchema).',
          'tool_search_unsupported'
        );
      }
      serverTools.push(parsed.data);
    } else customTools.push(tool);
  }

  validateToolChanges(messages, customTools, model);

  const { referencedTools, echoesToolSearchBlocks } = scanMessages(messages);
  const native = model !== undefined && completionsSupportsToolSearch(model);

  if (!native) {
    if (serverTools.length > 0 || referencedTools.length > 0 || echoesToolSearchBlocks) {
      throw toolSearchError(
        `Model '${model?.id ?? 'unknown'}' does not support tool search on this endpoint (see supports_tool_search in GET /api/v1/models). Remove the serverTool entry, tool_reference blocks and echoed tool search blocks.`,
        'tool_search_unsupported'
      );
    }
    return { tools: customTools.map(tool => withoutNativeFields(tool, false)), providerTools: [] };
  }

  const deferred = customTools.filter(tool => tool.toolSchema.defer_loading === true);
  const cachedDeferred = deferred.find(tool => tool.toolSchema.cache_control != null);
  if (cachedDeferred) {
    throw toolSearchError(
      `Tool '${cachedDeferred.toolSchema.name}' sets both defer_loading and cache_control; a deferred tool cannot carry cache_control.`,
      'deferred_tool_cache_control'
    );
  }
  if (deferred.length > 0 && deferred.length === customTools.length && serverTools.length === 0) {
    throw toolSearchError(
      'Every tool sets defer_loading: true. Keep at least one tool non-deferred or add a serverTool entry.',
      'all_tools_deferred'
    );
  }

  const declared = new Set(customTools.map(tool => tool.toolSchema.name));
  for (const name of referencedTools) {
    if (typeof name === 'string' && declared.has(name)) continue;
    throw toolSearchError(
      typeof name === 'string'
        ? `A tool_reference names '${name}', which is not in tools.`
        : 'A tool_reference must carry a string tool_name.',
      'unknown_tool_reference'
    );
  }

  return { tools: customTools.map(tool => withoutNativeFields(tool, true)), providerTools: serverTools };
}
