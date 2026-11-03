import type { LoopPolicy, LoopRunnerSettings } from '@shared/loopRunner';
import type { PrivateFile } from '../privateFile';

/** A worktree a runner session cut, so cleanup only ever touches its own. */
export interface RunnerWorktree {
  sessionId: string;
  path: string;
  branch: string;
  ticketId: string;
  createdAt: string;
  finishedAt?: string;
}

interface Stored {
  /** environment key -> loopId -> policy */
  policies: Record<string, Record<string, LoopPolicy>>;
  settings: Record<string, LoopRunnerSettings>;
  worktrees: RunnerWorktree[];
}

const DEFAULT_SETTINGS: LoopRunnerSettings = { enabled: false, runOnBattery: false };

/**
 * The runner's persisted state: per-environment settings, the loops the user approved, and the
 * worktrees runner sessions created. Unlike a session's approval mode none of it resets on
 * relaunch; that is what lets a crashed runner resume without asking again.
 */
export class LoopPolicyStore {
  private cache: Stored | undefined;
  private writing: Promise<void> = Promise.resolve();

  constructor(private readonly file: PrivateFile) {}

  private async load(): Promise<Stored> {
    if (this.cache) return this.cache;
    let parsed: Partial<Stored> = {};
    try {
      parsed = JSON.parse((await this.file.read()) ?? '{}') as Partial<Stored>;
    } catch {
      // A corrupt file loses approvals, which only means asking again: the safe direction.
    }
    this.cache = {
      policies: parsed.policies ?? {},
      settings: parsed.settings ?? {},
      worktrees: parsed.worktrees ?? [],
    };
    return this.cache;
  }

  private async save(change: (stored: Stored) => void): Promise<void> {
    const stored = await this.load();
    change(stored);
    const text = JSON.stringify(stored, null, 2);
    this.writing = this.writing.then(() => this.file.write(text));
    await this.writing;
  }

  async settings(env: string): Promise<LoopRunnerSettings> {
    return { ...DEFAULT_SETTINGS, ...(await this.load()).settings[env] };
  }

  async setSettings(env: string, patch: Partial<LoopRunnerSettings>): Promise<LoopRunnerSettings> {
    let next = DEFAULT_SETTINGS;
    await this.save(stored => {
      next = { ...DEFAULT_SETTINGS, ...stored.settings[env], ...patch };
      stored.settings[env] = next;
    });
    return next;
  }

  async policies(env: string): Promise<LoopPolicy[]> {
    return Object.values((await this.load()).policies[env] ?? {});
  }

  async policy(env: string, loopId: string): Promise<LoopPolicy | null> {
    return (await this.load()).policies[env]?.[loopId] ?? null;
  }

  async approve(env: string, policy: LoopPolicy): Promise<void> {
    await this.save(stored => {
      stored.policies[env] = { ...stored.policies[env], [policy.loopId]: policy };
    });
  }

  async revoke(env: string, loopId: string): Promise<void> {
    await this.save(stored => {
      delete stored.policies[env]?.[loopId];
    });
  }

  async worktrees(): Promise<RunnerWorktree[]> {
    return [...(await this.load()).worktrees];
  }

  async recordWorktree(worktree: RunnerWorktree): Promise<void> {
    await this.save(stored => {
      stored.worktrees = [...stored.worktrees.filter(entry => entry.sessionId !== worktree.sessionId), worktree];
    });
  }

  async finishWorktree(sessionId: string, finishedAt: string): Promise<void> {
    await this.save(stored => {
      stored.worktrees = stored.worktrees.map(entry =>
        entry.sessionId === sessionId ? { ...entry, finishedAt } : entry
      );
    });
  }

  async forgetWorktree(sessionId: string): Promise<void> {
    await this.save(stored => {
      stored.worktrees = stored.worktrees.filter(entry => entry.sessionId !== sessionId);
    });
  }
}
