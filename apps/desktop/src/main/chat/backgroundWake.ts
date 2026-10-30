import type { BackgroundProcessInfo } from '@shared/chat';
import type { BackgroundProcessRegistry } from './tools/BackgroundProcessRegistry';
import { describeStatus } from './tools/backgroundTools';

/** Exits this close together become one notice, so a script that ends three watchers costs one turn. */
const COALESCE_MS = 1_500;

/** Enough of the end of the output for an error or a summary line, not a log dump. */
const TAIL_CHARS = 1_500;

/**
 * Automatic wakes a conversation may take in a row with nobody typing in between. A model that
 * restarts a crashing command on every wake would otherwise spend credits until someone noticed.
 */
export const MAX_CONSECUTIVE_WAKES = 5;

export interface BackgroundExitNotice {
  /** What the model reads, as the user turn that carries it. */
  text: string;
  /** One line for the thread's collapsed row. */
  summary: string;
  processIds: string[];
}

/**
 * Turns background commands ending on their own into notices for the conversation that started
 * them, so the model can end its turn and be told, instead of keeping the turn open to poll.
 *
 * This only collects and words the notices; ChatService decides when one is delivered - a new
 * automatic turn for an idle conversation, or the next round boundary of a running one.
 *
 * Whether an exit is still news is read when the notice is TAKEN, not when the exit lands: the
 * model may well have read the process's output in between, and a notice repeating what it has
 * already seen is a turn spent for nothing. See BackgroundProcessRegistry.takeExitNotice.
 */
export class BackgroundWake {
  private readonly pending = new Map<string, Set<string>>();
  private readonly timers = new Map<string, NodeJS.Timeout>();
  private readonly streaks = new Map<string, number>();

  constructor(
    private readonly registry: Pick<BackgroundProcessRegistry, 'takeExitNotice'>,
    private readonly ready: (sessionId: string) => void,
    private readonly coalesceMs = COALESCE_MS
  ) {}

  exited(sessionId: string, processId: string): void {
    const ids = this.pending.get(sessionId) ?? new Set<string>();
    ids.add(processId);
    this.pending.set(sessionId, ids);
    if (this.timers.has(sessionId)) return;
    const timer = setTimeout(() => {
      this.timers.delete(sessionId);
      this.ready(sessionId);
    }, this.coalesceMs);
    timer.unref?.();
    this.timers.set(sessionId, timer);
  }

  /** A map lookup, because the round loop asks on every round of every turn. */
  has(sessionId: string): boolean {
    return this.pending.has(sessionId);
  }

  /** The notice for everything pending that the model has not seen end yet; null when nothing is left. */
  take(sessionId: string): BackgroundExitNotice | null {
    const ids = this.pending.get(sessionId);
    this.cancelTimer(sessionId);
    this.pending.delete(sessionId);
    if (!ids) return null;

    const ended = [...ids].flatMap(id => this.registry.takeExitNotice(id, sessionId, TAIL_CHARS) ?? []);
    if (ended.length === 0) return null;
    return {
      text: noticeText(ended),
      summary: noticeSummary(ended.map(entry => entry.info)),
      processIds: ended.map(entry => entry.info.id),
    };
  }

  /** Count one automatic wake; false once the streak is at its cap. */
  claimWake(sessionId: string): boolean {
    const streak = this.streaks.get(sessionId) ?? 0;
    if (streak >= MAX_CONSECUTIVE_WAKES) return false;
    this.streaks.set(sessionId, streak + 1);
    return true;
  }

  /** Someone typed into the conversation, so whatever the wakes were doing has been looked at. */
  attended(sessionId: string): void {
    this.streaks.delete(sessionId);
  }

  /** Drop what is waiting, but not the streak: a stop is not the user answering a wake. */
  discard(sessionId: string): void {
    this.cancelTimer(sessionId);
    this.pending.delete(sessionId);
  }

  forget(sessionId: string): void {
    this.discard(sessionId);
    this.streaks.delete(sessionId);
  }

  dispose(): void {
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    this.pending.clear();
  }

  private cancelTimer(sessionId: string): void {
    const timer = this.timers.get(sessionId);
    if (timer) clearTimeout(timer);
    this.timers.delete(sessionId);
  }
}

function noticeText(ended: readonly { info: BackgroundProcessInfo; tail: string }[]): string {
  const blocks = ended.map(({ info, tail }) => {
    const output = tail.trim();
    return [
      `[${info.id}] $ ${info.command}`,
      `(in ${info.cwd}) - ${describeStatus(info)}`,
      ...(output ? ['Last output:', output] : ['[no output]']),
    ].join('\n');
  });
  return [
    `[The app is telling you that ${ended.length === 1 ? 'a background command' : 'background commands'} you started in this conversation ${ended.length === 1 ? 'has' : 'have'} finished. This is not the user typing.]`,
    '',
    ...blocks.flatMap((block, index) => (index === 0 ? [block] : ['', block])),
    '',
    '[Carry on with whatever was waiting on this, or tell the user the result if it was the last step. Read more of its output with bash_output if you need it.]',
  ].join('\n');
}

function noticeSummary(infos: readonly BackgroundProcessInfo[]): string {
  return infos.map(info => `[${info.id}] ${describeStatus(info)}`).join(', ');
}
