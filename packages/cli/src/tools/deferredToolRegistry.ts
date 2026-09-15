import type { ICompletionOptionTools } from '@bike4mind/llm-adapters';
import { logger } from '../utils/Logger.js';

/**
 * Registry of tool schemas that are NOT loaded into the model's initial tool
 * list. The model sees only the names (via the system prompt directory) and
 * must call the `tool_search` meta-tool to load schemas on demand.
 *
 * This mirrors Claude Code's deferred-tool pattern. The win is large for
 * heavy MCP integrations (e.g. 41 GitHub MCP tools at ~250-350 tokens of
 * JSONSchema each = ~10-15k tokens per turn that's now ~1-1.5k of names).
 */
class DeferredToolRegistry {
  private byName = new Map<string, ICompletionOptionTools>();
  /**
   * Frozen snapshot of the directory names captured at `register()` time.
   * The system-prompt directory is rendered from THIS, not from live
   * `byName` keys, so the cache-stamped system block stays byte-identical
   * for the whole session even if `byName` later diverges (e.g. a future
   * optimization that drops loaded tools). See getDirectoryNames().
   */
  private directoryNames: readonly string[] = [];

  /** Replace registry contents with the supplied tools. Idempotent. */
  register(tools: ICompletionOptionTools[]): void {
    this.byName.clear();
    for (const tool of tools) {
      this.byName.set(tool.toolSchema.name, tool);
    }
    this.directoryNames = Object.freeze([...this.byName.keys()].sort());
    logger.debug(`[DeferredToolRegistry] Registered ${tools.length} deferred tool(s)`);
  }

  clear(): void {
    this.byName.clear();
    this.directoryNames = Object.freeze([]);
  }

  size(): number {
    return this.byName.size;
  }

  has(name: string): boolean {
    return this.byName.has(name);
  }

  get(name: string): ICompletionOptionTools | undefined {
    return this.byName.get(name);
  }

  getAll(): ICompletionOptionTools[] {
    return Array.from(this.byName.values());
  }

  /** Return tools whose names appear in the supplied list, in input order. */
  getByNames(names: string[]): ICompletionOptionTools[] {
    const found: ICompletionOptionTools[] = [];
    for (const name of names) {
      const tool = this.byName.get(name);
      if (tool) found.push(tool);
    }
    return found;
  }

  /**
   * Rank-search deferred tools by query terms. Name matches outrank
   * description matches; exact substring on name wins ties.
   */
  searchByKeywords(query: string, maxResults: number): ICompletionOptionTools[] {
    const terms = query
      .toLowerCase()
      .split(/\s+/)
      .filter(t => t.length > 0);

    if (terms.length === 0) return [];

    type Scored = { tool: ICompletionOptionTools; score: number };
    const scored: Scored[] = [];

    for (const tool of this.byName.values()) {
      const name = tool.toolSchema.name.toLowerCase();
      const desc = (tool.toolSchema.description || '').toLowerCase();

      let score = 0;
      for (const term of terms) {
        if (name.includes(term)) score += 10;
        if (desc.includes(term)) score += 1;
      }
      if (score > 0) scored.push({ tool, score });
    }

    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, maxResults).map(s => s.tool);
  }

  /**
   * Directory entries rendered into the cache-stamped system-prompt reminder.
   * Returns the frozen snapshot captured at `register()`, NOT live `byName`
   * keys, so loading a tool mid-session can never change a byte of the cached
   * system block (issue #213). A loaded tool remaining listed here is
   * harmless: re-selecting it via `tool_search` is an idempotent no-op.
   */
  getDirectoryNames(): string[] {
    return [...this.directoryNames];
  }
}

export const deferredToolRegistry = new DeferredToolRegistry();
