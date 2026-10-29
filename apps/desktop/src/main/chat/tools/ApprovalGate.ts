import { randomUUID } from 'node:crypto';
import { basename, sep } from 'node:path';
import type { ChatApprovalAnswer } from '@shared/chat';
import type { ApprovalAlways } from './types';

/** The `optionId` of a question answer that was closed rather than skipped. */
export const QUESTION_CANCELLED = 'cancelled';

/**
 * What settled a card. A card never expires: it waits for a click, and only these close it
 * without one. 'covered' is a rule or standing answer given on another card (settleCovered),
 * 'moved-on' a question card closed because a new message was sent (cancelQuestions).
 */
export type ApprovalSettledBy = 'user' | 'covered' | 'stopped' | 'conversation-deleted' | 'app-quit' | 'moved-on';

/**
 * The answer a card settled with, and who gave it. `asked` is false only when the request was
 * closed before its card was announced, so nobody was ever shown it.
 */
export type ApprovalSettlement = ChatApprovalAnswer & { settledBy: ApprovalSettledBy; asked: boolean };

interface PendingApproval {
  sessionId: string;
  /** See ApprovalRequestOptions.recheck. */
  recheck?: () => Promise<ChatApprovalAnswer | null>;
  /** False for a tool whose effect cannot be undone: 'always' is downgraded to 'once'. */
  remember: boolean;
  /** See ApprovalRequestOptions.question. */
  question: boolean;
  settle(answer: ChatApprovalAnswer, settledBy: ApprovalSettledBy): void;
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
  /**
   * Answered on a card that already said the reply had read untrusted content, so the user
   * consented knowing that, and a later tainted call with the same key need not ask again.
   */
  overTaint?: true;
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

const TOOLCHAIN_EXECUTABLES = new Set(['vitest', 'jest', 'tsc', 'eslint', 'prettier', 'turbo']);
const PACKAGE_RUNNERS = new Set(['pnpm', 'npm', 'yarn', 'bun']);
const EXEC_SUBCOMMANDS = new Set(['exec', 'x', 'dlx']);
const SCRIPT_SUBCOMMANDS = new Set(['run', 'run-script', 'task']);

/**
 * A prefix must bind more than a runner or interpreter before its wildcard. Counting words
 * alone mistakes `pnpm exec -- *` and `pnpm exec node *` for a narrower permission than `node *`.
 * Keep their exact-call approval, but ask again when a later tainted call changes the payload.
 */
function hasBoundedTaintPrefix(pattern: string): boolean {
  const prefix = pattern.endsWith(' *') ? pattern.slice(0, -2).split(' ') : [];
  if (prefix.length < 2) return false;
  const [program, subcommand, target] = prefix.map(word => word.replace(/['"]/g, ''));
  if (PACKAGE_RUNNERS.has(program) || program === 'deno') {
    if (EXEC_SUBCOMMANDS.has(subcommand)) {
      // A package executor needs a fixed tool. Arbitrary interpreters (including unknown ones)
      // are exact-call approvals; their next argument can select a completely different script.
      return target !== undefined && TOOLCHAIN_EXECUTABLES.has(target);
    }
    if (SCRIPT_SUBCOMMANDS.has(subcommand)) return target !== undefined && !target.startsWith('-');
    // Bare package tasks may also resolve to binaries. Only known development task names get
    // prefix replay; an unknown task still retains the exact-call answer.
    return /(^|[:._/-])(test|tests|spec|unit|e2e|integration|typecheck|types|tsc|lint|eslint|stylelint|format|fmt|prettier|build|compile|check|verify|validate|coverage|vitest|jest)($|[:._/-])/.test(
      subcommand
    );
  }
  const last = basename(prefix[prefix.length - 1].replace(/['"]/g, ''));
  return last !== '' && !last.startsWith('-') && !EXEC_SUBCOMMANDS.has(last) && !SCRIPT_SUBCOMMANDS.has(last);
}

function withinDirectory(directory: string, candidate: string): boolean {
  return candidate === directory || candidate.startsWith(directory.endsWith(sep) ? directory : directory + sep);
}

interface StandingShell {
  patterns: Set<string>;
  /** The patterns answered on a card that said the reply had read untrusted content. */
  overTaint: Set<string>;
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
  /** A question card, which a new message closes via cancelQuestions rather than leaving live. */
  question?: boolean;
  /** The card said the reply had read untrusted content; recorded on an 'always' as overTaint. */
  tainted?: boolean;
  /**
   * Whether a standing answer or rule given since the card was shown now covers this call: the
   * answer to settle it with, or null to keep asking. Run by settleCovered after another card's
   * "always", so five parallel fetches need one click rather than five.
   */
  recheck?: () => Promise<ChatApprovalAnswer | null>;
}

/**
 * Told when a session starts and stops waiting on the user, so the sidebar can say so.
 *
 * Reported from here rather than inferred from the tool-call events, because those are aimed
 * at one open conversation: the gate is what actually knows a background session is blocked.
 * Paired exactly - `settled` fires once for each `requested`, on every exit including abort,
 * forgetSession and dispose.
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

  /** sessionId -> exact approval key -> the shell patterns and directories it allowed. */
  private readonly standingShell = new Map<string, Map<string, StandingShell>>();

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

  revoke(sessionId: string, key: string): boolean {
    const keys = this.standing.get(sessionId);
    if (!keys) return false;
    let removed = keys.delete(key);
    for (const stored of keys.keys()) {
      if (stored.startsWith(`${key}#`)) {
        keys.delete(stored);
        removed = true;
      }
    }
    return (this.standingShell.get(sessionId)?.delete(key) ?? false) || removed;
  }

  /**
   * Whether every sub-command of this script has been allowed before. Over a tainted reply only
   * patterns answered over taint count, never an unbounded runner pattern such as `node *` or
   * `pnpm exec -- *`, and never an inline or stdin script.
   */
  coversCommands(sessionId: string, always: ApprovalAlways, tainted = false): boolean {
    const standing = this.standingShell.get(sessionId);
    if (!standing || always.commands.length === 0) return false;
    const own = [...standing.values()]
      .flatMap(entry => [...(tainted ? entry.overTaint : entry.patterns)])
      .filter(entry => entry.startsWith(`${always.namespace}\x00`))
      .map(entry => entry.slice(always.namespace.length + 1));
    return always.commands.every(
      ({ text, coverable, opaque }) =>
        coverable && !(tainted && opaque) && own.some(pattern => patternMatches(pattern, text))
    );
  }

  /** The directories among these that the user has not said "always" to. */
  uncoveredDirectories(sessionId: string, directories: readonly string[]): string[] {
    const standing = this.standingShell.get(sessionId);
    const allowedDirectories = standing ? [...standing.values()].flatMap(entry => [...entry.directories]) : [];
    return directories.filter(directory => !allowedDirectories.some(allowed => withinDirectory(allowed, directory)));
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
  ): Promise<ApprovalSettlement> {
    const approvalId = randomUUID();
    const remember = options.remember !== false;

    return new Promise<ApprovalSettlement>(resolve => {
      let done = false;
      // Whether the user was ever actually asked. The aborted-before-announce path settles
      // without asking, and reporting that as a settled request would leave the sidebar
      // counting an ask that never happened.
      let announced = false;
      const settle = (answer: ChatApprovalAnswer, settledBy: ApprovalSettledBy) => {
        if (done) return;
        done = true;
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
          this.remember(sessionId, standingKey(key, answer.optionId), answer, options.tainted === true);
          if (options.always) this.rememberShell(sessionId, key, options.always, options.tainted === true);
        }
        if (announced) this.listener?.settled(sessionId);
        resolve({
          ...answer,
          ...(answer.decision === 'always' && !keep ? { decision: 'once' } : {}),
          settledBy,
          asked: announced,
        });
      };

      const onAbort = () => settle({ decision: 'deny' }, 'stopped');

      this.pending.set(approvalId, {
        sessionId,
        remember,
        question: options.question === true,
        settle,
        ...(options.recheck ? { recheck: options.recheck } : {}),
      });
      signal.addEventListener('abort', onAbort, { once: true });
      if (signal.aborted) {
        settle({ decision: 'deny' }, 'stopped');
        return;
      }

      announced = true;
      this.listener?.requested(sessionId);
      announce(approvalId);
    });
  }

  /** Unknown ids are ignored: a stale click must never answer whatever request came next. */
  resolve(approvalId: string, answer: ChatApprovalAnswer): void {
    this.pending.get(approvalId)?.settle(answer, 'user');
  }

  /**
   * Settle every pending card that a new standing answer or rule now covers - this
   * conversation's, or every conversation's when `sessionId` is omitted (a rule was saved). Walks
   * only the pending cards, never a transcript; a card without a `recheck` keeps waiting.
   */
  async settleCovered(sessionId?: string): Promise<void> {
    const candidates = [...this.pending.values()].filter(
      entry => entry.recheck && (sessionId === undefined || entry.sessionId === sessionId)
    );
    await Promise.all(
      candidates.map(async entry => {
        const answer = await entry.recheck?.().catch(() => null);
        if (answer) entry.settle(answer, 'covered');
      })
    );
  }

  /**
   * The user moved on without answering: close this conversation's open question cards. Told
   * apart from Skip by the option id, which a question card never otherwise carries.
   */
  cancelQuestions(sessionId: string): void {
    for (const entry of this.pending.values()) {
      if (entry.sessionId === sessionId && entry.question) {
        entry.settle({ decision: 'deny', optionId: QUESTION_CANCELLED }, 'moved-on');
      }
    }
  }

  /** Deleting a conversation drops both its in-flight asks and anything it had standing. */
  forgetSession(sessionId: string): void {
    this.standing.delete(sessionId);
    this.standingShell.delete(sessionId);
    for (const [approvalId, entry] of this.pending) {
      if (entry.sessionId === sessionId) {
        entry.settle({ decision: 'deny' }, 'conversation-deleted');
        this.pending.delete(approvalId);
      }
    }
  }

  dispose(): void {
    for (const entry of this.pending.values()) entry.settle({ decision: 'deny' }, 'app-quit');
    this.pending.clear();
    this.standing.clear();
    this.standingShell.clear();
  }

  private rememberShell(sessionId: string, key: string, always: ApprovalAlways, overTaint: boolean): void {
    const byKey = this.standingShell.get(sessionId) ?? new Map<string, StandingShell>();
    const standing = byKey.get(key) ?? {
      patterns: new Set(),
      overTaint: new Set(),
      directories: new Set(),
    };
    for (const { pattern } of always.commands) {
      const entry = `${always.namespace}\x00${pattern}`;
      standing.patterns.add(entry);
      if (overTaint && hasBoundedTaintPrefix(pattern)) standing.overTaint.add(entry);
    }
    for (const directory of always.directories) standing.directories.add(directory);
    byKey.set(key, standing);
    this.standingShell.set(sessionId, byKey);
  }

  private remember(sessionId: string, key: string, answer: ChatApprovalAnswer, overTaint: boolean): void {
    const keys = this.standing.get(sessionId) ?? new Map<string, StandingApproval>();
    keys.set(key, {
      ...(answer.optionId ? { optionId: answer.optionId } : {}),
      ...(answer.value === undefined ? {} : { value: answer.value }),
      ...(overTaint || keys.get(key)?.overTaint ? { overTaint: true as const } : {}),
    });
    this.standing.set(sessionId, keys);
  }
}
