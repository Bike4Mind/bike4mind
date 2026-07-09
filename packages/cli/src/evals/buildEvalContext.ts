/**
 * Builds an `EvalContext` wired to B4M's production server backend
 * (`ServerLlmBackend`) with eval-mode constraints applied.
 *
 * Eval mode differs from production CLI in four important ways:
 *  1. Auto-allow all tool permissions (no interactive prompts).
 *  2. Filesystem scope locked to the per-task sandbox via `allowedDirectories`
 *     - defense in depth against agents going off-script.
 *  3. Bash and external network tools (web_search, web_fetch) are denied -
 *     they bypass `allowedDirectories`, are nondeterministic, and inflate
 *     token usage. Tasks that genuinely need them belong in a different
 *     suite.
 *  4. `ask_user_question` is denied - evals must run autonomously. If a
 *     task requires user input, it's testing the wrong thing.
 *
 * The returned `EvalContext` is reusable across many tasks under one
 * (model, configLabel) pair. Per-task sandbox dirs are managed inside
 * `runEval` itself via the tools-factory closure.
 */
import type { ICompletionBackend, ICompletionOptionTools } from '@bike4mind/llm-adapters';
import type { EvalContext } from './types.js';
import { generateCliTools } from '../utils/toolsAdapter.js';
import { PermissionManager } from '../utils/PermissionManager.js';
import { ConfigStore } from '../storage/ConfigStore.js';
import { ApiClient } from '../auth/ApiClient.js';
import { ServerLlmBackend } from '../llm/ServerLlmBackend.js';
import { requireApiUrl } from '../utils/apiUrl.js';
import { Logger } from '@bike4mind/observability';
import { getPromptVariant, type PromptVariant } from './prompts.js';

/** Tools that are denied in eval mode regardless of task. */
const EVAL_MODE_DENIED_TOOLS: readonly string[] = [
  'bash_execute',
  'bash_execute_async',
  'write_shell_stdin',
  'kill_background_shell',
  'web_search',
  'web_fetch',
  'ask_user_question',
];

/**
 * Logger that surfaces warnings/errors but stays silent on debug/info.
 * Eval runs already produce structured JSON output; chatty logs make
 * it hard to spot real problems.
 */
