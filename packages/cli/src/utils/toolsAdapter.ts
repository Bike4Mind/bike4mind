/* eslint-disable @typescript-eslint/no-explicit-any */
import { Logger } from '@bike4mind/observability';
import { BaseStorage } from '@bike4mind/fab-pipeline';
import type { ICompletionOptionTools, ICompletionBackend } from '@bike4mind/llm-adapters';
import type { IUserDocument, IChatHistoryItemDocument } from '@bike4mind/common';
import {
  cliSharedTools,
  generateTools,
  getCliOnlyTools,
  setShowUserQuestionFn,
  type LlmTools,
  type UserQuestionPayload,
  type UserQuestionResponse,
} from '@bike4mind/services/llm/tools/cliTools';
import type { PermissionManager } from './PermissionManager';
import type { PermissionResponse } from '../components/PermissionPrompt';
import type { SandboxOrchestrator } from '../sandbox/SandboxOrchestrator.js';
import type { ApiClient } from '../auth/ApiClient';
import { executeHooks, buildHookContext } from '../agents/hookExecutor.js';
import type { ShellCommandPermissionDeps } from './commandPermission';
import type { AgentHooks } from '../agents/types.js';
import { HookBlockedError } from '../agents/types.js';
import type { CheckpointStore } from '../storage/CheckpointStore.js';
import type { InteractionMode } from '../bootstrap/types.js';
import { wrapTools, type AgentContext, type WrapToolDeps } from '../tools/gateway/index.js';

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

  async uploadFile(localPath: string, destination: string, options?: Record<string, unknown>): Promise<string> {
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
 * The CLI-built tools in the order they are offered to the model. Each entry point passes
 * only what it built, so an optional group is absent when its config gate is off or when
 * that entry point does not build it at all (the decision / blocker / review tools are
 * interactive-only).
 */
export interface CliToolListInput {
  /** `tool_search`, when deferred tool schemas exist. Offered ahead of the rest of the list. */
  toolSearchTool?: ICompletionOptionTools | null;
  agentDelegateTool: ICompletionOptionTools;
  backgroundTools: ICompletionOptionTools[];
  resumeAgentTool: ICompletionOptionTools;
  writeTodosTool: ICompletionOptionTools;
  /** Durable decision / blocker / review-gate tools (interactive only). */
  decisionLogTool?: ICompletionOptionTools | null;
  blockerTools?: ICompletionOptionTools[];
  reviewGateTool?: ICompletionOptionTools | null;
  findDefinitionTool: ICompletionOptionTools;
  getFileStructureTool: ICompletionOptionTools;
  /** Persistent work-item tools, off unless the config opts in. */
  workItemTools?: ICompletionOptionTools[];
  skillTool?: ICompletionOptionTools | null;
  dynamicAgentTool?: ICompletionOptionTools | null;
  /** `coordinate_task`, when coordinator mode is on. */
  coordinateTaskTool?: ICompletionOptionTools | null;
}

/**
 * Assemble the CLI-built tool list and route it through the ONE permission wrapper (plan-mode
 * gate, deny list, output redaction and cap). Every entry point - interactive, headless and ACP
 * - builds its list here so no CLI-built tool, `tool_search` included, can skip the gate.
 */
export function buildCliToolList(input: CliToolListInput, wrapDeps: WrapToolDeps): ICompletionOptionTools[] {
  return wrapTools(
    [
      ...(input.toolSearchTool ? [input.toolSearchTool] : []),
      input.agentDelegateTool,
      ...input.backgroundTools,
      input.resumeAgentTool,
      input.writeTodosTool,
      ...(input.decisionLogTool ? [input.decisionLogTool] : []),
      ...(input.blockerTools ?? []),
      ...(input.reviewGateTool ? [input.reviewGateTool] : []),
      input.findDefinitionTool,
      input.getFileStructureTool,
      ...(input.workItemTools ?? []),
      ...(input.skillTool ? [input.skillTool] : []),
      ...(input.dynamicAgentTool ? [input.dynamicAgentTool] : []),
      ...(input.coordinateTaskTool ? [input.coordinateTaskTool] : []),
    ],
    wrapDeps
  );
}

/**
 * Context required for hook execution during tool wrapping
 */
export interface HookWrapperContext {
  sessionId: string;
  agentName: string;
  cwd: string;
  /**
   * Permission collaborators used to gate each agent lifecycle hook's shell
   * command before it runs. Threaded to executeHooks; required so a caller that
   * forgets to wire it is a type error, never a silent unprompted bypass.
   */
  permission: ShellCommandPermissionDeps;
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
  // Keep permission out of the buildHookContext spread (it is not a hook-context
  // field); thread it to executeHooks as the required perm instead.
  const { permission, ...baseCtx } = hookContext;

  return {
    ...tool,
    toolFn: async (args: unknown) => {
      let finalArgs = args;

      // 1. Execute PreToolUse hooks
      if (hooks.PreToolUse) {
        const preResult = await executeHooks(
          hooks.PreToolUse,
          buildHookContext({
            ...baseCtx,
            hookEventName: 'PreToolUse',
            toolName,
            toolInput: args as Record<string, unknown>,
          }),
          permission
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
              ...baseCtx,
              hookEventName: 'PostToolUseFailure',
              toolName,
              toolInput: finalArgs as Record<string, unknown>,
              error: error.message,
            }),
            permission
          );
        }
        throw err;
      }

      // 3b. Execute PostToolUse hooks (on success)
      if (hooks.PostToolUse) {
        const postResult = await executeHooks(
          hooks.PostToolUse,
          buildHookContext({
            ...baseCtx,
            hookEventName: 'PostToolUse',
            toolName,
            toolInput: finalArgs as Record<string, unknown>,
            toolResult: observation,
          }),
          permission
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
 * Generate CLI-friendly tools with permission wrapping and server routing
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
    // The signed-in user, running tools on their own machine. Spelled out because this object is
    // `any`, so typecheck cannot require it (see ToolContext.authOrigin).
    authOrigin: 'session',
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

  // Filter the CLI-safe shared tools to only CLI-enabled ones, then merge with all
  // CLI-only tools. `cliSharedTools` (from the services cliTools entry) exposes just
  // the shared tools the CLI may use - it deliberately excludes the server-only
  // image/excel tools so they never enter the CLI bundle (issue #660).
  const filteredB4mTools = Object.fromEntries(
    enabledB4mToolNames
      .filter((name): name is keyof typeof cliSharedTools => name in cliSharedTools)
      .map(name => [name, cliSharedTools[name]])
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

  // Convert to array and route every tool through the permission wrapper
  const wrapDeps: WrapToolDeps = {
    permissionManager,
    showPermissionPrompt,
    agentContext,
    configStore,
    apiClient,
    sandboxOrchestrator,
    allowedDirectories: liveAllowedDirectories,
    interactionModeOverride,
    checkpointStore,
  };
  let tools = wrapTools(Object.values(toolsMap), wrapDeps);

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

// generateCliTools takes and returns the gateway's per-agent context.
export type { AgentContext };

// Re-export user question types for CLI consumers
export type { UserQuestionPayload, UserQuestionResponse } from '@bike4mind/services/llm/tools/cliTools';
