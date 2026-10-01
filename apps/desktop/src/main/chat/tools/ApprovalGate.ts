import { randomUUID } from 'node:crypto';
import { sep } from 'node:path';
import type { ChatApprovalAnswer } from '@shared/chat';
import type { ApprovalAlways } from './types';

/**
 * A pending approval expires rather than waiting forever. The reply keeps streaming in main
 * after its window closes, so a tool blocked on an answer nobody can give would otherwise hold
 * the turn - and the abort controller - open until the app quits.
 */
const APPROVAL_TIMEOUT_MS = 10 * 60_000;

/** The `optionId` of a question answer that was closed rather than skipped. */
export const QUESTION_CANCELLED = 'cancelled';

interface PendingApproval {
  sessionId: string;
  /** False for a tool whose effect cannot be undone: 'always' is downgraded to 'once'. */
  remember: boolean;
  /** An untimed question card; see ApprovalRequestOptions.untimed. */
  question: boolean;
  settle(answer: ChatApprovalAnswer): void;
}

/**
 * A recorded "always", replayed whole for a later identical call.
 *
 * The OPTION is stored, not just the fact of consent, and that is the point: on a card that
 * offered a choice, a standing approval recorded for one option must never be spent on another.
 * Replaying the answer is what makes "always start this locally" mean that and not "always
 * start this somehow".
 */
export interface StandingApproval {
  optionId?: string;
  value?: string;
}

/** The key a standing approval is filed under: the call, plus which way it was allowed. */
function standingKey(key: string, optionId: string | undefined): string {
  return optionId ? `${key}#${optionId}` : key;
}

/**
 * Whether a remembered shell pattern covers one command. A trailing ` *` also matches the bare
 * command, so `git commit *` covers `git commit` as well as `git commit -m x`, and every other
 * character is literal: a pattern is derived from a command, never typed by anyone.
 */
export function patternMatches(pattern: string, command: string): boolean {
  const bare = pattern.endsWith(' *') ? pattern.slice(0, -2) : null;
  const escaped = (text: string) => text.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  const source = bare === null ? escaped(pattern) : `${escaped(bare)}( .*)?`;
  return new RegExp(`^${source}$`, 's').test(command);
}

function withinDirectory(directory: string, candidate: string): boolean {
  return candidate === directory || candidate.startsWith(directory.endsWith(sep) ? directory : directory + sep);
}

interface StandingShell {
  patterns: Set<string>;
  directories: Set<string>;
}

export interface ApprovalRequestOptions {
  /** What a shell command's 'always' remembers, on top of the exact-call key. */
  always?: ApprovalAlways;
  /**
   * Whether an 'always' answer may be recorded as a standing approval. False on an
   * irreversible tool, where a single click must never cover a later, different call.
   */
  remember?: boolean;
  /**
   * On a card that offers a choice, which of its options may be recorded as standing. An answer
   * naming any other option is honoured for this call and forgotten - that is what stops a
   * redirect, which is an instruction about one call, from ever becoming a policy.
   */
  rememberable?: readonly string[];
  /**
   * Wait until answered or aborted, with no expiry. For a question card: a person deciding
   * something the model is blocked on is not an approval nobody can give, and auto-denying it
   * after ten minutes would throw away the answer they were composing.
   */
  untimed?: boolean;
}

/**
 * Told when a session starts and stops waiting on the user, so the sidebar can say so.
 *
 * Reported from here rather than inferred from the tool-call events, because those are aimed
 * at one open conversation: the gate is what actually knows a background session is blocked.
 * Paired exactly - `settled` fires once for each `requested`, on every exit including timeout,
 * abort and dispose.
 */
export interface ApprovalGateListener {
  requested(sessionId: string): void;
  settled(sessionId: string): void;
}

/**
 * The user's consent for tool calls that change something or run code.
 *
 * This is the whole boundary for shell execution. Commands run as the user with nothing
 * confining them, so the thing standing between a crafted prompt and `cat` of some unrelated
 * file is the user reading the command here before it runs. 'always' is scoped to one
 * conversation and dies with the process: to the exact request, plus for a shell command the
 * prefix patterns (`git commit *`) it was derived into.
 */
export class ApprovalGate {
  private readonly pending = new Map<string, PendingApproval>();

  /** sessionId -> standing key -> the answer to replay. In memory only, by design. */
  private readonly standing = new Map<string, Map<string, StandingApproval>>();

  /** sessionId -> the shell patterns and directories the user said "always" to. */
  private readonly standingShell = new Map<string, StandingShell>();

  constructor(private readonly listener?: ApprovalGateListener) {}

  /**
   * The standing approval covering this call, or null when there is none.
   *
   * `optionIds` are the card's options in the order it draws them, so the first one the user ever
   * said "always" to is the one replayed - the same precedence the card's primary action has.
   */
  isStanding(sessionId: string, key: string, optionIds: readonly string[] = []): StandingApproval | null {
    const keys = this.standing.get(sessionId);
    if (!keys) return null;
    if (optionIds.length === 0) return keys.get(key) ?? null;
    for (const optionId of optionIds) {
      const found = keys.get(standingKey(key, optionId));
      if (found) return found;
    }
    return null;
  }

