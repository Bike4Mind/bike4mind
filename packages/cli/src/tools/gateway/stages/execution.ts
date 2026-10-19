import { realpathSync } from 'fs';
import path from 'path';
import { executeTool } from '../../../llm/ToolRouter.js';
import { getProcessHooks } from '../../../utils/processHooks.js';
import type { ApiClient } from '../../../auth/ApiClient.js';
import type { CheckpointStore } from '../../../storage/CheckpointStore.js';
import type { SandboxOrchestrator } from '../../../sandbox/SandboxOrchestrator.js';
import type { ToolDescriptor } from '../toolDescriptor.js';
import { writePathOf } from '../toolPolicy.js';
import type { AgentContext, ShowKindedPermissionPrompt, ShowPermissionPrompt, ToolArgs } from '../gatewayTypes.js';
import { captureViolations, isSandboxFailure } from './sandbox.js';
import { executeWithFuzzyConfirmation } from './fuzzyEdit.js';

export type ExecutionInput = {
  toolName: string;
  descriptor: ToolDescriptor | undefined;
  /** The call's args as the model sent them (before sandbox rewriting and gate binding). */
  rawArgs: ToolArgs | undefined;
  /** The args handed to the tool. */
  execArgs: ToolArgs;
  isSandboxed: boolean;
  originalFn: (args: unknown) => Promise<string>;
  apiClient: ApiClient;
  showPermissionPrompt: ShowPermissionPrompt;
  agentContext: AgentContext;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  configStore: any; // ConfigStore instance (no shared interface)
  sandboxOrchestrator?: SandboxOrchestrator;
  allowedDirectories?: string[];
  checkpointStore?: CheckpointStore | null;
};

/**
 * Run an approved call: checkpoint, execute (ToolRouter redacts and caps the output), capture
 * sandbox violations, offer retry on a sandbox failure or a path denial, then fire the
 * post-tool signals.
 */
export async function executeAndRecord(input: ExecutionInput): Promise<string> {
  const { toolName, descriptor, rawArgs, execArgs, isSandboxed, originalFn, apiClient, showPermissionPrompt } = input;
  await checkpointBeforeWrite(input.checkpointStore, toolName, writePathOf(descriptor, rawArgs));
  let result: string;
  try {
    result = await executeWithFuzzyConfirmation(toolName, execArgs, apiClient, originalFn, showPermissionPrompt);
  } catch (err) {
    // grep_search / glob_files re-throw path-validation errors instead
    // of returning them as a string. Normalize a denial to a string so
    // the grant flow below handles both tool shapes uniformly; re-throw
    // anything that isn't a path denial.
    const msg = err instanceof Error ? err.message : String(err);
    if (!isPathAccessDenial(msg)) throw err;
    result = msg;
  }
  await captureViolations(isSandboxed, result, rawArgs?.command as string | undefined, input.sandboxOrchestrator);
  result = await retrySandboxFailure(
    isSandboxed,
    result,
    toolName,
    rawArgs as ToolArgs,
    apiClient,
    originalFn,
    showPermissionPrompt
  );
  // Offer to grant access when the tool was blocked by the filesystem
  // allow-list, then retry - the runtime equivalent of `/add-dir`.
  result = await retryPathAccessDenial(
    result,
    toolName,
    execArgs,
    input.allowedDirectories,
    input.configStore,
    apiClient,
    originalFn,
    showPermissionPrompt
  );
  notifyFileChanged(input.agentContext, writePathOf(descriptor, execArgs), result);
  // Process-hook (host action_required signal): a tool finished - clear the
  // block sentinel (matcher "*").
  void getProcessHooks()?.firePostToolUse(toolName);
  return result;
}

/**
 * Snapshot the target of a file write in the shadow git repo so /undo can restore it. Called
 * once the permission gate approves the write, so a write denied there or blocked by plan mode
 * leaves no checkpoint (a later fuzzy-edit re-prompt or directory grant can still be denied after
 * it). A checkpoint failure never blocks the write.
 */
async function checkpointBeforeWrite(
  checkpointStore: CheckpointStore | null | undefined,
  toolName: string,
  writePath: string | undefined
): Promise<void> {
  if (!checkpointStore || !writePath) return;
  try {
    await checkpointStore.createCheckpoint(toolName, [writePath], `before-${toolName}-${path.basename(writePath)}`);
  } catch {
    // Best effort: losing an undo point must not fail the user's write.
  }
}

// Must stay in sync with the success strings returned by the core editLocalFile
// and createFile tools; a denial or failure returns a different string. deleteFile's
// "File deleted successfully" is deliberately not matched: a deleted file is not reported.
const FILE_WRITE_SUCCESS = /^File (edited|created|overwritten) successfully: /;

function notifyFileChanged(agentContext: AgentContext, writePath: string | undefined, result: string): void {
  if (!agentContext.onFileChanged || !writePath || !FILE_WRITE_SUCCESS.test(result)) return;
  agentContext.onFileChanged(writePath);
}

/**
 * If the result looks like a sandbox runtime failure, prompt the user to retry
 * the command unsandboxed. Returns the retry result or the original result.
 */
async function retrySandboxFailure(
  isSandboxed: boolean,
  result: string,
  toolName: string,
  originalArgs: ToolArgs,
  apiClient: ApiClient,
  originalFn: (args: unknown) => Promise<string>,
  showPermissionPrompt: ShowPermissionPrompt
): Promise<string> {
  if (!isSandboxFailure(isSandboxed, result)) return result;

  const errorSnippet = result.slice(0, 200);
  const retryResponse = await showPermissionPrompt(
    toolName,
    originalArgs,
    `\u{1F6D1} SANDBOX BLOCKED - This command was denied by the OS sandbox.\n\n` +
      `- The sandbox prevented this operation because it violates filesystem or network restrictions.\n` +
      `- If this was a network call, prefer '/sandbox:network on' to allow filtered egress instead of full access.\n` +
      `- You can retry without the sandbox, but the command will run with full system access.\n\n` +
      `@@Error Details@@\n${errorSnippet}`
  );

  if (retryResponse.action !== 'deny') {
    return executeTool(toolName, originalArgs, apiClient, originalFn);
  }

  return result;
}