class EvalLogger extends Logger {
  constructor() {
    super({ logInJson: false });
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  debug(..._args: any[]): void {}
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  info(..._args: any[]): void {}
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  log(..._args: any[]): void {}
}

/** Factory result - a callable that produces fresh tools for a sandbox dir. */
export interface EvalToolFactory {
  (sandboxDir: string): Promise<ICompletionOptionTools[]>;
}

export interface BuildEvalContextOptions {
  model: string;
  configLabel: string;
  /** ConfigStore instance (must be authenticated). Caller owns lifecycle. */
  configStore: ConfigStore;
  /**
   * System-prompt variant. `current` (default) lets the agent core's
   * built-in prompt fire; `minimal` overrides with a pi-style short
   * prompt. See `prompts.ts` for variant definitions.
   */
  promptVariant?: PromptVariant;
}

export interface BuiltEvalContext {
  context: EvalContext;
  toolFactory: EvalToolFactory;
}

/**
 * Wire up everything needed to run evals against the production B4M server.
 * Throws if the user is not authenticated - evals require a live token.
 */
export async function buildEvalContext(options: BuildEvalContextOptions): Promise<BuiltEvalContext> {
  const { model, configLabel, configStore, promptVariant = 'current' } = options;

  const isAuthed = await configStore.isAuthenticated();
  if (!isAuthed) {
    throw new Error('Not authenticated. Run `b4m` and use /login first, or set valid auth tokens in your config.');
  }

  const config = await configStore.load();
  const apiBaseURL = requireApiUrl(config.apiConfig);
  const apiClient = new ApiClient(apiBaseURL, configStore);

  // Discover the completions URL from server config (matches index.tsx pattern).
  // Fallback to /api/ai/v1/completions which ServerLlmBackend handles internally.
  let completionsUrl: string | undefined;
  try {
    const serverConfig = await apiClient.get<{ completionsUrl?: string }>('/api/settings/serverConfig');
    completionsUrl = serverConfig?.completionsUrl;
  } catch {
    // Server config endpoint optional - ServerLlmBackend has a sensible default.
  }

  const llm: ICompletionBackend = new ServerLlmBackend({ apiClient, model, completionsUrl });

  // Pre-flight: verify the model is registered on the server. Catches the
  // common failure mode where the user's config has a model id that the
  // server's registry doesn't know about (server out of sync, model
  // deprecated, typo, etc.). Without this, the failure surfaces as an
  // opaque "Failed to create LLM backend" error mid-stream, per task.
  try {
    const available = await llm.getModelInfo();
    const ids = available.map(m => m.id as string);
    if (!ids.includes(model)) {
      throw new Error(
        `Model "${model}" is not in the server's registry.\n` +
          `Available models (${ids.length}): ${ids.slice(0, 20).join(', ')}${ids.length > 20 ? ', ...' : ''}\n` +
          `Pass --model <id> with one of the above, or update your B4M config's defaultModel.`
      );
    }
  } catch (error) {
    // Re-throw verification failures (the helpful one above) but tolerate
    // network errors fetching /api/models - better to attempt the run and
    // surface the underlying failure than to block on a flaky endpoint.
    if (error instanceof Error && error.message.startsWith('Model "')) throw error;
    // Otherwise silent - the run will fail informatively if the model is bad.
  }

  const tokens = await configStore.getAuthTokens();
  const userId = tokens?.userId ?? 'eval-user';

  // Permission manager that pre-trusts every tool. Combined with the
  // throwing showPermissionPrompt below this is defense in depth: if any
  // tool somehow escapes the trust set, the prompt callback yells loudly
  // instead of silently auto-allowing.
  const permissionManager = new PermissionManager();
  const allTools = await listAllToolNames();
  for (const name of allTools) permissionManager.trustToolForSession(name);

  const showPermissionPrompt = async (toolName: string): Promise<{ action: 'deny' }> => {
    throw new Error(
      `[eval] showPermissionPrompt called for ${toolName} — permission trust did not take effect. Investigate.`
    );
  };

  const showUserQuestion = async (): Promise<never> => {
    throw new Error('[eval] ask_user_question is disabled in eval mode — task should not have triggered it.');
  };

  // Empty observation queue per sandbox; the runner doesn't share queues
  // across tasks because each task gets a fresh ReActAgent.
  const agentContext = { currentAgent: null, observationQueue: [] };

  const toolFactory: EvalToolFactory = async sandboxDir => {
    const { tools } = await generateCliTools(
      userId,
      llm,
      model,
      permissionManager,
      showPermissionPrompt,
      agentContext,
      configStore,
      apiClient,
      { deniedTools: [...EVAL_MODE_DENIED_TOOLS] },
      showUserQuestion,
      null, // checkpointStore — undo not relevant to evals
      undefined, // sandboxOrchestrator — bash is denied so no sandbox needed
      [sandboxDir] // allowedDirectories — hard filesystem boundary
    );
    return tools;
  };

  // We can't build the AgentContext until we have a sandbox dir (tools are
  // sandbox-scoped). The runner calls toolFactory per task; the EvalContext's
  // `agent.tools` is filled per-task in the runner. To keep the existing
  // EvalContext shape, we set tools to [] here and the runner overrides
  // before constructing the agent.
  //
  // NOTE: The runner currently uses context.agent directly - we'll rev the
  // runner to accept a tool factory in the next step. For now, this struct
  // gives the matrix runner what it needs to construct per-task agents.
  const systemPrompt = getPromptVariant(promptVariant);

  const context: EvalContext = {
    configLabel,
    agent: {
      userId,
      logger: new EvalLogger(),
      llm,
      model,
      tools: [],
      ...(systemPrompt !== undefined && { systemPrompt }),
    },
  };

  return { context, toolFactory };
}

/**
 * Best-effort enumeration of tool names we want pre-trusted.
 * Trust list is a superset - extra entries are harmless because
 * `needsPermission` only consults this set when a tool is invoked.
 */
async function listAllToolNames(): Promise<string[]> {
  // Static list covers every tool plausibly enabled by generateCliTools
  // (b4mTools subset + cliOnlyTools). Adding tools here is safe; missing
  // tools just means the prompt callback throws if they're called.
  return [
    // Local b4m tools
    'dice_roll',
    'math_evaluate',
    'current_datetime',
    'prompt_enhancement',
    // Server b4m tools (denied in eval mode but trusted defensively)
    'weather_info',
    'web_search',
    'web_fetch',
    // CLI-only tools
    'file_read',
    'create_file',
    'edit_local_file',
    'edit_file',
    'delete_file',
    'glob_files',
    'grep_search',
    'bash_execute',
    'bash_execute_async',
    'check_shell_output',
    'write_shell_stdin',
    'list_background_shells',
    'kill_background_shell',
    'find_definition',
    'get_file_structure',
    'log_decision',
    'track_blocker',
    'resolve_blocker',
    'write_todos',
    'skill',
    'ask_user_question',
  ];
}
