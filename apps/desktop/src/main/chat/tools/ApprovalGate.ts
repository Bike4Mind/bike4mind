import { randomUUID } from 'node:crypto';
import { sep } from 'node:path';
import type { ChatApprovalAnswer } from '@shared/chat';
import { type ChatAllowanceStore, type StoredChatAllowances, storedChatAllowancesSchema } from './chatAllowances';
import type { ApprovalAlways, ApprovalPart, PartAskKind } from './types';

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

/**
 * Whether remembered `patterns` (see ApprovalGate.allowedPatterns) cover one sub-command. Never one the
 * scan could not normalise, nor one asked for a reason the pattern was not allowed over.
 */
export function partAllowed(
  patterns: readonly AllowedPattern[],
  part: Pick<ApprovalPart, 'text' | 'coverable' | 'ask'>
): boolean {
  if (!part.coverable) return false;
  const kinds = part.ask?.kinds ?? [];
  return patterns.some(
    ({ pattern, askedOver }) => kinds.every(kind => askedOver.has(kind)) && patternMatches(pattern, part.text)
  );
}

/** A remembered shell pattern, and the reasons to ask (see PartAskKind) the card it was allowed on gave for it. */
export interface AllowedPattern {
  pattern: string;
  askedOver: ReadonlySet<string>;
}

const NOTHING_ASKED: ReadonlySet<string> = new Set();

function withinDirectory(directory: string, candidate: string): boolean {
  return candidate === directory || candidate.startsWith(directory.endsWith(sep) ? directory : directory + sep);
}

interface StandingShell {
  patterns: Set<string>;
  /** Pattern -> the reasons its part asked on the card it was allowed on. */
  askedOver: Map<string, Set<PartAskKind>>;
  directories: Set<string>;
  /** `${namespace}\x00${shape}` for each command shape (see commandShape) it allowed. */
  shapes: Set<string>;
}

function emptyShell(): StandingShell {
  return { patterns: new Set(), askedOver: new Map(), directories: new Set(), shapes: new Set() };
}

/** Splits a `${namespace}\x00${rest}` entry; the namespace never holds the separator, the rest may. */
function splitEntry(entry: string): { namespace: string; rest: string } {
  const at = entry.indexOf('\x00');
  return { namespace: entry.slice(0, at), rest: entry.slice(at + 1) };
}

export interface ApprovalRequestOptions {
  /** What a shell command's 'always' remembers, on top of the exact-call key. */
  always?: ApprovalAlways;
  /**
   * Whether an 'always' answer may be recorded as a standing approval. False on an
   * irreversible tool, where a single click must never cover a later, different call.
   */
  /** A callback rechecks whether consent may be retained when the user actually answers. */
  remember?: boolean | (() => boolean);
  /**
   * On a card that offers a choice, which of its options may be recorded as standing. An answer
   * naming any other option is honoured for this call and forgotten - that is what stops a
   * redirect, which is an instruction about one call, from ever becoming a policy.
   */
  rememberable?: readonly string[];
  /** The card asked about only some of the call's parts: an 'always' keeps their patterns, never the whole call. */
  partial?: boolean;
  /** A question card, which a new message closes via cancelQuestions rather than leaving live. */
  question?: boolean;
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
 * conversation: to the exact request, plus for a shell command the prefix patterns
 * (`git commit *`) or command shape it was derived into. With a `store`, it is kept beside the
 * conversation and survives a restart (see ready); it is never shared with another conversation
 * except one this conversation spawned (see setParent).
 */
export class ApprovalGate {
  private readonly pending = new Map<string, PendingApproval>();

  /** sessionId -> standing key -> the answer to replay. */
  private readonly standing = new Map<string, Map<string, StandingApproval>>();

  /** sessionId -> exact approval key -> the shell patterns and directories it allowed. */
  private readonly standingShell = new Map<string, Map<string, StandingShell>>();

  /** sessionId -> the session that spawned it; see setParent. */
  private readonly parents = new Map<string, string>();

