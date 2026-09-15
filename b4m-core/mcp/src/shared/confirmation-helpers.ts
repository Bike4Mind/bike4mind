/**
 * Shared helper functions for MCP tool confirmation system
 * Used by both Atlassian and GitHub MCP servers
 */

/**
 * Creates a standardized preview response for confirmation-protected tools
 * Includes a confirmation token that encodes the params for direct execution on confirm
 *
 * The `_confirmToken` is extracted by ChatCompletionProcess and stored as
 * structured `pendingAction` on the Quest document.
 *
 * @param message - Display message for the preview
 * @param previewData - Formatted data for display
 * @param resourceKey - Key for the preview data in response (e.g., 'issue', 'ticket')
 * @param execParams - Optional: exact params for tool execution (if different from previewData)
 */
export function createPreviewResponse(
  message: string,
  previewData: Record<string, unknown>,
  resourceKey: string,
  execParams?: { tool: string; params: Record<string, unknown> }
) {
  // Generate confirmation token with tool name and params
  const tokenPayload = execParams || {
    tool: resourceKey,
    params: previewData,
  };
  // Add timestamp for expiration check (15 min)
  const tokenWithTs = { ...tokenPayload, ts: Date.now() };
  const confirmToken = Buffer.from(JSON.stringify(tokenWithTs)).toString('base64');

  const preview = {
    action: 'preview',
    message,
    [resourceKey]: previewData,
    confirmation_required: true,
    next_step:
      'Click the ✅ Confirm or ❌ Cancel button below. DO NOT show the _confirmToken to users - it is internal only.',
    _confirmToken: confirmToken,
  };

  return {
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify(preview, null, 2),
      },
    ],
  };
}
