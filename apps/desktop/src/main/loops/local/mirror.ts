import { LOOP_MIRROR_TICKETS_MAX, type LoopMirrorSnapshot } from '@bike4mind/common/loops';
import type { LocalLoopDetail } from '@shared/localLoops';

const MIRROR_PATH = '/api/loops/mirror';

export const MIRROR_MS = {
  /** Changes inside this window go out as one post. */
  debounce: 2_000,
  /** Re-post while signed in, so the web's "last seen" stays fresh with nothing changing. */
  heartbeat: 2 * 60_000,
  backoffMin: 30_000,
  backoffMax: 15 * 60_000,
} as const;

const STATUS_ORDER = { in_progress: 0, blocked: 1, open: 2, closed: 3 } as const;

/**
 * What the web may see of a Desktop loop: status, lanes, spend and ticket titles, nothing else. Never the goal,
 * memory, stage instructions, descriptions, folder or repo, models, runs, sessions or event text. The server's
 * schema (@bike4mind/common/loops loopMirrorSnapshotSchema) is strict and refuses any other field.
 */
export function scrubLoop(detail: LocalLoopDetail): LoopMirrorSnapshot {
  const { loop } = detail;
  const tickets = [...detail.tickets]
    .sort((a, b) => STATUS_ORDER[a.status] - STATUS_ORDER[b.status])
    .slice(0, LOOP_MIRROR_TICKETS_MAX)
    .map(ticket => ({
      title: ticket.title.slice(0, 200),
      stage: ticket.stage.slice(0, 100),
      status: ticket.status,
      ...(ticket.priority && { priority: ticket.priority }),
      ...(ticket.status === 'blocked' && ticket.statusReason && { reason: ticket.statusReason.slice(0, 200) }),
    }));
  return {
    name: loop.name.slice(0, 200),
    status: loop.status,
    ...(detail.idleReason && { idleReason: detail.idleReason.slice(0, 300) }),
    ...(detail.asleepSince && { asleepSince: detail.asleepSince }),
    ...(loop.cappedUntil && { cappedUntil: loop.cappedUntil }),
    stages: loop.stages.slice(0, 20).map(stage => stage.slice(0, 100)),
    lanesBusy: detail.lanesBusy,
    lanes: loop.maxConcurrent,
    spentToday: detail.spentToday,
    ...(loop.budgetCreditsPerDay !== undefined && { budget: loop.budgetCreditsPerDay }),
    needsYou: detail.needsYou,
    tickets,
  };
}

export interface MirrorApi {
  put(path: string, body: unknown): Promise<unknown>;
  delete(path: string): Promise<unknown>;
}

/**
 * Posts each mirrored Desktop loop's scrubbed status to the server for the web and phone, and takes down a loop
 * that was turned off or deleted. Best effort and off the scheduler's path: every failure is logged once and backed
 * off (doubling to MIRROR_MS.backoffMax), never thrown, so a server outage never touches a running loop.
 */
export class LoopMirror {
  /** Loops posted for the current account; one DELETE once they stop being mirrored. */
  private sent = new Set<string>();
  /** A post has gone through since the last reset; before that, every unmirrored loop is taken down once. */
  private synced = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private retryAt = 0;
  private backoff = 0;
  private flushing: Promise<void> | undefined;

  constructor(
    private readonly deps: {
      /** null while signed out. */
      api(): MirrorApi | null;
      details(): LocalLoopDetail[];
      logger: { warn(message: string): void };
      now?: () => number;
    }
  ) {}

  /** A loop changed: post within MIRROR_MS.debounce. */
  changed(): void {
    this.timer ??= setTimeout(() => {
      this.timer = undefined;
      void this.flush();
    }, MIRROR_MS.debounce);
  }

  /** Signed out or into another account: what was sent belonged to the old one. */
  reset(): void {
    this.sent.clear();
    this.synced = false;
    this.retryAt = 0;
    this.backoff = 0;
  }

  /** Post every mirrored loop now (the heartbeat calls this); skipped while backing off. */
  flush(): Promise<void> {
    this.flushing ??= this.post().finally(() => (this.flushing = undefined));
    return this.flushing;
  }

  private async post(): Promise<void> {
    const now = (this.deps.now ?? Date.now)();
    const api = this.deps.api();
    if (!api || now < this.retryAt) return;
    try {
      const details = this.deps.details();
      const mirrored = details.filter(detail => detail.loop.mirror);
      for (const detail of mirrored) {
        await api.put(`${MIRROR_PATH}/${detail.loop.id}`, scrubLoop(detail));
        this.sent.add(detail.loop.id);
      }
      const keep = new Set(mirrored.map(detail => detail.loop.id));
      // After a relaunch nothing says what an earlier run posted: a loop turned off meanwhile is taken down too.
      const off = this.synced ? [...this.sent] : details.map(detail => detail.loop.id);
      for (const id of off) {
        if (keep.has(id)) continue;
        await api.delete(`${MIRROR_PATH}/${id}`);
        this.sent.delete(id);
      }
      this.synced = true;
      this.backoff = 0;
    } catch (err) {
      if (this.backoff === 0) this.deps.logger.warn(`LOOPS: mirror post failed: ${String(err)}`);
      this.backoff = Math.min(Math.max(this.backoff * 2, MIRROR_MS.backoffMin), MIRROR_MS.backoffMax);
      this.retryAt = now + this.backoff;
    }
  }
}
