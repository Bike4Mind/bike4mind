import { executeTool } from '../../../llm/ToolRouter.js';
import type { ApiClient } from '../../../auth/ApiClient.js';
import { sanitizeToolOutput } from '../../../utils/toolOutputSanitizer.js';
import type { ToolArgs } from '../gatewayTypes.js';

/**
 * Run the tool once and redact, then cap, what it produced. Every execution in the gateway
 * (the first attempt, the unsandboxed retry, the fuzzy-edit and directory-grant retries) goes
 * through here, so no returned result or thrown error message reaches the sandbox-denial and
 * path-denial checks or the model unsanitized. A thrown error's other fields (the fuzzy-edit
 * diffPreview shown to the local user) are not redacted.
 */
export async function executeSanitized(
  toolName: string,
  args: ToolArgs,
  apiClient: ApiClient,
  originalFn: (args: unknown) => Promise<string>
): Promise<string> {
  try {
    return sanitizeToolOutput(await executeTool(toolName, args, apiClient, originalFn));
  } catch (error) {
    throw sanitizeThrown(error);
  }
}

/**
 * A thrown Error is sanitized in place so its subtype and custom fields survive: the fuzzy-edit
 * stage re-inspects the error it catches, and the path-denial check reads `.message`.
 */
export function sanitizeThrown(error: unknown): Error {
  if (!(error instanceof Error)) return new Error(sanitizeToolOutput(String(error)));
  error.message = sanitizeToolOutput(error.message);
  return error;
}
