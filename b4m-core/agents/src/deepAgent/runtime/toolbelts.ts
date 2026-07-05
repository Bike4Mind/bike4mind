/**
 * Toolbelt profiles - per-role configuration for the act step's ReActAgent.
 *
 * A profile declares which tools a role's agent may use (by name) and the
 * ReAct run budget (iterations / token ceiling / temperature). Materializing
 * the named tools into executable `ICompletionOptionTools` is a separate,
 * host-supplied concern (`buildTools` in reactAct.ts) - the heavyweight tool
 * builder needs db/storage and is wired by the host, keeping this module pure
 * and testable.
 */
export interface ToolbeltProfile {
  role: string;
  description: string;
  /** Tool names this role's agent may use (resolved to real tools by the host). */
  enabledToolNames: string[];
  /** Max ReAct iterations for one wake's act step. */
  maxIterations: number;
  /** Cumulative token ceiling across the act step (cost backstop). */
  maxTotalTokens: number;
  /** Sampling temperature for the act step. */
  temperature: number;
  /**
   * Give the agent a sandboxed JS REPL (`code_execute`, the RLM substrate) - the
   * web-safe compute lever (vs CLI shell). A fresh session is created per wake
   * and disposed after.
   */
  codeExecute: boolean;
}

export const DEFAULT_TOOLBELT_ROLE = 'default';

/**
 * Registry of role -> profile. `paper-repro` is the reference profile (a
 * scientific-paper reproduction agent); `default` is the conservative fallback
 * for any role without a dedicated profile.
 */
export const TOOLBELT_PROFILES: Record<string, ToolbeltProfile> = {
  [DEFAULT_TOOLBELT_ROLE]: {
    role: DEFAULT_TOOLBELT_ROLE,
    description: 'General-purpose web agent: research + light computation.',
    // Web-safe tools only. bash_execute/create_file are CLI-only by design
    // (they touch the local filesystem) and never materialize in the web path.
    enabledToolNames: ['web_search', 'web_fetch', 'retrieve_knowledge_content', 'math_evaluate'],
    maxIterations: 8,
    maxTotalTokens: 80_000,
    temperature: 0.5,
    codeExecute: true,
  },
  'paper-repro': {
    role: 'paper-repro',
    description: 'Scientific paper reproduction: read sources, compute, record evidence.',
    // Web reproduction toolbelt. `code_execute` (the sandboxed RLM REPL) is added
    // separately by the materializer - the web-safe compute lever for repro work.
    enabledToolNames: [
      'retrieve_knowledge_content',
      'search_knowledge_base',
      'web_search',
      'web_fetch',
      'deep_research',
      'math_evaluate',
      'wolfram_alpha',
      'generate_jupyter_notebook',
      'optihashi_formulate',
      'optihashi_schedule',
      // optihashi_edit_problem intentionally omitted - it edits the /opti active brief,
      // absent here, so it would error on missing `currentProblem`.
    ],
    maxIterations: 20,
    maxTotalTokens: 300_000,
    temperature: 0.3,
    codeExecute: true,
  },
};

/** Resolve the toolbelt profile for a role, falling back to the default. */
export function resolveToolbeltProfile(role: string): ToolbeltProfile {
  return TOOLBELT_PROFILES[role] ?? TOOLBELT_PROFILES[DEFAULT_TOOLBELT_ROLE];
}
