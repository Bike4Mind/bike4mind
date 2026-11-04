/** The server's classifier for a billed tool call refused because the account cannot cover it (HTTP 422). */
export const INSUFFICIENT_CREDITS_CODE = 'insufficient_credits';

/**
 * The tool result the model reads when a billed server tool (web_search, web_fetch) is refused for
 * credits. It keeps the "Error executing <tool>:" form of every other server-tool failure, and says the
 * call never ran so the model tells the user rather than retrying or answering as if it had searched.
 */
export function outOfCreditsToolResult(toolName: string, serverMessage?: string): string {
  const detail = serverMessage ? ` ${serverMessage}` : '';
  return `Error executing ${toolName}: the account is out of credits, so the tool did not run. Tell the user to add credits, then try again.${detail}`;
}
