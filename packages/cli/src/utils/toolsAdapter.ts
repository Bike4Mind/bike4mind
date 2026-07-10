/* eslint-disable @typescript-eslint/no-explicit-any */
import { rmSync } from 'fs';
import path from 'path';
import { Logger } from '@bike4mind/observability';
import { BaseStorage } from '@bike4mind/fab-pipeline';
import type { ICompletionOptionTools, ICompletionBackend } from '@bike4mind/llm-adapters';
import { PermissionDeniedError, type IUserDocument, type IChatHistoryItemDocument } from '@bike4mind/common';
import {
  b4mTools,
  generateTools,
  type LlmTools,
  setShowUserQuestionFn,
  type UserQuestionPayload,
  type UserQuestionResponse,
} from '@bike4mind/services';
import { getCliOnlyTools } from '@bike4mind/services/llm/tools/cliTools';
import type { PermissionManager } from './PermissionManager';
import type { PermissionResponse } from '../components/PermissionPrompt';
import type { SandboxOrchestrator } from '../sandbox/SandboxOrchestrator.js';
import { generateFileDiffPreview, generateFileDeletePreview, generateEditLocalFilePreview } from './diffPreview';
import { executeTool } from '../llm/ToolRouter';
import type { ApiClient } from '../auth/ApiClient';
import { executeHooks, buildHookContext } from '../agents/hookExecutor.js';
import type { AgentHooks } from '../agents/types.js';
import { HookBlockedError } from '../agents/types.js';
import type { CheckpointStore } from '../storage/CheckpointStore.js';
import { isReadOnlyTool } from '../config/toolSafety.js';
import { classifyCommandRisk } from '../config/commandRisk.js';
import { SHELL_LIKE_TOOL_COMMAND_FIELDS } from '../config/shellCommandFields.js';
import { getPlanModeFileDir, isWriteTargetingPlanFile } from './planMode.js';
import { matchesAnyPattern } from '../agents/toolFilter.js';
import { getProcessHooks } from './processHooks.js';
import { clampInteractionMode } from '../agents/interactionModeClamp.js';
import type { InteractionMode } from '../bootstrap/types.js';

/**
 * Tool-name patterns auto-approved without a permission prompt, from `--allowedTools`
 * (claude-compat; e.g. `mcp__manifold__*`). Parsed once from B4M_ALLOWED_TOOLS - set by
 * bin/bike4mind-cli.mjs. Returns [] when unset so behaviour is unchanged off-host.
 */
let cachedAllowedTools: string[] | undefined;
function getAllowedToolPatterns(): string[] {
  if (cachedAllowedTools === undefined) {
    try {
      const raw = process.env.B4M_ALLOWED_TOOLS;
      cachedAllowedTools = raw ? (JSON.parse(raw) as string[]) : [];
    } catch {
      cachedAllowedTools = [];
    }
  }
  return cachedAllowedTools;
}

/**
 * Simple CLI-friendly storage adapter
 * Most methods won't be called for CLI-only tools
 * Silent to avoid interfering with Ink rendering
 */
class NoOpStorage extends BaseStorage {
  async upload(input: string | Buffer, destination: string, options: any): Promise<string> {
    // Silent - would interfere with Ink
    return `/tmp/${destination}`;
  }

  async download(path: string): Promise<Buffer> {
    throw new Error('Download not supported in CLI');
  }

  async delete(path: string): Promise<void> {
    // Silent - would interfere with Ink
  }

  async getSignedUrl(path: string): Promise<string> {
    return `/tmp/${path}`;
  }

  getPublicUrl(path: string): string {
    return `/tmp/${path}`;
  }

  async getPreview(path: string): Promise<string> {
    return `/tmp/${path}`;
  }

  async getMetadata(path: string): Promise<any> {
    return { size: 0, contentType: 'application/octet-stream' };
  }
}

/**
 * Silent logger for CLI to avoid interfering with Ink rendering
 * All logging is suppressed - Ink components handle the UI
 */
class CliLogger extends Logger {
  constructor() {
    super({ logInJson: false });
  }

