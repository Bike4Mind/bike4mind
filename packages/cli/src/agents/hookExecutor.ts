/**
 * Hook Executor for Agent Lifecycle Hooks
 *
 * Executes shell commands or LLM prompts at specific agent lifecycle events:
 * - PreToolUse: Before tool execution (validate, block, modify)
 * - PostToolUse: After tool success (validate output, run linters)
 * - PostToolUseFailure: After tool failure (log, attempt recovery)
 * - Stop: When agent finishes (cleanup, validation, force continuation)
 *
 * Hook Exit Codes:
 * - 0: Success, parse JSON from stdout
 * - 2: Blocking error, use stderr message
 * - Other: Non-blocking error, log and continue
 */

import type { HookDefinition, HookMatcher, HookResult } from './types.js';
import { runShellCommand } from '../utils/shellRunner.js';

/**
 * Context passed to hook scripts via stdin as JSON
 */
export interface HookContext {
  session_id: string;
  agent_name: string;
  cwd: string;
  hook_event_name: string;
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  tool_use_id?: string;
  tool_result?: string;
  error?: string;
}

const DEFAULT_HOOK_TIMEOUT_SECONDS = 60;

/**
 * Execute a single command hook
 *
 * @param hook - Hook definition to execute
 * @param context - Context to pass to the hook
 * @returns Hook execution result
 */
async function executeCommandHook(hook: HookDefinition, context: HookContext): Promise<HookResult> {
  if (!hook.command) {
    return { decision: 'allow' };
  }

  const timeoutSeconds = hook.timeout ?? DEFAULT_HOOK_TIMEOUT_SECONDS;

  const result = await runShellCommand({
    command: hook.command,
    cwd: context.cwd,
    timeoutMs: timeoutSeconds * 1000,
    env: {
      ...process.env,
      B4M_PROJECT_DIR: context.cwd,
      B4M_AGENT_NAME: context.agent_name,
      B4M_SESSION_ID: context.session_id,
    },
    stdin: JSON.stringify(context),
  });

  // Fail-closed: timeout should deny rather than allow for security
  if (result.timedOut) {
    return { decision: 'deny', reason: `Hook timed out after ${timeoutSeconds}s` };
  }

  // Spawn/execution error (exitCode is null)
  if (result.exitCode === null) {
    console.warn(`Hook execution error: ${result.stderr}`);
    return { decision: 'allow' };
  }

  if (result.exitCode === 2) {
    return { decision: 'deny', reason: result.stderr.trim() || 'Hook blocked execution' };
  }

  if (result.exitCode !== 0) {
    console.warn(`Hook exited with code ${result.exitCode}: ${result.stderr.trim()}`);
    return { decision: 'allow' };
  }

  try {
    const parsed = JSON.parse(result.stdout.trim());
    return {
      decision: parsed.decision || 'allow',
      reason: parsed.reason,
      updatedInput: parsed.updatedInput,
    };
  } catch {
    // No valid JSON, treat as allow
    return { decision: 'allow' };
  }
}

/**
 * Maximum allowed length for regex patterns to prevent ReDoS attacks
 */
const MAX_PATTERN_LENGTH = 200;

/**
 * Check if a tool name matches a regex pattern.
 *
 * Uses raw regex patterns (e.g. "Edit|Write", "bash_.*"), unlike toolFilter.ts
 * which uses wildcard patterns (e.g. "mcp__github__*"). Regex allows more
 * powerful matching in hook definitions.
 *
 * Security: patterns are length-limited to prevent ReDoS.
 *
 * @param toolName - The tool name to check
 * @param pattern - Regex pattern to match against
 * @returns true if the tool matches the pattern
 */
function matchesToolPattern(toolName: string, pattern: string): boolean {
  // Prevent ReDoS by limiting pattern length
  if (pattern.length > MAX_PATTERN_LENGTH) {
    console.warn(`Hook pattern exceeds max length (${MAX_PATTERN_LENGTH}), skipping: ${pattern.slice(0, 50)}...`);
    return false;
  }

  try {
    const regex = new RegExp(`^${pattern}$`);
    return regex.test(toolName);
  } catch {
    // Invalid regex, treat as no match
    return false;
  }
}

/**
 * Execute all matching hooks for an event
 *
 * @param hooks - Array of hook matchers to evaluate
 * @param context - Context to pass to matching hooks
 * @returns Aggregated hook result
 */
export async function executeHooks(hooks: HookMatcher[] | undefined, context: HookContext): Promise<HookResult> {
  if (!hooks || hooks.length === 0) {
    return { decision: 'allow' };
  }

  // Find matching hooks
  const matchingHooks: HookDefinition[] = [];
  for (const matcher of hooks) {
    // If no matcher specified (e.g., Stop event) or matcher matches tool
    const shouldMatch =
      !matcher.matcher || !context.tool_name || matchesToolPattern(context.tool_name, matcher.matcher);

    if (shouldMatch) {
      matchingHooks.push(...matcher.hooks);
    }
  }

  if (matchingHooks.length === 0) {
    return { decision: 'allow' };
  }

  // Execute hooks in parallel
  const results = await Promise.all(
    matchingHooks
      .filter(hook => hook.type === 'command') // Only command hooks for now
      .map(hook => executeCommandHook(hook, context))
  );

  // If any hook denies/blocks, return that result
  for (const result of results) {
    if (result.decision === 'deny' || result.decision === 'block') {
      return result;
    }
  }

  // Merge any input updates
  let updatedInput: Record<string, unknown> | undefined;
  for (const result of results) {
    if (result.updatedInput) {
      updatedInput = { ...updatedInput, ...result.updatedInput };
    }
  }

  return { decision: 'allow', updatedInput };
}

/**
 * Build hook context from orchestrator state
 */
export function buildHookContext(params: {
  sessionId: string;
  agentName: string;
  cwd: string;
  hookEventName: string;
  toolName?: string;
  toolInput?: Record<string, unknown>;
  toolUseId?: string;
  toolResult?: string;
  error?: string;
}): HookContext {
  return {
    session_id: params.sessionId,
    agent_name: params.agentName,
    cwd: params.cwd,
    hook_event_name: params.hookEventName,
    tool_name: params.toolName,
    tool_input: params.toolInput,
    tool_use_id: params.toolUseId,
    tool_result: params.toolResult,
    error: params.error,
  };
}
