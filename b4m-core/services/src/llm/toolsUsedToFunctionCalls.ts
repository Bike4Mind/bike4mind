export type ToolsUsedEntry = {
  name: string;
  arguments?: string;
  id?: string;
  returnValue?: string;
  success?: boolean;
};

export type MappedFunctionCall = {
  name?: string;
  parameters: Record<string, unknown>;
  id?: string;
  returnValue?: string;
  success?: boolean;
};

/**
 * Maps a backend's `toolsUsed` array onto `quest.promptMeta.functionCalls`. Lifted out of
 * ChatCompletionProcess (see settleToolCredits.ts for the same lift-a-pure-helper pattern)
 * so the malformed-arguments guard and the returnValue/success carry-through are each
 * independently testable - this is the single choke point where a future whitelist
 * regression could silently discard everything the backends attach to toolsUsed.
 */
export function toolsUsedToFunctionCalls(
  toolsUsed: ToolsUsedEntry[],
  onParseError?: (info: { toolName?: string; argumentsPreview: string; error: string }) => void
): MappedFunctionCall[] {
  return toolsUsed.map(tool => {
    let parameters: Record<string, unknown> = {};
    try {
      parameters = JSON.parse(tool.arguments || '{}');
    } catch (e) {
      onParseError?.({
        toolName: tool.name,
        argumentsPreview: (tool.arguments || '').substring(0, 100),
        error: e instanceof Error ? e.message : String(e),
      });
    }
    return { name: tool.name, parameters, id: tool.id, returnValue: tool.returnValue, success: tool.success };
  });
}
