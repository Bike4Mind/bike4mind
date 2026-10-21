import { executeTool } from '../../../llm/ToolRouter.js';
import type { ApiClient } from '../../../auth/ApiClient.js';
import { sanitizeToolOutput } from '../../../utils/toolOutputSanitizer.js';
import type { ToolArgs } from '../gatewayTypes.js';

/**
 * Run the tool once and redact, then cap, what it produced. Every execution in the gateway
 * (the first attempt, the unsandboxed retry, the fuzzy-edit and directory-grant retries) goes
 * through here, so nothing the tool returns or throws reaches the sandbox-denial and path-denial
 * checks, the prompts or the model unsanitized.
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
