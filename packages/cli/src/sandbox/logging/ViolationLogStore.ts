import { promises as fs } from 'fs';
import path from 'path';
import { homedir } from 'os';
import type { SandboxViolation, SandboxViolationEntry } from '../types.js';

const MAX_VIOLATIONS = 5000;
const DEFAULT_PATH = path.join(homedir(), '.bike4mind', 'violations.jsonl');

/**
 * Persists sandbox violations to a JSONL file.
 * Follows the same pattern as CommandHistoryStore.
 */
export class ViolationLogStore {
  private storePath: string;
  private cache: SandboxViolationEntry[] | null = null;

  constructor(storePath?: string) {
    this.storePath = storePath ?? DEFAULT_PATH;
  }

  /** Ensure parent directory exists */
  private async init(): Promise<void> {
    const dir = path.dirname(this.storePath);
    await fs.mkdir(dir, { recursive: true });
  }

  /** Load all entries from disk (newest first) */
  async load(): Promise<SandboxViolationEntry[]> {
    if (this.cache) {
      return this.cache;
    }

    try {
      const data = await fs.readFile(this.storePath, 'utf-8');
      const lines = data
        .trim()
        .split('\n')
        .filter(line => line.length > 0);

      const entries: SandboxViolationEntry[] = lines
        .map(line => {
          try {
            return JSON.parse(line) as SandboxViolationEntry;
          } catch {
            return null;
          }
        })
        .filter((entry): entry is SandboxViolationEntry => entry !== null);

      // Sort newest first
      entries.sort((a, b) => b.timestamp - a.timestamp);
      this.cache = entries;
      return this.cache;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        this.cache = [];
        return this.cache;
      }
      throw error;
    }
  }

  /** Record a new violation (converts Date -> epoch ms, appends JSONL) */
  async record(violation: SandboxViolation): Promise<void> {
    const entry: SandboxViolationEntry = {
      type: violation.type,
      command: violation.command,
      blockedBy: violation.blockedBy,
      timestamp: violation.timestamp.getTime(),
      ...(violation.path && { path: violation.path }),
      ...(violation.domain && { domain: violation.domain }),
      ...(violation.detail && { detail: violation.detail }),
    };

    await this.init();
    const line = JSON.stringify(entry) + '\n';
    await fs.appendFile(this.storePath, line, 'utf-8');

    // Update cache (newest first)
    this.cache = [entry, ...(this.cache ?? [])];

    // Auto-trim
    if (this.cache.length > MAX_VIOLATIONS) {
      await this.trim();
    }
  }

  /** Get recent violations (default 50) */
  async getRecent(count = 50): Promise<SandboxViolationEntry[]> {
    const entries = await this.load();
    return entries.slice(0, count);
  }

  /** Count violations by type */
  async countByType(): Promise<{ filesystem: number; network: number }> {
    const entries = await this.load();
    let filesystem = 0;
    let network = 0;
    for (const entry of entries) {
      if (entry.type === 'filesystem') filesystem++;
      else if (entry.type === 'network') network++;
    }
    return { filesystem, network };
  }

  /** Clear all violations */
  async clear(): Promise<void> {
    try {
      await fs.unlink(this.storePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error;
      }
    }
    this.cache = [];
  }

  /** Trim to MAX_VIOLATIONS (rewrite file) */
  private async trim(): Promise<void> {
    if (!this.cache || this.cache.length <= MAX_VIOLATIONS) {
      return;
    }

    // Keep only the most recent MAX_VIOLATIONS
    const trimmed = this.cache.slice(0, MAX_VIOLATIONS);

    // Rewrite file in chronological order (oldest first for JSONL append pattern)
    const lines = [...trimmed]
      .reverse()
      .map(entry => JSON.stringify(entry))
      .join('\n');

    await fs.writeFile(this.storePath, lines + '\n', 'utf-8');
    this.cache = trimmed;
  }
}
