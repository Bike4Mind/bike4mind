import { runShellCommand } from './shellRunner';

/**
 * CLI-process lifecycle hooks.
 *
 * Mirrors claude's `--settings.hooks` contract so a host app can observe the
 * CLI's permission/turn lifecycle by running shell commands at four
 * events. A host uses this to drive its `action_required` live-card signal: a
 * `Notification`/`permission_prompt` hook writes a sentinel file while an
 * interactive permission prompt blocks; `PostToolUse`/`Stop`/`UserPromptSubmit`
 * hooks remove it.
 *
 * Each hook command is run via {@link runShellCommand} - a real shell (so `>`
 * redirection works) that always closes the child's stdin (EOF), so a blocking
 * `cat > <file>` hook returns immediately.
 *
 * This is a net-new, standalone layer: the CLI's file config has no `hooks`
 * field today, so there is nothing to merge with - `--settings.hooks` is the
 * sole source. Structured so a future file-config `hooks` field can compose.
 */

/** One command to run for a hook event. Only `type: "command"` is supported. */
interface HookCommand {
  type?: string;
  command?: string;
}

/** A matcher + the commands to run when it matches. */
interface HookMatcherGroup {
  /** When set, the group only fires if the event's matcher value equals this (or `*`). */
  matcher?: string;
  hooks?: HookCommand[];
}

/** The `hooks` subset of `--settings`. Unknown event keys are ignored. */
export interface SettingsHooks {
  Notification?: HookMatcherGroup[];
  PostToolUse?: HookMatcherGroup[];
  Stop?: HookMatcherGroup[];
  UserPromptSubmit?: HookMatcherGroup[];
}

export type ProcessHookEvent = keyof SettingsHooks;

const HOOK_TIMEOUT_MS = 5000;

/** Does a group's matcher match the event's matcher value? `*`/empty/undefined match anything. */
function matcherMatches(groupMatcher: string | undefined, eventMatcher: string | undefined): boolean {
  if (groupMatcher === undefined || groupMatcher === '' || groupMatcher === '*') return true;
  return groupMatcher === eventMatcher;
}

export class ProcessHooks {
  constructor(private readonly hooks: SettingsHooks) {}

  /**
   * Run every command registered for `event` whose matcher matches `eventMatcher`.
   * `payload` is written to each command's stdin (then EOF). Best-effort: a failing
   * command never throws or blocks the caller's lifecycle.
   */
  async fire(event: ProcessHookEvent, eventMatcher?: string, payload?: Record<string, unknown>): Promise<void> {
    const groups = this.hooks[event];
    if (!groups || groups.length === 0) return;

    const stdin = JSON.stringify({
      hook_event_name: event,
      ...(eventMatcher ? { matcher: eventMatcher } : {}),
      ...payload,
    });

    const runs: Promise<unknown>[] = [];
    for (const group of groups) {
      if (!matcherMatches(group.matcher, eventMatcher)) continue;
      for (const hook of group.hooks ?? []) {
        if (hook.type !== 'command' || !hook.command) continue;
        runs.push(
          runShellCommand({ command: hook.command, cwd: process.cwd(), timeoutMs: HOOK_TIMEOUT_MS, stdin }).catch(
            () => undefined
          )
        );
      }
    }
    await Promise.all(runs);
  }

  /** Fired when an interactive permission prompt begins blocking. */
  fireNotificationPermissionPrompt(toolName: string): Promise<void> {
    return this.fire('Notification', 'permission_prompt', { tool_name: toolName });
  }

  /** Fired after any tool completes. */
  firePostToolUse(toolName: string): Promise<void> {
    return this.fire('PostToolUse', undefined, { tool_name: toolName });
  }

  /** Fired at the end of every agent turn. */
  fireStop(): Promise<void> {
    return this.fire('Stop');
  }

  /** Fired when the user submits a new prompt. */
  fireUserPromptSubmit(): Promise<void> {
    return this.fire('UserPromptSubmit');
  }
}

/**
 * Parse a `--settings` JSON string into a {@link SettingsHooks}. Defensive:
 * malformed JSON or a missing/!-object `hooks` field yields `null` (no hooks),
 * never throws - a bad `--settings` must not brick the launch.
 */
export function parseSettingsHooks(settingsJson: string | undefined): SettingsHooks | null {
  if (!settingsJson) return null;
  try {
    const parsed = JSON.parse(settingsJson) as unknown;
    if (!parsed || typeof parsed !== 'object') return null;
    const hooks = (parsed as { hooks?: unknown }).hooks;
    if (!hooks || typeof hooks !== 'object') return null;
    return hooks as SettingsHooks;
  } catch {
    return null;
  }
}

let cached: ProcessHooks | null | undefined;

/**
 * Lazily-built process-hook singleton from `B4M_SETTINGS_JSON`. Returns null when
 * no hooks are configured, so call sites can `void getProcessHooks()?.fireStop()`.
 */
export function getProcessHooks(): ProcessHooks | null {
  if (cached !== undefined) return cached;
  const hooks = parseSettingsHooks(process.env.B4M_SETTINGS_JSON);
  cached = hooks ? new ProcessHooks(hooks) : null;
  return cached;
}

/** Test-only: reset the cached singleton so a new B4M_SETTINGS_JSON is re-read. */
export function __resetProcessHooksForTest(): void {
  cached = undefined;
}
