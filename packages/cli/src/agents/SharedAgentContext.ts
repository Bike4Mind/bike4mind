/**
 * SharedAgentContext - a namespaced key-value store for inter-agent communication.
 *
 * Enables agents in a pipeline to share discoveries without re-exploring.
 * Agent A can write file paths and insights; Agent B reads them.
 *
 * Constraints:
 * - Max 50 entries per namespace
 * - Values truncated at 2000 characters
 * - TTL: entries expire after 30 minutes (configurable)
 * - Agents declare access via frontmatter: shared-context: [read, write] | [read]
 */

/** Maximum entries per namespace */
const MAX_ENTRIES_PER_NAMESPACE = 50;

/** Maximum number of namespaces */
const MAX_NAMESPACES = 20;

/** Maximum character length for values */
const MAX_VALUE_LENGTH = 2000;

/** Default TTL in milliseconds (30 minutes) */
const DEFAULT_TTL_MS = 30 * 60 * 1000;

/** A single entry in the shared context */
interface SharedContextEntry {
  value: string;
  createdAt: number;
  updatedAt: number;
  expiresAt: number;
  writtenBy: string;
}

/**
 * SharedAgentContext provides a namespaced key-value store
 * for agents running in the same pipeline to exchange information.
 */
export class SharedAgentContext {
  private namespaces = new Map<string, Map<string, SharedContextEntry>>();
  private ttlMs: number;

  constructor(ttlMs: number = DEFAULT_TTL_MS) {
    this.ttlMs = ttlMs;
  }

  /**
   * Set a value in the shared context.
   *
   * @param namespace - Namespace to scope the key under
   * @param key - Key to store the value under
   * @param value - Value to store (truncated at 2000 chars)
   * @param writtenBy - Agent name that wrote this entry
   * @throws If the namespace has reached its 50-entry limit for a new key
   */
  set(namespace: string, key: string, value: string, writtenBy: string): void {
    const ns = this.getOrCreateNamespace(namespace);
    this.evictExpired(ns);

    const truncatedValue = value.length > MAX_VALUE_LENGTH ? value.slice(0, MAX_VALUE_LENGTH) : value;

    const existing = ns.get(key);
    const now = Date.now();

    if (existing) {
      // Update existing entry - doesn't count against the limit
      existing.value = truncatedValue;
      existing.updatedAt = now;
      existing.expiresAt = now + this.ttlMs;
      existing.writtenBy = writtenBy;
      return;
    }

    // New entry - enforce limit
    if (ns.size >= MAX_ENTRIES_PER_NAMESPACE) {
      throw new Error(
        `Namespace "${namespace}" has reached the maximum of ${MAX_ENTRIES_PER_NAMESPACE} entries. ` +
          `Remove unused entries or use a different namespace.`
      );
    }

    ns.set(key, {
      value: truncatedValue,
      createdAt: now,
      updatedAt: now,
      expiresAt: now + this.ttlMs,
      writtenBy,
    });
  }

  /**
   * Get a value from the shared context.
   *
   * @returns The value, or undefined if not found or expired
   */
  get(namespace: string, key: string): string | undefined {
    const ns = this.namespaces.get(namespace);
    if (!ns) return undefined;

    const entry = ns.get(key);
    if (!entry) return undefined;

    if (Date.now() > entry.expiresAt) {
      ns.delete(key);
      return undefined;
    }

    return entry.value;
  }

  /**
   * Check if a key exists and is not expired.
   */
  has(namespace: string, key: string): boolean {
    return this.get(namespace, key) !== undefined;
  }

  /**
   * Delete a specific key from a namespace.
   */
  delete(namespace: string, key: string): boolean {
    const ns = this.namespaces.get(namespace);
    if (!ns) return false;
    return ns.delete(key);
  }

  /**
   * List all non-expired keys in a namespace.
   */
  keys(namespace: string): string[] {
    const ns = this.namespaces.get(namespace);
    if (!ns) return [];

    this.evictExpired(ns);
    return Array.from(ns.keys());
  }

  /**
   * Get all non-expired entries in a namespace as a plain object.
   */
  getAll(namespace: string): Record<string, string> {
    const ns = this.namespaces.get(namespace);
    if (!ns) return {};

    this.evictExpired(ns);
    const result: Record<string, string> = {};
    for (const [key, entry] of ns) {
      result[key] = entry.value;
    }
    return result;
  }

  /**
   * Get the number of non-expired entries in a namespace.
   */
  size(namespace: string): number {
    const ns = this.namespaces.get(namespace);
    if (!ns) return 0;

    this.evictExpired(ns);
    return ns.size;
  }

  /**
   * List all namespaces that have at least one non-expired entry.
   */
  listNamespaces(): string[] {
    const active: string[] = [];
    for (const [name, ns] of this.namespaces) {
      this.evictExpired(ns);
      if (ns.size > 0) {
        active.push(name);
      }
    }
    return active;
  }

  /**
   * Clear all entries in a specific namespace.
   */
  clearNamespace(namespace: string): void {
    this.namespaces.delete(namespace);
  }

  /**
   * Clear all namespaces and entries.
   */
  clearAll(): void {
    this.namespaces.clear();
  }

  private getOrCreateNamespace(namespace: string): Map<string, SharedContextEntry> {
    let ns = this.namespaces.get(namespace);
    if (!ns) {
      if (this.namespaces.size >= MAX_NAMESPACES) {
        throw new Error(
          `Maximum of ${MAX_NAMESPACES} namespaces reached. ` + `Reuse an existing namespace or clear unused ones.`
        );
      }
      ns = new Map();
      this.namespaces.set(namespace, ns);
    }
    return ns;
  }

  private evictExpired(ns: Map<string, SharedContextEntry>): void {
    const now = Date.now();
    for (const [key, entry] of ns) {
      if (now > entry.expiresAt) {
        ns.delete(key);
      }
    }
  }
}