  // Override all logging methods to be silent
  info(...args: any[]): void {}
  warn(...args: any[]): void {}
  error(...args: any[]): void {}
  debug(...args: any[]): void {}
  log(...args: any[]): void {}
}

/**
 * Shared context for agent observation tracking
 * This allows tool wrappers to add observations to the current agent
 */
interface AgentContext {
  currentAgent: any | null; // ReActAgent instance
  observationQueue: Array<{ toolName: string; result: unknown }>; // Queue observations to add after actions
}

/**
 * Wrap a tool with permission checking, server routing, and observation tracking.
 */
function wrapToolWithPermission(
  tool: ICompletionOptionTools,
  permissionManager: PermissionManager,
  showPermissionPrompt: (toolName: string, args: unknown, preview?: string) => Promise<{ action: PermissionResponse }>,
  agentContext: AgentContext,
  configStore: any,
  apiClient: ApiClient,
  sandboxOrchestrator?: SandboxOrchestrator,
  /** Live, mutable allow-list shared with the core tool context. The path
   *  access-grant flow pushes onto this in place so grants take effect on the
   *  next call without rebuilding tools. */
  allowedDirectories?: string[],
  /** Ceiling interaction mode for a spawned subagent. When set, the tool runs at
   *  the less-permissive of this and the live store mode, so a subagent can never
   *  exceed its parent's authority yet still tightens if the user switches to plan
   *  mode mid-run. Undefined for the main agent (uses the live store mode). */
  interactionModeOverride?: InteractionMode
): ICompletionOptionTools {
  const originalFn = tool.toolFn;
  const toolName = tool.toolSchema.name;

  return {
    ...tool,
    toolFn: async (args: any) => {
      // --- Sandbox wrapping for bash_execute ---
      let isSandboxed = false;
      let sandboxedArgs = args;

      if (toolName === 'bash_execute' && args?.command && sandboxOrchestrator) {
        const cwd = args.cwd ? path.resolve(process.cwd(), args.cwd) : process.cwd();
        const decision = sandboxOrchestrator.shouldSandbox(args.command, cwd);

        if (decision.type === 'blocked') {
          sandboxOrchestrator.recordBlocked();
          sandboxOrchestrator
            .recordViolation({
              type: 'filesystem',
              command: args.command,
              blockedBy: 'config',
              timestamp: new Date(),
              detail: decision.reason,
            })
            .catch(() => {});
          console.error(
            `\n\x1b[41m\x1b[97m BLOCKED \x1b[0m \x1b[31mSandbox denied this command:\x1b[0m ${decision.reason}\n`
          );
          return `Command blocked by sandbox: ${decision.reason}`;
        }

        if (decision.type === 'sandbox') {
          sandboxOrchestrator.recordSandboxed();
          isSandboxed = true;
          sandboxedArgs = {
            ...args,
            command: decision.wrappedCommand.commandString,
            _sandboxCleanup: decision.wrappedCommand.cleanupPaths,
          };
        } else if (decision.type === 'unsandboxed') {
          sandboxOrchestrator.recordUnsandboxed();
        }
      }

      const effectiveArgs = isSandboxed ? sandboxedArgs : args;

      /**
       * Shared execution flow: run tool, cleanup sandbox files, capture violations,
       * offer retry on sandbox failure, and record observation.
       */
      async function executeAndRecord(): Promise<string> {
        let result: string;
        try {
          result = await executeTool(toolName, effectiveArgs, apiClient, originalFn);
        } catch (err) {
          // grep_search / glob_files re-throw path-validation errors instead
          // of returning them as a string. Normalize a denial to a string so
          // the grant flow below handles both tool shapes uniformly; re-throw
          // anything that isn't a path denial.
          const msg = err instanceof Error ? err.message : String(err);
          if (!isPathAccessDenial(msg)) throw err;
          result = msg;
        }
        cleanupSandboxFiles(effectiveArgs?._sandboxCleanup);
        await captureViolations(isSandboxed, result, args?.command, sandboxOrchestrator);
        result = await retrySandboxFailure(
          isSandboxed,
          result,
          toolName,
          args,
          apiClient,
          originalFn,
          showPermissionPrompt
        );
        // Offer to grant access when the tool was blocked by the filesystem
        // allow-list, then retry - the runtime equivalent of `/add-dir`.
        result = await retryPathAccessDenial(
          result,
          toolName,
          effectiveArgs,
          allowedDirectories,
          configStore,
          apiClient,
          originalFn,
          showPermissionPrompt
        );
        agentContext.observationQueue.push({ toolName, result });
        // Process-hook (host action_required signal): a tool finished - clear the
        // block sentinel (matcher "*").
        void getProcessHooks()?.firePostToolUse(toolName);
        return result;
      }

      // Plan mode: block tools that would mutate state (everything that's not read-only),
      // except writes targeting the plan file. Plan-mode block runs BEFORE the
      // permission/trust check so it overrides previously trusted tools.
      const { useCliStore } = await import('../store/index.js');
      const liveInteractionMode = useCliStore.getState().interactionMode;
      // Subagents carry a ceiling; clamp to the less-permissive of it and the live
      // mode so they never exceed the parent but still honor a mid-run plan switch.
      const interactionMode = interactionModeOverride
        ? clampInteractionMode(liveInteractionMode, interactionModeOverride)
        : liveInteractionMode;
      if (interactionMode === 'plan' && !isReadOnlyTool(toolName) && !isWriteTargetingPlanFile(toolName, args)) {
        const result = `Tool "${toolName}" is blocked while plan mode is active. Plan mode is read-only — research the codebase, then write your plan to a file under ${getPlanModeFileDir()}/. The user will press Shift+Tab to exit plan mode and authorize execution.`;
        agentContext.observationQueue.push({ toolName, result });
        return result;
      }

      // Command-level risk gate: inspect the actual command text (not just the
      // tool name) so a destructive command hidden behind a wrapper
      // (`sh -c "rm -rf /"`, `sudo bash -c ...`, `curl ... | sh`) is never
      // silently auto-run. A high-risk command ALWAYS requires an explicit
      // prompt - this overrides host-allowlist / trust / sandbox-auto-allow /
      // auto-accept short-circuits below. It only ever tightens: benign commands
      // keep their existing (possibly auto-approved) behavior.
      const commandField = SHELL_LIKE_TOOL_COMMAND_FIELDS[toolName];
      const commandText = commandField ? args?.[commandField] : undefined;
      // `classifyCommandRisk` is documented never to throw, but this call sits on the
      // security boundary for every shell command - if it ever does, treat that as a
      // high-risk command (force the prompt) rather than letting the error escape the
      // permission gate and skip classification entirely.
      let commandRisk: ReturnType<typeof classifyCommandRisk> | null = null;
      if (typeof commandText === 'string') {
        try {
          commandRisk = classifyCommandRisk(commandText);
        } catch {
          commandRisk = { level: 'high', reasons: ['command risk analysis failed (fail closed)'] };
        }
      }
      const forcePromptForRisk = commandRisk?.level === 'high';

      // Host allowlist (claude --allowedTools): auto-approve tools matching an
      // allowed pattern (e.g. mcp__manifold__*) without a permission prompt.
      const allowedPatterns = getAllowedToolPatterns();
      if (!forcePromptForRisk && allowedPatterns.length > 0 && matchesAnyPattern(toolName, allowedPatterns)) {
        return executeAndRecord();
      }

      // Auto-approved, trusted, or sandbox auto-allowed
      if (!forcePromptForRisk && !permissionManager.needsPermission(toolName, { isSandboxed })) {
        return executeAndRecord();
      }

      // Auto-accept: skip permission prompt when Shift+Tab toggle is on
      if (!forcePromptForRisk && interactionMode === 'auto-accept') {
        return executeAndRecord();
      }

      // Generate preview for dangerous operations
      const basePreview = await generateToolPreview(toolName, args, isSandboxed);
      const preview =
        forcePromptForRisk && commandRisk ? prependRiskBanner(basePreview, commandRisk.reasons) : basePreview;

      // Show permission prompt and wait indefinitely for response
      const response = await showPermissionPrompt(toolName, effectiveArgs, preview);

      if (response.action === 'deny') {
        throw new PermissionDeniedError(toolName, args);
      }

      if (response.action === 'allow-session') {
        permissionManager.trustToolForSession(toolName);
      }

      if (response.action === 'allow-always') {
        await persistToolTrust(toolName, permissionManager, configStore);
      }

      return executeAndRecord();
    },
  };
}