  /** Whether every sub-command of this script has been allowed before. */
  coversCommands(sessionId: string, always: ApprovalAlways): boolean {
    const standing = this.standingShell.get(sessionId);
    if (!standing || always.commands.length === 0) return false;
    const own = [...standing.patterns]
      .filter(entry => entry.startsWith(`${always.namespace}\x00`))
      .map(entry => entry.slice(always.namespace.length + 1));
    return always.commands.every(({ text }) => own.some(pattern => patternMatches(pattern, text)));
  }

  /** The directories among these that the user has not said "always" to. */
  uncoveredDirectories(sessionId: string, directories: readonly string[]): string[] {
    const standing = this.standingShell.get(sessionId);
    return directories.filter(
      directory => !standing || ![...standing.directories].some(allowed => withinDirectory(allowed, directory))
    );
  }

  /**
   * Ask the user, and resolve once they answer. `announce` receives the id to show them; it is
   * called before any waiting so the request cannot be answered before the renderer knows it.
   */
  async request(
    sessionId: string,
    key: string,
    signal: AbortSignal,
    announce: (approvalId: string) => void,
    options: ApprovalRequestOptions = {}
  ): Promise<ChatApprovalAnswer> {
    const approvalId = randomUUID();
    const remember = options.remember !== false;

    return new Promise<ChatApprovalAnswer>(resolve => {
      let done = false;
      // Whether the user was ever actually asked. The aborted-before-announce path settles
      // without asking, and reporting that as a settled request would leave the sidebar
      // counting an ask that never happened.
      let announced = false;
      const settle = (answer: ChatApprovalAnswer) => {
        if (done) return;
        done = true;
        if (timer) clearTimeout(timer);
        signal.removeEventListener('abort', onAbort);
        this.pending.delete(approvalId);
        // An 'always' on an irreversible tool allows THIS call and nothing after it: the
        // decision still stands, it just is not remembered. Same for an option the caller did
        // not list as rememberable - see ApprovalRequestOptions.rememberable.
        const keep =
          remember &&
          answer.decision === 'always' &&
          (!options.rememberable || (!!answer.optionId && options.rememberable.includes(answer.optionId)));
        if (keep) {
          this.remember(sessionId, standingKey(key, answer.optionId), answer);
          if (options.always) this.rememberShell(sessionId, options.always);
        }
        if (announced) this.listener?.settled(sessionId);
        resolve(answer.decision === 'always' && !keep ? { ...answer, decision: 'once' } : answer);
      };

      const onAbort = () => settle({ decision: 'deny' });
      const timer = options.untimed ? undefined : setTimeout(() => settle({ decision: 'deny' }), APPROVAL_TIMEOUT_MS);
      // Unref so a pending approval never keeps the process alive on quit.
      timer?.unref?.();

      this.pending.set(approvalId, { sessionId, remember, question: !!options.untimed, settle });
      signal.addEventListener('abort', onAbort, { once: true });
      if (signal.aborted) {
        settle({ decision: 'deny' });
        return;
      }

      announced = true;
      this.listener?.requested(sessionId);
      announce(approvalId);
    });
  }

  /** Unknown ids are ignored: a stale click must never answer whatever request came next. */
  resolve(approvalId: string, answer: ChatApprovalAnswer): void {
    this.pending.get(approvalId)?.settle(answer);
  }

  /**
   * The user moved on without answering: close this conversation's open question cards. Told
   * apart from Skip by the option id, which a question card never otherwise carries.
   */
  cancelQuestions(sessionId: string): void {
    for (const entry of this.pending.values()) {
      if (entry.sessionId === sessionId && entry.question) {
        entry.settle({ decision: 'deny', optionId: QUESTION_CANCELLED });
      }
    }
  }

  /** Deleting a conversation drops both its in-flight asks and anything it had standing. */
  forgetSession(sessionId: string): void {
    this.standing.delete(sessionId);
    this.standingShell.delete(sessionId);
    for (const [approvalId, entry] of this.pending) {
      if (entry.sessionId === sessionId) {
        entry.settle({ decision: 'deny' });
        this.pending.delete(approvalId);
      }
    }
  }

  dispose(): void {
    for (const entry of this.pending.values()) entry.settle({ decision: 'deny' });
    this.pending.clear();
    this.standing.clear();
    this.standingShell.clear();
  }

  private rememberShell(sessionId: string, always: ApprovalAlways): void {
    const standing = this.standingShell.get(sessionId) ?? { patterns: new Set(), directories: new Set() };
    for (const { pattern } of always.commands) standing.patterns.add(`${always.namespace}\x00${pattern}`);
    for (const directory of always.directories) standing.directories.add(directory);
    this.standingShell.set(sessionId, standing);
  }

  private remember(sessionId: string, key: string, answer: ChatApprovalAnswer): void {
    const keys = this.standing.get(sessionId) ?? new Map<string, StandingApproval>();
    keys.set(key, {
      ...(answer.optionId ? { optionId: answer.optionId } : {}),
      ...(answer.value === undefined ? {} : { value: answer.value }),
    });
    this.standing.set(sessionId, keys);
  }
}
