import {
  BadRequestError,
  completionsSupportsToolSearch,
  isCompletionServerTool,
  ModelBackend,
  supportsToolSearch,
  TOOL_SEARCH_BLOCK_TYPES,
  type CompletionCustomTool,
  type CompletionTool,
  type CompletionToolErrorCode,
  type CompletionsToolCapabilityModel,
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

  const { referencedTools, echoesToolSearchBlocks } = scanMessages(messages);
  const native = model !== undefined && completionsSupportsToolSearch(model);

  if (!native) {
    if (serverTools.length > 0 || referencedTools.length > 0 || echoesToolSearchBlocks) {
      const reason =
        model && model.backend === ModelBackend.Bedrock && supportsToolSearch(model)
          ? `is served through Bedrock, where this endpoint does not support tool search yet; use a direct Anthropic model id`
          : `does not support tool search on this endpoint (see supports_tool_search and backend in GET /api/v1/models)`;
      throw toolSearchError(
        `Model '${model?.id ?? 'unknown'}' ${reason}. Remove the serverTool entry, tool_reference blocks and echoed tool search blocks.`,
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
