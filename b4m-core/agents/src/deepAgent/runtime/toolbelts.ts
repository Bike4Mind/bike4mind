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
import { z } from 'zod';

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

// Roles a mounted package adds at host startup. Kept apart from TOOLBELT_PROFILES so a
// contribution can add a role but never redefine a built-in one.
const contributedToolbelts = new Map<string, ToolbeltProfile>();

const toolbeltRuntimeSchema = z.object({
  role: z.string().min(1),
  enabledToolNames: z.array(z.string()),
  maxIterations: z.number().int().positive(),
  maxTotalTokens: z.number().positive(),
  temperature: z.number(),
  codeExecute: z.boolean().optional(),
});

function isToolbeltShaped(profile: unknown): boolean {
  return toolbeltRuntimeSchema.safeParse(profile).success;
}

// A host module re-evaluated in the same process (dev HMR, `vi.resetModules`) registers the same
// profiles again; that is not a collision worth reporting.
function isSameToolbelt(a: ToolbeltProfile, b: ToolbeltProfile): boolean {
  return (
    a.role === b.role &&
    a.description === b.description &&
    a.maxIterations === b.maxIterations &&
    a.maxTotalTokens === b.maxTotalTokens &&
    a.temperature === b.temperature &&
    a.codeExecute === b.codeExecute &&
    a.enabledToolNames.length === b.enabledToolNames.length &&
    a.enabledToolNames.every((name, index) => name === b.enabledToolNames[index])
  );
}

/**
 * Add toolbelt profiles for new roles. A profile whose role is already taken (built-in or
 * contributed earlier) is dropped, not merged, and so is a malformed one; both are returned for
 * the host to log. Re-registering an identical contributed profile is a silent no-op.
 */
export function registerToolbelts(profiles: readonly ToolbeltProfile[]): { taken: string[]; invalid: number } {
  const taken: string[] = [];
  let invalid = 0;
  for (const profile of profiles) {
    if (!profile || typeof profile !== 'object' || !isToolbeltShaped(profile)) {
      invalid++;
      continue;
    }
    const existing = contributedToolbelts.get(profile.role);
    if (existing && isSameToolbelt(existing, profile)) continue;
    if (Object.hasOwn(TOOLBELT_PROFILES, profile.role) || existing) {
      taken.push(profile.role);
      continue;
    }
    contributedToolbelts.set(profile.role, { ...profile, enabledToolNames: [...profile.enabledToolNames] });
  }
  return { taken, invalid };
}

/** Resolve the toolbelt profile for a role (built-in, then contributed), falling back to the default. */
export function resolveToolbeltProfile(role: string): ToolbeltProfile {
  return (
    (Object.hasOwn(TOOLBELT_PROFILES, role) ? TOOLBELT_PROFILES[role] : contributedToolbelts.get(role)) ??
    TOOLBELT_PROFILES[DEFAULT_TOOLBELT_ROLE]
  );
}
