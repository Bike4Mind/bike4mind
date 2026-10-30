import type { ToolCatalog } from '../tools/gateway/toolCatalog.js';
import type { ToolCategory } from '../tools/gateway/toolDescriptor.js';
import { sandboxedCommandArg } from '../tools/gateway/toolPolicy.js';
import type { SandboxMode } from '../sandbox/types.js';
import { sessionCommandPrefixes } from '../config/sessionCommandScope.js';

/**
 * Manages tool permissions and trusted tools
 *
 * Responsibilities:
 * - Track which tools are trusted (don't need permission)
 * - Track which tools are denied (cannot be trusted, from project config)
 * - Check if a tool needs permission based on its category
 * - Persist trusted tools across sessions
 * - Support sandbox auto-allow mode (sandboxed commands skip permission)
 *
 * A tool's category comes from its descriptor in the injected catalog, which the permission
 * gateway (tools/gateway) also reads through `catalog`.
 */
// Stdin to a live shell is input to whatever runs there, not a command line, so it has no scope.
const UNREMEMBERED_COMMAND_TOOLS = new Set(['write_shell_stdin']);

export class PermissionManager {
  private trustedTools: Set<string> = new Set();
  private sessionTrustedTools: Set<string> = new Set();
  /** toolName -> command scopes approved for the session (see trustCommandForSession). */
  private sessionTrustedCommands: Map<string, Set<string>> = new Map();
  private deniedTools: Set<string> = new Set();
  private _sandboxMode: SandboxMode = 'disabled';
  private _sandboxActive = false;
  private sandboxEscalationApprovals: Set<string> = new Set();

  constructor(
    readonly catalog: ToolCatalog,
    trustedTools: string[] = [],
    deniedTools: string[] = []
  ) {
    this.trustedTools = new Set(trustedTools);
    this.deniedTools = new Set(deniedTools);
  }

  /** Update sandbox state from the orchestrator */
  setSandboxState(mode: SandboxMode, active: boolean): void {
    this._sandboxMode = mode;
    this._sandboxActive = active;
  }

  /** Check if sandbox auto-allow is active */
  isSandboxAutoAllow(): boolean {
    return this._sandboxMode === 'auto-allow' && this._sandboxActive;
  }

  /**
   * Check if a tool needs permission before execution
   *
   * A tool needs permission if:
   * 1. It's in the denied tools list (from project config), OR
   * 2. It's not in the auto_approve category, AND
   * 3. It's not in the trusted tools set
   *
   * Note: prompt_always tools CANNOT be trusted, so they always need permission
   * Note: denied tools from project config ALWAYS need permission (cannot be overridden locally)
   *
   * @param toolName - The tool being checked
   * @param options.command - The call's command text, for a tool whose session trust is per command.
   * @param options.isSandboxed - If true, the command will run inside the OS-level sandbox.
   *   In auto-allow mode, sandboxed commands (a core tool whose descriptor declares `sandbox`) skip the permission prompt
   *   because the sandbox provides the security boundary.
   */
  needsPermission(toolName: string, options?: { isSandboxed?: boolean; command?: string }): boolean {
    const category = this.catalog.category(toolName);

    // Denied tools from project config ALWAYS need permission
    if (this.deniedTools.has(toolName)) {
      return true;
    }

    // auto_approve tools never need permission
    if (category === 'auto_approve') {
      return false;
    }

    // Sandbox auto-allow: sandboxed commands skip permission
    // The OS-level sandbox provides the security boundary instead of user prompts
    // Must run before session trust check so sandbox enforcement is never bypassed
    if (
      options?.isSandboxed &&
      sandboxedCommandArg(this.catalog.resolve(toolName)) !== undefined &&
      this.isSandboxAutoAllow()
    ) {
      return false;
    }

    // Session-trusted tools don't need permission (works for all categories including prompt_always)
    if (this.sessionTrustedTools.has(toolName)) {
      return false;
    }

    if (options?.command !== undefined && this.isCommandSessionTrusted(toolName, options.command)) {
      return false;
    }

    // prompt_always tools ALWAYS need permission (cannot be permanently trusted)
    if (category === 'prompt_always') {
      return true;
    }

    // prompt_default tools need permission only if not trusted
    return !this.trustedTools.has(toolName);
  }

  /**
   * Add a tool to the trusted list
   * Returns false if the tool cannot be trusted (prompt_always category or denied by project)
   */
  trustTool(toolName: string): boolean {
    // Cannot trust denied tools from project config
    if (this.deniedTools.has(toolName)) {
      return false;
    }

    // Check if tool can be trusted based on category
    if (!this.catalog.canTrust(toolName)) {
      return false;
    }

    this.trustedTools.add(toolName);
    return true;
  }

