import { getToolCategory, canTrustTool, type ToolCategory } from '../config/toolSafety';
import type { SandboxMode } from '../sandbox/types.js';

/**
 * Manages tool permissions and trusted tools
 *
 * Responsibilities:
 * - Track which tools are trusted (don't need permission)
 * - Track which tools are denied (cannot be trusted, from project config)
 * - Check if a tool needs permission based on its category
 * - Persist trusted tools across sessions
 * - Support sandbox auto-allow mode (sandboxed commands skip permission)
 */
export class PermissionManager {
  private trustedTools: Set<string> = new Set();
  private sessionTrustedTools: Set<string> = new Set();
  private deniedTools: Set<string> = new Set();
  private customCategories: Map<string, ToolCategory>;
  private _sandboxMode: SandboxMode = 'disabled';
  private _sandboxActive = false;

  constructor(trustedTools: string[] = [], customCategories?: Record<string, ToolCategory>, deniedTools?: string[]) {
    this.trustedTools = new Set(trustedTools);
    this.customCategories = new Map(Object.entries(customCategories || {}));
    this.deniedTools = new Set(deniedTools || []);
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
   * @param options.isSandboxed - If true, the command will run inside the OS-level sandbox.
   *   In auto-allow mode, sandboxed bash_execute commands skip the permission prompt
   *   because the sandbox provides the security boundary.
   */
  needsPermission(toolName: string, options?: { isSandboxed?: boolean }): boolean {
    const categoryMap = Object.fromEntries(this.customCategories);
    const category = getToolCategory(toolName, categoryMap);

    // Denied tools from project config ALWAYS need permission
    if (this.deniedTools.has(toolName)) {
      return true;
    }

    // auto_approve tools never need permission
    if (category === 'auto_approve') {
      return false;
    }

    // Sandbox auto-allow: sandboxed bash_execute commands skip permission
    // The OS-level sandbox provides the security boundary instead of user prompts
    // Must run before session trust check so sandbox enforcement is never bypassed
    if (options?.isSandboxed && toolName === 'bash_execute' && this.isSandboxAutoAllow()) {
      return false;
    }

    // Session-trusted tools don't need permission (works for all categories including prompt_always)
    if (this.sessionTrustedTools.has(toolName)) {
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
    const categoryMap = Object.fromEntries(this.customCategories);

    // Cannot trust denied tools from project config
    if (this.deniedTools.has(toolName)) {
      return false;
    }

    // Check if tool can be trusted based on category
    if (!canTrustTool(toolName, categoryMap)) {
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
    const categoryMap = Object.fromEntries(this.customCategories);
    return getToolCategory(toolName, categoryMap);
  }

  /**
   * Check if a tool can be trusted (not in prompt_always category or denied by project)
   */
  canBeTrusted(toolName: string): boolean {
    const categoryMap = Object.fromEntries(this.customCategories);

    // Cannot trust denied tools from project config
    if (this.deniedTools.has(toolName)) {
      return false;
    }

    return canTrustTool(toolName, categoryMap);
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
   * Works for all tool categories including prompt_always, but NOT project-denied tools
   */
  trustToolForSession(toolName: string): boolean {
    if (this.deniedTools.has(toolName)) {
      return false;
    }
    this.sessionTrustedTools.add(toolName);
    return true;
  }

  /**
   * Check if a tool is trusted for the current session
   */
  isSessionTrusted(toolName: string): boolean {
    return this.sessionTrustedTools.has(toolName);
  }

  /**
   * Clear all session-scoped trust (called on exit or session reset)
   */
  clearSessionTrust(): void {
    this.sessionTrustedTools.clear();
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
