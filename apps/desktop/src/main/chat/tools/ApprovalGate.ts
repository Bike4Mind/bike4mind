import { randomUUID } from 'node:crypto';
import type { ChatApprovalDecision, ChatPendingApproval } from '@shared/chat';

/**
 * A pending approval expires rather than waiting forever. The reply keeps streaming in main
 * after its window closes, so a tool blocked on an answer nobody can give would otherwise hold
 * the turn - and the abort controller - open until the app quits.
 */
const APPROVAL_TIMEOUT_MS = 10 * 60_000;

interface PendingApproval {
  sessionId: string;
  /** What the inbox shows for this request. See ChatPendingApproval. */
  summary: ChatPendingApproval;
  /** False for a tool whose effect cannot be undone: 'always' is downgraded to 'once'. */
  remember: boolean;
  settle(decision: ChatApprovalDecision): void;
}

/** Everything a caller has to say about a request beyond its key, for the inbox. */
export type ApprovalDescription = Omit<ChatPendingApproval, 'approvalId' | 'sessionId' | 'requestedAt'>;

export interface ApprovalRequestOptions {
  /**
   * Whether an 'always' answer may be recorded as a standing approval. False on an
   * irreversible tool, where a single click must never cover a later, different call.
   */
  remember?: boolean;
}

/**
 * Told when a session starts and stops waiting on the user, so the sidebar can say so.
 *
 * Reported from here rather than inferred from the tool-call events, because those are aimed
 * at one open conversation: the gate is what actually knows a background session is blocked.
 * Paired exactly - `settled` fires once for each `requested`, on every exit including timeout,
 * abort and dispose.
 *
 * `changed` fires whenever the pending SET moves, which is the signal the cross-session inbox
 * redraws on. It fires on paths `requested`/`settled` deliberately do not, such as an approval
 * dropped with its conversation.
 */
export interface ApprovalGateListener {
  requested(sessionId: string): void;
  settled(sessionId: string): void;
  changed(): void;
}

/**
 * The user's consent for tool calls that change something or run code.
 *
 * This is the whole boundary for shell execution. The sandbox confines WRITES to the granted
 * folders, but reads inside it are open (a command needs /usr, /bin and the dynamic linker to
 * run at all), so the thing standing between a crafted prompt and `cat` of some unrelated file
 * is the user reading the command here before it runs. Auto-approving is deliberately not an
 * option: 'always' is scoped to one exact request in one conversation and dies with the process.
 */
export class ApprovalGate {
  private readonly pending = new Map<string, PendingApproval>();

  /** sessionId -> request keys the user chose 'always' for. In memory only, by design. */
  private readonly standing = new Map<string, Set<string>>();

  constructor(private readonly listener?: ApprovalGateListener) {}

  isStanding(sessionId: string, key: string): boolean {
    return this.standing.get(sessionId)?.has(key) ?? false;
  }

  /** Everything waiting on the user right now, oldest first - the order it should be answered in. */
  pendingApprovals(): ChatPendingApproval[] {
    return [...this.pending.values()]
      .map(entry => entry.summary)
      .sort((a, b) => a.requestedAt.localeCompare(b.requestedAt));
  }

  /**
   * Ask the user, and resolve once they answer. `announce` receives the id to show them; it is
   * called before any waiting so the request cannot be answered before the renderer knows it.
   */
  async request(
    sessionId: string,
    key: string,
    signal: AbortSignal,
    describe: ApprovalDescription,
    announce: (approvalId: string) => void,
    options: ApprovalRequestOptions = {}
  ): Promise<ChatApprovalDecision> {
    const approvalId = randomUUID();
    const remember = options.remember !== false;

    return new Promise<ChatApprovalDecision>(resolve => {
      let done = false;
      // Whether the user was ever actually asked. The aborted-before-announce path settles
      // without asking, and reporting that as a settled request would leave the sidebar
      // counting an ask that never happened.
      let announced = false;
      const settle = (decision: ChatApprovalDecision) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        signal.removeEventListener('abort', onAbort);
        this.pending.delete(approvalId);
        // An 'always' on an irreversible tool allows THIS call and nothing after it: the
        // decision still stands, it just is not remembered.
        if (decision === 'always' && remember) this.remember(sessionId, key);
        if (announced) {
          this.listener?.settled(sessionId);
          this.listener?.changed();
        }
        resolve(decision === 'always' && !remember ? 'once' : decision);
      };

      const onAbort = () => settle('deny');
      const timer = setTimeout(() => settle('deny'), APPROVAL_TIMEOUT_MS);
      // Unref so a pending approval never keeps the process alive on quit.
      timer.unref?.();

      this.pending.set(approvalId, {
        sessionId,
        remember,
        summary: { ...describe, approvalId, sessionId, requestedAt: new Date().toISOString() },
        settle,
      });
      signal.addEventListener('abort', onAbort, { once: true });
      if (signal.aborted) {
        settle('deny');
        return;
      }

      announced = true;
      this.listener?.requested(sessionId);
      announce(approvalId);
      this.listener?.changed();
    });
  }

  /** Unknown ids are ignored: a stale click must never answer whatever request came next. */
  resolve(approvalId: string, decision: ChatApprovalDecision): void {
    this.pending.get(approvalId)?.settle(decision);
  }

  /** Deleting a conversation drops both its in-flight asks and anything it had standing. */
  forgetSession(sessionId: string): void {
    this.standing.delete(sessionId);
    for (const [approvalId, entry] of this.pending) {
      if (entry.sessionId === sessionId) {
        entry.settle('deny');
        this.pending.delete(approvalId);
      }
    }
    this.listener?.changed();
  }

  dispose(): void {
    for (const entry of this.pending.values()) entry.settle('deny');
    this.pending.clear();
    this.standing.clear();
  }

  private remember(sessionId: string, key: string): void {
    const keys = this.standing.get(sessionId) ?? new Set<string>();
    keys.add(key);
    this.standing.set(sessionId, keys);
  }
}