  /**
   * Remove a tool from the trusted list
   */
  untrustTool(toolName: string): void {
    this.trustedTools.delete(toolName);
  }

  /**
   * Get list of all trusted tools
   */
  getTrustedTools(): string[] {
    return Array.from(this.trustedTools).sort();
  }

  /**
   * Check if a tool is currently trusted
   */
  isTrusted(toolName: string): boolean {
    return this.trustedTools.has(toolName);
  }

  /**
   * Get the category for a tool
   */
  getCategory(toolName: string): ToolCategory {
    return this.catalog.category(toolName);
  }

  /**
   * Check if a tool can be trusted (not in prompt_always category or denied by project)
   */
  canBeTrusted(toolName: string): boolean {
    // Cannot trust denied tools from project config
    if (this.deniedTools.has(toolName)) {
      return false;
    }

    return this.catalog.canTrust(toolName);
  }

  /**
   * Check if a tool is denied by project config
   */
  isDenied(toolName: string): boolean {
    return this.deniedTools.has(toolName);
  }

  /**
   * Get list of denied tools
   */
  getDeniedTools(): string[] {
    return Array.from(this.deniedTools).sort();
  }

  /**
   * Trust a tool for the current session only (in-memory, no persistence)
   * Works for all tool categories including prompt_always, but NOT project-denied tools.
   * For a command-scoped tool this trusts every command; a prompt answer uses trustCommandForSession.
   */
  trustToolForSession(toolName: string): boolean {
    if (this.deniedTools.has(toolName)) {
      return false;
    }
    this.sessionTrustedTools.add(toolName);
    return true;
  }

  /**
   * Whether "allow for this session" is scoped to the command rather than the whole tool: true
   * for a tool that runs a shell command it declares (bash_execute, write_shell_stdin).
   */
  isCommandScoped(toolName: string): boolean {
    return this.catalog.resolve(toolName)?.commandArg !== undefined;
  }

  /** The scopes "allow for this session" would remember for this call, or null for none. */
  sessionScopeFor(toolName: string, command: string): string[] | null {
    if (this.deniedTools.has(toolName) || UNREMEMBERED_COMMAND_TOOLS.has(toolName)) return null;
    return sessionCommandPrefixes(command);
  }

  /**
   * Trust, for the current session, later calls of this tool whose every simple command has a
   * scope `command` has. Returns the scopes remembered, or null when nothing was remembered.
   */
  trustCommandForSession(toolName: string, command: string): string[] | null {
    const prefixes = this.sessionScopeFor(toolName, command);
    if (!prefixes) return null;
    const approved = this.sessionTrustedCommands.get(toolName) ?? new Set<string>();
    for (const prefix of prefixes) approved.add(prefix);
    this.sessionTrustedCommands.set(toolName, approved);
    return prefixes;
  }

  isCommandSessionTrusted(toolName: string, command: string): boolean {
    const approved = this.sessionTrustedCommands.get(toolName);
    if (!approved) return false;
    const prefixes = sessionCommandPrefixes(command);
    return prefixes !== null && prefixes.every(prefix => approved.has(prefix));
  }

  /**
   * Check if a tool is trusted for the current session
   */
  isSessionTrusted(toolName: string): boolean {
    return this.sessionTrustedTools.has(toolName);
  }

  /** Remember a session-scoped approval to run one command outside the sandbox. Never persisted. */
  approveSandboxEscalation(key: string): void {
    this.sandboxEscalationApprovals.add(key);
  }

  isSandboxEscalationApproved(key: string): boolean {
    return this.sandboxEscalationApprovals.has(key);
  }

  /**
   * Clear all session-scoped trust (called on exit or session reset)
   */
  clearSessionTrust(): void {
    this.sessionTrustedTools.clear();
    this.sessionTrustedCommands.clear();
    this.sandboxEscalationApprovals.clear();
  }

  /**
   * Clear all trusted tools
   */
  clearTrustedTools(): void {
    this.trustedTools.clear();
  }

  /**
   * Get statistics about permissions
   */
  getStats(): {
    trustedCount: number;
    autoApproveCount: number;
    promptAlwaysCount: number;
    promptDefaultCount: number;
  } {
    // Count tools by category (this would require knowing all available tools)
    // For now, just return trusted count
    return {
      trustedCount: this.trustedTools.size,
      autoApproveCount: 0, // TODO: Would need full tool list
      promptAlwaysCount: 0,
      promptDefaultCount: 0,
    };
  }
}