/**
 * Matches the three shapes of filesystem allow-list denial emitted by core:
 *  - file tools:  `Access denied: Cannot <op> files outside allowed directories.`
 *  - glob_files:  `Access denied: Cannot search outside allowed directories.` (no "files")
 *  - grep_search: `Path validation failed: "<p>" resolves outside allowed directories.`
 * The `files` token is optional so glob_files' wording is covered too.
 */
const PATH_ACCESS_DENIAL_RE =
  /Access denied: Cannot \w+ (?:files )?outside allowed directories|Path validation failed: .* resolves outside allowed directories/;

export function isPathAccessDenial(text: string): boolean {
  return PATH_ACCESS_DENIAL_RE.test(text);
}

/**
 * Derive the directory to grant so the blocked operation can succeed on retry.
 * File tools (`file_read`, `create_file`, `edit_local_file`, `delete_file`)
 * target a file -> grant its containing directory. `grep_search` / `glob_files`
 * target a directory -> grant it directly. Returns an absolute path, or null if
 * no path argument is present.
 */
export function deriveGrantDirectory(toolName: string, args: ToolArgs): string | null {
  const raw = (args?.path ?? args?.dir_path) as unknown;
  if (typeof raw !== 'string' || raw.length === 0) return null;
  const resolved = path.isAbsolute(raw) ? raw : path.resolve(process.cwd(), raw);
  const dirArgTools = new Set(['grep_search', 'glob_files']);
  return dirArgTools.has(toolName) ? resolved : path.dirname(resolved);
}

/**
 * If a tool result indicates the operation was blocked by the filesystem
 * allow-list, prompt the user to grant access to the relevant directory.
 * On approval the directory is pushed onto the live allow-list (so the very
 * next core tool call sees it - same array reference held by the tool
 * context), persisted to config on "Always allow", and the tool is retried.
 *
 * This is the runtime, on-demand equivalent of `/add-dir`: instead of failing
 * hard when the agent reaches outside the workspace, it asks - like Claude
 * Code does - and continues once the user says yes.
 */
async function retryPathAccessDenial(
  result: string,
  toolName: string,
  args: ToolArgs,
  allowedDirectories: string[] | undefined,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  configStore: any,
  apiClient: ApiClient,
  originalFn: (args: unknown) => Promise<string>,
  showPermissionPrompt: ShowKindedPermissionPrompt
): Promise<string> {
  if (!allowedDirectories || !isPathAccessDenial(result)) return result;

  const grantDir = deriveGrantDirectory(toolName, args);
  if (!grantDir) return result;
  // Grant the realpath, not the lexical string: the core validator resolves
  // symlinks (realpathSync) before matching, so a lexical entry for a symlinked
  // dir would never match and the grant would silently fail to unblock.
  let resolvedGrantDir = grantDir;
  try {
    resolvedGrantDir = realpathSync(grantDir);
  } catch {
    // Not-yet-resolvable path: fall back to the lexical dir.
  }
  // Already granted - return the result rather than re-prompting in a loop.
  if (allowedDirectories.includes(resolvedGrantDir)) return result;

  const preview =
    `\u{1F512} DIRECTORY ACCESS \u2014 "${toolName}" needs a path outside the current workspace.\n\n` +
    `- Grant access to this directory:\n` +
    `  ${resolvedGrantDir}\n` +
    `- "Allow for this session" grants access until the CLI exits.\n` +
    `- "Always allow" also saves it to your config so it persists across sessions.`;

  // Prompt as a 'directory-grant', NOT as the originating tool: widening the
  // filesystem allow-list is its own decision. In headless this must be
  // deny-by-default rather than inheriting the tool's policy verdict (a policy
  // allowing `file_read` must not silently widen scope to any directory).
  const response = await showPermissionPrompt(toolName, args, preview, 'directory-grant');
  if (response.action === 'deny') return result;

  // Grant into the live allow-list the core tool context reads on each call.
  // `allow-once` is a one-shot grant - it unblocks this single retry only and
  // is reverted afterward, matching the PermissionPrompt's first option / `y`
  // shortcut. `allow-session` and `allow-always` keep the grant for the rest
  // of the run; `allow-always` also persists it to config.
  const oneShot = response.action === 'allow-once';
  allowedDirectories.push(resolvedGrantDir);

  if (response.action === 'allow-always') {
    try {
      await configStore.addDirectory(resolvedGrantDir);
    } catch {
      // Best-effort persistence - the session grant above is already applied.
    }
  }

  // Retry now that the directory is allowed. Route back through the fuzzy-edit
  // confirmation so a granted edit that resolves fuzzily is re-prompted, not
  // silently applied - a directory grant must never double as a confirmation
  // bypass. A failure here (including another denial for a different path) is
  // returned as-is - no recursion, no loop.
  try {
    return await executeWithFuzzyConfirmation(toolName, args, apiClient, originalFn, showPermissionPrompt);
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  } finally {
    // Revert a one-shot grant so it doesn't silently widen filesystem scope
    // for the rest of the session. Only remove the entry we added (guard
    // against a concurrent grant of the same dir having persisted it).
    if (oneShot) {
      const idx = allowedDirectories.lastIndexOf(resolvedGrantDir);
      if (idx !== -1) allowedDirectories.splice(idx, 1);
    }
  }
}
