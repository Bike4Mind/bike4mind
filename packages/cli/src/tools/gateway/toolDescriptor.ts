/**
 * When a tool needs the user's permission before it runs:
 * - auto_approve: runs without a prompt.
 * - prompt_default: prompts until the user trusts the tool.
 * - prompt_always: prompts every time; can only be trusted for the session.
 */
export type ToolCategory = 'auto_approve' | 'prompt_always' | 'prompt_default';

/** Where a tool comes from; it bounds how far the tool's own declarations are believed (toolPolicy.ts). */
export type ToolSource =
  | { kind: 'core' }
  | { kind: 'cli' }
  | { kind: 'builtin-module'; module: string }
  | { kind: 'plugin'; packageName: string }
  | { kind: 'mcp'; server: string }
  // The synthetic agent_hook:/skill_hook: names the lifecycle-hook shell gate checks.
  | { kind: 'hook' };

/**
 * What a tool does to the world. `none` is pure compute; `session` is the agent's own
 * bookkeeping and delegation (todos, decisions, work items, subagents).
 */
export type ToolEffect = 'none' | 'session' | 'read' | 'write' | 'execute';

/** Per-tool metadata every gateway policy decision derives from (see toolPolicy.ts). */
export type ToolDescriptor = {
  source: ToolSource;
  effect: ToolEffect;
  /** Default approval tier. A plugin cannot go below prompt_default; mcp and hook are prompt_always. */
  approval: ToolCategory;
  /** Reaches the network or outside the workspace. */
  openWorld?: boolean;
  /** Argument holding a shell command, run through the command-risk gate. */
  commandArg?: string;
  /** Argument holding the file path the tool writes: checkpointed before the write, reported after it. */
  writePathArg?: string;
};
