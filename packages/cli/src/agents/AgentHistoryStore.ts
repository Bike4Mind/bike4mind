import type { AgentCheckpoint, ThoroughnessLevel } from '@bike4mind/agents';
import type { AgentDefinition } from './types.js';
import { DEFAULT_SUBAGENT_HISTORY_TTL_MS, MAX_SUBAGENT_HISTORY_ENTRIES } from '../config/constants.js';

/**
 * A completed sub-agent's conversation snapshot, retained so the orchestrator
 * can resume the session with its full context via the resume_agent tool.
 */
export interface StoredAgentHistory {
  /** Full ReActAgent checkpoint (messages + execution trace). @see ReActAgent.toCheckpoint() */
  checkpoint: AgentCheckpoint;
  /** Agent definition name to rebuild on resume. */
  agentName: string;
  /**
   * The resolved agent definition, replayed on resume so a session spawned from
   * an inline/dynamic definition (or one no longer in the store) still rebuilds.
   */
  agentDefinition: AgentDefinition;
  /** Thoroughness the original run used, reused on resume. */
  thoroughness: ThoroughnessLevel;
  /** Parent session that owned the original run. */
  parentSessionId: string;
  /** Completion timestamp (ms); drives TTL eviction. */
  endTime: number;
}

/**
 * In-memory store of finished sub-agent conversations, keyed by resume id
 * (the background job id for background runs, or a generated id for foreground).
 *
 * Eviction mirrors BackgroundAgentManager.cleanupOldJobs: opportunistic and
 * lazy (run on each set()), never a timer. Entries do not survive a CLI restart
 * by design - resume is a within-session affordance bounded by a configurable TTL.
 */
export class AgentHistoryStore {
  private entries = new Map<string, StoredAgentHistory>();
  private readonly ttlMs: number;

  constructor(ttlMs: number = DEFAULT_SUBAGENT_HISTORY_TTL_MS) {
    this.ttlMs = ttlMs;
  }

  set(id: string, entry: StoredAgentHistory): void {
    this.entries.set(id, entry);
    this.cleanup();
  }

  get(id: string): StoredAgentHistory | undefined {
    return this.entries.get(id);
  }

  has(id: string): boolean {
    return this.entries.has(id);
  }

  delete(id: string): boolean {
    return this.entries.delete(id);
  }

  size(): number {
    return this.entries.size;
  }

  /**
   * Evict expired and excess histories. Two passes, matching the background-job
   * cleanup: drop anything older than maxAgeMs, then, if still over the cap,
   * drop the oldest until back under it. Returns the number evicted.
   */
  cleanup(maxAgeMs: number = this.ttlMs): number {
    const now = Date.now();
    let cleaned = 0;

    for (const [id, entry] of this.entries.entries()) {
      if (now - entry.endTime > maxAgeMs) {
        this.entries.delete(id);
        cleaned++;
      }
    }

    if (this.entries.size > MAX_SUBAGENT_HISTORY_ENTRIES) {
      const oldestFirst = Array.from(this.entries.entries()).sort((a, b) => a[1].endTime - b[1].endTime);
      const overflow = this.entries.size - MAX_SUBAGENT_HISTORY_ENTRIES;
      for (const [id] of oldestFirst.slice(0, overflow)) {
        this.entries.delete(id);
        cleaned++;
      }
    }

    return cleaned;
  }
}