  /** sessionId -> its stored allowances, read once and merged in. */
  private readonly loads = new Map<string, Promise<void>>();

  /** Sessions whose stored allowances have been merged in. */
  private readonly loaded = new Set<string>();

  /** sessionId -> its disk writes, in order. */
  private readonly writes = new Map<string, Promise<void>>();

  /** Keys revoked before the session's stored allowances were read; applied once they are. */
  private readonly revokedBeforeLoad = new Map<string, Set<string>>();

  /** Deleted conversations: nothing is read into or written for them again. Ids are never reused. */
  private readonly forgotten = new Set<string>();

  constructor(
    private readonly listener?: ApprovalGateListener,
    private readonly store?: ChatAllowanceStore,
    private readonly warn: (message: string) => void = message => console.warn(message)
  ) {}

  /**
   * Reads the stored allowances of this session and the sessions that spawned it, once each.
   * Awaited before any standing answer is looked up; never rejects (a bad record is no allowance).
   */
  async ready(sessionId: string): Promise<void> {
    await Promise.all(this.lineage(sessionId).map(id => this.load(id)));
  }

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

  /**
   * Drops a standing answer. Before the session's stored allowances are read, the revoke is held
   * and applied as they are, so it reports true: a stored allowance cannot apply before then.
   */
  revoke(sessionId: string, key: string): boolean {
    const removed = this.revokeLoaded(sessionId, key);
    if (removed) this.persist(sessionId);
    if (!this.store || this.loaded.has(sessionId) || this.forgotten.has(sessionId)) return removed;
    const held = this.revokedBeforeLoad.get(sessionId) ?? new Set<string>();
    held.add(key);
    this.revokedBeforeLoad.set(sessionId, held);
    void this.load(sessionId);
    return true;
  }

  private revokeLoaded(sessionId: string, key: string): boolean {
    const keys = this.standing.get(sessionId);
    let removed = keys?.delete(key) ?? false;
    for (const stored of keys?.keys() ?? []) {
      if (stored.startsWith(`${key}#`)) {
        keys?.delete(stored);
        removed = true;
      }
    }
    return (this.standingShell.get(sessionId)?.delete(key) ?? false) || removed;
  }

  /**
   * Whether "Allow in this chat" was given, here or in a session that spawned this one, to a
   * command of this `shape` (see commandShape) for this tool.
   */
  coversShape(sessionId: string, namespace: string, shape: string): boolean {
    const entry = `${namespace}\x00${shape}`;
    return this.lineage(sessionId).some(id =>
      [...(this.standingShell.get(id)?.values() ?? [])].some(standing => standing.shapes.has(entry))
    );
  }

  /**
   * Whether every sub-command of this script has been allowed before, here or in a session that spawned
   * this one.
   */
  coversCommands(sessionId: string, always: ApprovalAlways): boolean {
    if (always.commands.length === 0) return false;
    const own = this.allowedPatterns(sessionId, always.namespace);
    return own.length > 0 && always.commands.every(command => partAllowed(own, command));
  }

  /**
   * A spawned session runs what the sessions that started it allowed in their chats. Set at each turn's start
   * rather than read from disk: a parent can hold an allowance only after running a turn in this process.
   */
  setParent(sessionId: string, parentId: string | undefined): void {
    if (parentId && parentId !== sessionId) this.parents.set(sessionId, parentId);
    else this.parents.delete(sessionId);
  }

  /** This session and the ones that spawned it, nearest first. */
  private lineage(sessionId: string): string[] {
    const chain = [sessionId];
    for (let parent = this.parents.get(sessionId); parent && !chain.includes(parent);) {
      chain.push(parent);
      parent = this.parents.get(parent);
    }
    return chain;
  }