/**
 * Detect whether a tool result indicates a sandbox-specific runtime failure.
 * Returns true for errors originating from sandbox-exec (macOS) or bwrap (Linux).
 */
function isSandboxFailure(isSandboxed: boolean, result: string): boolean {
  if (!isSandboxed) return false;
  return result.includes('sandbox-exec:') || result.includes('bwrap:') || result.includes('Operation not permitted');
}

/**
 * If the result looks like a sandbox runtime failure, prompt the user to retry
 * the command unsandboxed. Returns the retry result or the original result.
 */
async function retrySandboxFailure(
  isSandboxed: boolean,
  result: string,
  toolName: string,
  originalArgs: Record<string, unknown>,
  apiClient: ApiClient,
  originalFn: (args: unknown) => Promise<string>,
  showPermissionPrompt: (toolName: string, args: unknown, preview?: string) => Promise<{ action: PermissionResponse }>
): Promise<string> {
  if (!isSandboxFailure(isSandboxed, result)) return result;

  const errorSnippet = result.slice(0, 200);
  const retryResponse = await showPermissionPrompt(
    toolName,
    originalArgs,
    `🛑 SANDBOX BLOCKED — This command was denied by the OS sandbox.\n\n- The sandbox prevented this operation because it violates filesystem restrictions.\n- You can retry without the sandbox, but the command will run with full system access.\n\n@@Error Details@@\n${errorSnippet}`
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
export function deriveGrantDirectory(toolName: string, args: Record<string, unknown>): string | null {
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
  args: Record<string, unknown>,
  allowedDirectories: string[] | undefined,
  configStore: any,
  apiClient: ApiClient,
  originalFn: (args: unknown) => Promise<string>,
  showPermissionPrompt: (toolName: string, args: unknown, preview?: string) => Promise<{ action: PermissionResponse }>
): Promise<string> {
  if (!allowedDirectories || !isPathAccessDenial(result)) return result;

  const grantDir = deriveGrantDirectory(toolName, args);
  if (!grantDir) return result;
  // Already granted - return the result rather than re-prompting in a loop.
  if (allowedDirectories.includes(grantDir)) return result;

  const preview =
    `🔒 DIRECTORY ACCESS — "${toolName}" needs a path outside the current workspace.\n\n` +
    `- Grant access to this directory:\n` +
    `  ${grantDir}\n` +
    `- "Allow for this session" grants access until the CLI exits.\n` +
    `- "Always allow" also saves it to your config so it persists across sessions.`;

  const response = await showPermissionPrompt(toolName, args, preview);
  if (response.action === 'deny') return result;

  // Grant into the live allow-list the core tool context reads on each call.
  // `allow-once` is a one-shot grant - it unblocks this single retry only and
  // is reverted afterward, matching the PermissionPrompt's first option / `y`
  // shortcut. `allow-session` and `allow-always` keep the grant for the rest
  // of the run; `allow-always` also persists it to config.
  const oneShot = response.action === 'allow-once';
  allowedDirectories.push(grantDir);

  if (response.action === 'allow-always') {
    try {
      await configStore.addDirectory(grantDir);
    } catch {
      // Best-effort persistence - the session grant above is already applied.
    }
  }

  // Retry now that the directory is allowed. A failure here (including another
  // denial for a different path) is returned as-is - no recursion, no loop.
  try {
    return await executeTool(toolName, args, apiClient, originalFn);
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  } finally {
    // Revert a one-shot grant so it doesn't silently widen filesystem scope
    // for the rest of the session. Only remove the entry we added (guard
    // against a concurrent grant of the same dir having persisted it).
    if (oneShot) {
      const idx = allowedDirectories.lastIndexOf(grantDir);
      if (idx !== -1) allowedDirectories.splice(idx, 1);
    }
  }
}

/**
 * Clean up temporary sandbox files (e.g., Seatbelt profiles).
 * Fails silently - cleanup is best-effort.
 */
function cleanupSandboxFiles(paths?: string[]): void {
  if (!paths || paths.length === 0) return;
  for (const p of paths) {
    try {
      rmSync(p, { recursive: true, force: true });
    } catch {
      // Best-effort cleanup
    }
  }
}

/**
 * Parse sandbox runtime stderr for violations and record them.
 * Fire-and-forget - errors are silently swallowed.
 */
async function captureViolations(
  isSandboxed: boolean,
  result: string,
  command: string | undefined,
  orchestrator?: SandboxOrchestrator
): Promise<void> {
  if (!isSandboxed || !orchestrator || !command) return;
  const { parseSandboxStderr, toSandboxViolations } = await import('../sandbox/logging/StderrViolationParser.js');
  const parsed = parseSandboxStderr(result);
  if (parsed.length > 0) {
    const violations = toSandboxViolations(parsed, command);
    for (const v of violations) {
      await orchestrator.recordViolation(v).catch(() => {});
    }
  }
}

/**
 * Prepend a high-risk warning banner (with the classifier's reasons) to a tool
 * preview shown in the permission prompt. Explains WHY a normally auto-approved
 * command is being surfaced for explicit confirmation.
 */
function prependRiskBanner(basePreview: string | undefined, reasons: string[]): string {
  const details =
    reasons.length > 0 ? reasons.map(reason => `- ${reason}`).join('\n') : '- flagged by command analysis';
  const banner = `🛑 HIGH-RISK COMMAND — flagged by static command analysis:\n\n${details}`;
  return basePreview ? `${banner}\n\n${basePreview}` : banner;
}

/**
 * Generate a human-readable preview string for a tool invocation.
 * Used in the permission prompt to show what the tool will do.
 */
async function generateToolPreview(
  toolName: string,
  args: Record<string, unknown>,
  isSandboxed: boolean
): Promise<string | undefined> {
  try {
    if (toolName === 'edit_local_file' && args?.path && args?.old_string && typeof args?.new_string === 'string') {
      return generateEditLocalFilePreview({
        path: args.path as string,
        old_string: args.old_string as string,
        new_string: args.new_string,
      });
    }

    if (toolName === 'create_file' && args?.path && args?.content) {
      return await generateFileDiffPreview({
        path: args.path as string,
        content: args.content as string,
      });
    }

    if (toolName === 'delete_file' && args?.path) {
      return await generateFileDeletePreview({
        path: args.path as string,
      });
    }

    if (toolName === 'bash_execute' && args?.command) {
      const cwd = args.cwd ? ` (in ${args.cwd})` : '';
      const timeout = args.timeout ? ` [timeout: ${args.timeout}ms]` : '';
      const sandboxLabel = isSandboxed ? ' [sandboxed]' : '';
      return `$ ${args.command}${cwd}${timeout}${sandboxLabel}`;
    }
  } catch (error) {
    return `[Could not generate preview: ${error instanceof Error ? error.message : 'Unknown error'}]`;
  }

  return undefined;
}

/**
 * Persist an "allow-always" trust decision to project-local or global config.
 */
async function persistToolTrust(
  toolName: string,
  permissionManager: PermissionManager,
  configStore: any // any: ConfigStore has dynamic shape, no shared interface
): Promise<void> {
  const canTrust = permissionManager.trustTool(toolName);
  if (!canTrust) return;

  const projectDir = configStore.getProjectConfigDir();
  if (projectDir) {
    try {
      await configStore.initProjectConfig();
      const existingLocal = (await configStore.loadRawProjectLocalConfig()) || {};
      await configStore.saveProjectLocalConfig({
        ...existingLocal,
        trustedTools: [...(existingLocal.trustedTools || []), toolName],
      });
    } catch {
      // Fall back to global if local fails
      await configStore.trustTool(toolName);
    }
  } else {
    await configStore.trustTool(toolName);
  }
}

/**
 * Context required for hook execution during tool wrapping
 */
export interface HookWrapperContext {
  sessionId: string;
  agentName: string;
  cwd: string;
}

/**
 * Wrap a tool with lifecycle hooks (PreToolUse, PostToolUse, PostToolUseFailure).
 *
 * Hook decisions:
 * - 'allow': continue execution (possibly with modified input from PreToolUse)
 * - 'deny': skip tool execution, return denial message to agent (PreToolUse only)
 * - 'block': stop the entire agent by throwing HookBlockedError
 */
export function wrapToolWithHooks(
  tool: ICompletionOptionTools,
  hooks: AgentHooks | undefined,
  hookContext: HookWrapperContext
): ICompletionOptionTools {
  // Early return if no tool-related hooks are defined
  const hasToolHooks = hooks?.PreToolUse || hooks?.PostToolUse || hooks?.PostToolUseFailure;
  if (!hasToolHooks) {
    return tool;
  }

  const originalFn = tool.toolFn;
  const toolName = tool.toolSchema.name;

  return {
    ...tool,
    toolFn: async (args: unknown) => {
      let finalArgs = args;

      // 1. Execute PreToolUse hooks
      if (hooks.PreToolUse) {
        const preResult = await executeHooks(
          hooks.PreToolUse,
          buildHookContext({
            ...hookContext,
            hookEventName: 'PreToolUse',
            toolName,
            toolInput: args as Record<string, unknown>,
          })
        );

        if (preResult.decision === 'deny') {
          return `Tool execution denied by hook: ${preResult.reason || 'No reason provided'}`;
        }

        if (preResult.decision === 'block') {
          throw new HookBlockedError(toolName, preResult.reason);
        }

        // Apply input modifications
        if (preResult.updatedInput) {
          finalArgs = { ...(args as object), ...preResult.updatedInput };
        }
      }

      // 2. Execute the tool
      let observation: string;

      try {
        observation = await originalFn(finalArgs);
      } catch (err) {
        // 3a. Execute PostToolUseFailure hooks
        if (hooks.PostToolUseFailure) {
          const error = err as Error;
          await executeHooks(
            hooks.PostToolUseFailure,
            buildHookContext({
              ...hookContext,
              hookEventName: 'PostToolUseFailure',
              toolName,
              toolInput: finalArgs as Record<string, unknown>,
              error: error.message,
            })
          );
        }
        throw err;
      }

      // 3b. Execute PostToolUse hooks (on success)
      if (hooks.PostToolUse) {
        const postResult = await executeHooks(
          hooks.PostToolUse,
          buildHookContext({
            ...hookContext,
            hookEventName: 'PostToolUse',
            toolName,
            toolInput: finalArgs as Record<string, unknown>,
            toolResult: observation,
          })
        );

        if (postResult.decision === 'block') {
          throw new HookBlockedError(toolName, postResult.reason);
        }
      }

      return observation;
    },
  };
}

/**
 * Tools that modify files and should trigger automatic checkpointing
 */
const CHECKPOINT_TOOLS = new Set(['create_file', 'edit_local_file', 'delete_file']);

/**
 * Wrap a tool with automatic checkpointing before file modifications
 *
 * Creates a snapshot of target files in the shadow git repo BEFORE
 * the tool executes, enabling undo/restore functionality.
 *
 * Checkpoint failures are caught silently and never block tool execution.
 */
function wrapToolWithCheckpointing(
  tool: ICompletionOptionTools,
  checkpointStore: CheckpointStore | null
): ICompletionOptionTools {
  if (!checkpointStore || !CHECKPOINT_TOOLS.has(tool.toolSchema.name)) {
    return tool;
  }

  const originalFn = tool.toolFn;
  const toolName = tool.toolSchema.name;

  return {
    ...tool,

    toolFn: async (args: any) => {
      const filePath = (args as Record<string, unknown>)?.path as string | undefined;

      if (filePath) {
        try {
          await checkpointStore.createCheckpoint(toolName, [filePath], `before-${toolName}-${path.basename(filePath)}`);
        } catch {
          // Checkpoint failure should NEVER block tool execution
        }
      }

      return originalFn(args);
    },
  };
}

/**
 * Tool name mapping for Claude Code compatibility
 * Maps between Claude Code tool names and B4M tool names
 */
const TOOL_NAME_MAPPING: Record<string, string> = {
  // Claude Code -> B4M
  read: 'file_read',
  write: 'create_file',
  edit: 'edit_file',
  delete: 'delete_file',
  glob: 'glob_files',
  grep: 'grep_search',
  bash: 'bash_execute',
  // B4M -> Claude Code (reverse mapping)
  file_read: 'read',
  create_file: 'write',
  edit_file: 'edit',
  delete_file: 'delete',
  glob_files: 'glob',
  grep_search: 'grep',
  bash_execute: 'bash',
};

/**
 * Normalize tool name to B4M format
 * Handles both B4M and Claude Code naming conventions
 */
function normalizeToolName(toolName: string): string {
  // If it's already a B4M tool name, return as is
  if (toolName.includes('_')) {
    return toolName;
  }
  // Otherwise, try to map from Claude Code format
  return TOOL_NAME_MAPPING[toolName] || toolName;
}

/**
 * Tool filter configuration for restricting tool access
 */
export interface ToolFilter {
  /** Whitelist: Only allow these tools (if specified) */
  allowedTools?: string[];
  /** Blacklist: Deny these tools */
  deniedTools?: string[];
}

/**
 * Generate CLI-friendly tools with permission wrapping, server routing, and observation tracking
 * Disables tools that require web app context
 *
 * @param toolFilter - Optional filter to restrict tool access (for subagents)
 */
export async function generateCliTools(
  userId: string,
  llm: ICompletionBackend,
  model: string,
  permissionManager: PermissionManager,
  showPermissionPrompt: (toolName: string, args: unknown, preview?: string) => Promise<{ action: PermissionResponse }>,
  agentContext: AgentContext,
  configStore: any, // ConfigStore instance
  apiClient: ApiClient,
  toolFilter?: ToolFilter,
  showUserQuestion?: (payload: UserQuestionPayload) => Promise<UserQuestionResponse>,
  checkpointStore?: CheckpointStore | null,
  sandboxOrchestrator?: SandboxOrchestrator,
  allowedDirectories?: string[],
  /** Ceiling interaction mode for a spawned subagent (see wrapToolWithPermission).
   *  Omitted for the main agent, which follows the live store mode. */
  interactionModeOverride?: InteractionMode
): Promise<{ tools: ICompletionOptionTools[]; agentContext: AgentContext }> {
  // Wire the ask_user_question callback into the tool's module-level setter
  if (showUserQuestion) {
    setShowUserQuestionFn(showUserQuestion);
  }

  const logger = new CliLogger();
  const storage = new NoOpStorage();

  // Create minimal user document
  const user: Partial<IUserDocument> = {
    _id: userId,
    email: 'cli-user@bike4mind.local',
    firstName: 'CLI',
    lastName: 'User',
  } as any;

  // No-op status update - don't use console.log as it interferes with Ink rendering
  const statusUpdate = async (q: Partial<IChatHistoryItemDocument>, status?: string) => {
    // Silent - Ink will handle the UI
  };

  // Tool lifecycle hooks - silent to avoid interfering with Ink rendering
  const onStart = async (toolName: string, data: any) => {
    // Silent - tool actions are shown in ThoughtStream
  };

  const onFinish = async (toolName: string, data: any) => {
    // Silent - tool results are shown in ThoughtStream
  };

  // Mock admin settings adapter (not needed for CLI - server-side tools use B4M API keys)
  const mockAdminSettings = {
    findBySettingName: async (settingName: string) => {
      // Server-side tools (weather, web_search) execute via Lambda using B4M API keys
      // Local tools don't need admin settings
      return null;
    },
  };

  // Minimal DB adapters
  const dbAdapters: any = {
    db: {
      apiKeys: null,
      adminSettings: mockAdminSettings,
    },
  };

  // B4M tools enabled for CLI (subset of shared tools)
  // Tools not listed here are web-only (blog, image gen, mermaid, recharts, deep research, etc.)
  const enabledB4mToolNames: LlmTools[] = [
    // Local-only tools (no external API keys needed)
    'dice_roll',
    'math_evaluate',
    'current_datetime',
    'prompt_enhancement',
    // Server-side tools (executed via /api/ai/v1/tools Lambda)
    'weather_info',
    'web_search',
    'web_fetch',
  ];

  // Filter b4mTools to only CLI-enabled ones, then merge with all CLI-only tools
  const filteredB4mTools = Object.fromEntries(
    enabledB4mToolNames
      .filter((name): name is keyof typeof b4mTools => name in b4mTools)
      .map(name => [name, b4mTools[name]])
  );
  const cliOnlyTools = await getCliOnlyTools();
  const tools_to_generate = { ...filteredB4mTools, ...cliOnlyTools };

  // Single mutable reference shared between the core tools (which read
  // `context.allowedDirectories` live on every call) and the permission
  // wrapper (which pushes onto it when the user grants directory access at
  // runtime). Mutating in place means a grant takes effect on the very next
  // tool call - no tool rebuild - and keeps both views of the allow-list in
  // sync.
  const liveAllowedDirectories = allowedDirectories ?? [];

  // Injects the CLI-owned web-tree-sitter comment stripper into file_read's opt-in
  // `minified` mode (services has no tree-sitter dep). Lazy import keeps the WASM off
  // the hot path until a minified read actually runs; reuses get_file_structure's engine.
  const codeMinifier = async (source: string, ext: string): Promise<string | null> => {
    const { stripComments } = await import('../tools/getFileStructure/treeSitterEngine');
    return stripComments(source, ext);
  };

  const toolsMap = generateTools(
    userId,
    user as IUserDocument,
    logger,
    dbAdapters,
    storage,
    storage, // imageGenerateStorage
    statusUpdate,
    onStart,
    onFinish,
    llm,
    {},
    model,
    undefined, // imageProcessorLambdaName (not needed for CLI)
    tools_to_generate,
    liveAllowedDirectories,
    undefined, // entitlementKeys (default)
    undefined, // sessionId (not needed for CLI tool build)
    codeMinifier
  );

  // Convert to array and wrap with permission checks, checkpointing, server routing, and observation tracking
  let tools = Object.entries(toolsMap).map(([_, tool]) => {
    const permissionWrapped = wrapToolWithPermission(
      tool,
      permissionManager,
      showPermissionPrompt,
      agentContext,
      configStore,
      apiClient,
      sandboxOrchestrator,
      liveAllowedDirectories,
      interactionModeOverride
    );
    return wrapToolWithCheckpointing(permissionWrapped, checkpointStore ?? null);
  });

  // Apply tool filter if provided (for subagents)
  if (toolFilter) {
    const { allowedTools, deniedTools } = toolFilter;

    // Normalize tool names to B4M format
    const normalizedAllowed = allowedTools?.map(normalizeToolName);
    const normalizedDenied = deniedTools?.map(normalizeToolName);

    tools = tools.filter(tool => {
      const toolName = tool.toolSchema.name;

      // If denied list is specified, exclude denied tools
      if (normalizedDenied && normalizedDenied.includes(toolName)) {
        return false;
      }

      // If allowed list is specified, only include allowed tools
      if (normalizedAllowed && normalizedAllowed.length > 0) {
        return normalizedAllowed.includes(toolName);
      }

      // No restrictions, include tool
      return true;
    });
  }

  return { tools, agentContext };
}

// Export AgentContext type for use in other modules
export type { AgentContext };

// Re-export user question types for CLI consumers
export type { UserQuestionPayload, UserQuestionResponse } from '@bike4mind/services';