  /** The shell patterns "Allow in this chat" gave for one tool, in this session or one that spawned it. */
  allowedPatterns(sessionId: string, namespace: string): AllowedPattern[] {
    const prefix = `${namespace}\x00`;
    const patterns: AllowedPattern[] = [];
    for (const id of this.lineage(sessionId)) {
      for (const entry of this.standingShell.get(id)?.values() ?? []) {
        for (const stored of entry.patterns) {
          if (!stored.startsWith(prefix)) continue;
          patterns.push({
            pattern: stored.slice(prefix.length),
            askedOver: entry.askedOver.get(stored) ?? NOTHING_ASKED,
          });
        }
      }
    }
    return patterns;
  }

  /** The directories among these that the user has not said "always" to. */
  uncoveredDirectories(sessionId: string, directories: readonly string[]): string[] {
    if (directories.length === 0) return [];
    const allowedDirectories = this.lineage(sessionId).flatMap(id =>
      [...(this.standingShell.get(id)?.values() ?? [])].flatMap(entry => [...entry.directories])
    );
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
    const remember = () => (typeof options.remember === 'function' ? options.remember() : options.remember !== false);

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
          remember() &&
          !options.always?.ungranted?.length &&
          answer.decision === 'always' &&
          (!options.rememberable || (!!answer.optionId && options.rememberable.includes(answer.optionId)));
        if (keep) {
          if (!options.partial) {
            this.remember(sessionId, standingKey(key, answer.optionId), answer);
          }
          if (options.always) this.rememberShell(sessionId, key, options.always);
          this.persist(sessionId);
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

  /**
   * Deleting a conversation drops its in-flight asks and anything it had standing, on disk too.
   * Resolves once the stored record is gone.
   */
  forgetSession(sessionId: string): Promise<void> {
    this.forgotten.add(sessionId);
    this.standing.delete(sessionId);
    this.standingShell.delete(sessionId);
    this.parents.delete(sessionId);
    this.revokedBeforeLoad.delete(sessionId);
    for (const [approvalId, entry] of this.pending) {
      if (entry.sessionId === sessionId) {
        entry.settle({ decision: 'deny' }, 'conversation-deleted');
        this.pending.delete(approvalId);
      }
    }
    const store = this.store;
    if (!store) return Promise.resolve();
    return this.enqueue(sessionId, () => store.deleteChatAllowances(sessionId));
  }

  /** Drops everything in memory; what is stored stays for the next launch. */
  dispose(): void {
    for (const entry of this.pending.values()) entry.settle({ decision: 'deny' }, 'app-quit');
    this.pending.clear();
    this.standing.clear();
    this.standingShell.clear();
    this.parents.clear();
    this.loads.clear();
    this.loaded.clear();
    this.revokedBeforeLoad.clear();
  }

  private load(sessionId: string): Promise<void> {
    const store = this.store;
    if (!store || this.forgotten.has(sessionId)) return Promise.resolve();
    let pending = this.loads.get(sessionId);
    if (!pending) {
      pending = (async () => {
        let stored: unknown = null;
        try {
          stored = await store.loadChatAllowances(sessionId);
        } catch (error) {
          this.warn(`APPROVALS: could not read allowances for ${sessionId}: ${String(error)}`);
        }
        if (this.forgotten.has(sessionId)) return;
        if (stored !== null && stored !== undefined) this.merge(sessionId, stored);
        this.loaded.add(sessionId);
        const held = this.revokedBeforeLoad.get(sessionId);
        this.revokedBeforeLoad.delete(sessionId);
        if (held && [...held].map(key => this.revokeLoaded(sessionId, key)).some(Boolean)) {
          this.persist(sessionId);
        }
      })();
      this.loads.set(sessionId, pending);
    }
    return pending;
  }

  /** Adds a stored record to what is in memory; a record that does not parse adds nothing. */
  private merge(sessionId: string, stored: unknown): void {
    const parsed = storedChatAllowancesSchema.safeParse(stored);
    if (!parsed.success) {
      this.warn(`APPROVALS: ignoring malformed allowances for ${sessionId}: ${parsed.error.message}`);
      return;
    }
    const keys = this.standing.get(sessionId) ?? new Map<string, StandingApproval>();
    for (const { key, optionId, value } of parsed.data.answers) {
      if (keys.has(key)) continue;
      keys.set(key, { ...(optionId ? { optionId } : {}), ...(value === undefined ? {} : { value }) });
    }
    if (keys.size > 0) this.standing.set(sessionId, keys);
    const byKey = this.standingShell.get(sessionId) ?? new Map<string, StandingShell>();
    for (const { key, patterns, directories, shapes } of parsed.data.shell) {
      const standing = byKey.get(key) ?? emptyShell();
      for (const { namespace, pattern, askedOver } of patterns) {
        const entry = `${namespace}\x00${pattern}`;
        standing.patterns.add(entry);
        if (askedOver.length > 0) {
          standing.askedOver.set(entry, new Set([...(standing.askedOver.get(entry) ?? []), ...askedOver]));
        }
      }
      for (const directory of directories) standing.directories.add(directory);
      for (const { namespace, shape } of shapes) standing.shapes.add(`${namespace}\x00${shape}`);
      byKey.set(key, standing);
    }
    if (byKey.size > 0) this.standingShell.set(sessionId, byKey);
  }

  private snapshot(sessionId: string): StoredChatAllowances {
    return {
      version: 1,
      answers: [...(this.standing.get(sessionId) ?? [])].map(([key, { optionId, value }]) => ({
        key,
        ...(optionId ? { optionId } : {}),
        ...(value === undefined ? {} : { value }),
      })),
      shell: [...(this.standingShell.get(sessionId) ?? [])].map(([key, standing]) => ({
        key,
        patterns: [...standing.patterns].map(entry => {
          const { namespace, rest } = splitEntry(entry);
          return { namespace, pattern: rest, askedOver: [...(standing.askedOver.get(entry) ?? [])] };
        }),
        directories: [...standing.directories],
        shapes: [...standing.shapes].map(entry => {
          const { namespace, rest } = splitEntry(entry);
          return { namespace, shape: rest };
        }),
      })),
    };
  }

  /** Writes this session's allowances, after its stored ones are merged in so none is lost. */
  private persist(sessionId: string): void {
    const store = this.store;
    if (!store || this.forgotten.has(sessionId)) return;
    void this.enqueue(sessionId, async () => {
      await this.load(sessionId);
      if (this.forgotten.has(sessionId)) return;
      const record = this.snapshot(sessionId);
      if (record.answers.length === 0 && record.shell.length === 0) await store.deleteChatAllowances(sessionId);
      else await store.saveChatAllowances(sessionId, record);
    });
  }

  /** Runs one disk operation after the session's earlier ones; a failure is logged, never thrown. */
  private enqueue(sessionId: string, operation: () => Promise<void>): Promise<void> {
    const next = (this.writes.get(sessionId) ?? Promise.resolve())
      .then(operation)
      .catch(error => this.warn(`APPROVALS: could not save allowances for ${sessionId}: ${String(error)}`));
    this.writes.set(sessionId, next);
    return next;
  }

  /** Resolves once every disk write queued so far for this session has finished. */
  flush(sessionId: string): Promise<void> {
    return this.writes.get(sessionId) ?? Promise.resolve();
  }

  private rememberShell(sessionId: string, key: string, always: ApprovalAlways): void {
    const byKey = this.standingShell.get(sessionId) ?? new Map<string, StandingShell>();
    const standing = byKey.get(key) ?? emptyShell();
    if (always.shape) standing.shapes.add(`${always.namespace}\x00${always.shape}`);
    for (const { pattern, ask } of always.commands) {
      const entry = `${always.namespace}\x00${pattern}`;
      standing.patterns.add(entry);
      if (ask) {
        const over = standing.askedOver.get(entry) ?? new Set<PartAskKind>();
        for (const kind of ask.kinds) over.add(kind);
        standing.askedOver.set(entry, over);
      }
    }
    for (const directory of always.directories) standing.directories.add(directory);
    byKey.set(key, standing);
    this.standingShell.set(sessionId, byKey);
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
