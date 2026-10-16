import { randomUUID } from 'node:crypto';
import type { ChatStreamEvent } from '@shared/chat';
import {
  EDIT_TOOLS,
  MAX_DURATION_MS,
  clampDuration,
  isActivityId,
  toolCategory,
  type ActivityEvent,
} from './activityContract';
import type { RepositoryName } from './repository';
import { mergeTotals, toReplyUsage, usageTotals, type UsageTotals } from './replyUsage';

/** Replies whose reported usage is remembered, so a resumed reply adds only what is new. */
const MAX_REPORTED_REPLIES = 200;

export interface ActivityRecorderDeps {
  /** False while consent is off or no key is set; nothing is derived or looked up then. */
  enabled(): boolean;
  record(events: ActivityEvent[]): void;
  /** The repository a conversation works in, or null. */
  repositoryFor(sessionId: string): Promise<RepositoryName | null>;
  /** The model a conversation is on, or null. Asked when a reply starts. */
  modelFor(sessionId: string): Promise<string | null>;
  now?(): number;
  newId?(): string;
}

interface OpenTurn {
  sessionId: string;
  messageId: string;
  startedAt: number;
  edited: boolean;
  model: Promise<string | null>;
  /** The latest running total the stream reported, kept for a reply that ends in an error. */
  usage: UsageTotals | null;
}

/**
 * Turns the chat stream into Fleet activity: one `session` event per reply with its duration,
 * the model and the tokens and credits it used, one `tool` event per tool call by category, and
 * one `repository` event per reply in a project whose origin remote names a repository.
 *
 * Metadata only. A reply's text, a tool's name, input and output, and every path stay here.
 */
export class ActivityRecorder {
  private readonly turns = new Map<string, OpenTurn>();
  private readonly reported = new Map<string, UsageTotals>();

  constructor(private readonly deps: ActivityRecorderDeps) {}

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  private id(): string {
    return this.deps.newId?.() ?? randomUUID();
  }

  observe(event: ChatStreamEvent): void {
    if (!this.deps.enabled()) {
      this.turns.clear();
      return;
    }
    if (!isActivityId(event.sessionId)) return;

    if (event.type === 'start') {
      this.prune();
      this.turns.set(event.messageId, {
        sessionId: event.sessionId,
        messageId: event.messageId,
        startedAt: this.now(),
        edited: false,
        model: this.deps.modelFor(event.sessionId).catch(() => null),
        usage: null,
      });
      return;
    }

    if (event.type === 'usage') {
      const turn = this.turns.get(event.messageId);
      if (turn) turn.usage = usageTotals(event.usage);
      return;
    }

    if (event.type === 'tool-end') {
      const { call } = event;
      if (call.status === 'done' && EDIT_TOOLS.has(call.name)) {
        const turn = this.turns.get(event.messageId);
        if (turn) turn.edited = true;
      }
      if (call.startedAt === undefined || call.endedAt === undefined || call.status === 'denied') return;
      this.deps.record([
        {
          eventId: this.id(),
          occurredAt: new Date(call.startedAt).toISOString(),
          durationMs: clampDuration(call.endedAt - call.startedAt),
          type: 'tool',
          sessionId: event.sessionId,
          tool: { type: toolCategory(call.name) },
        },
      ]);
      return;
    }

    if (event.type === 'done' || event.type === 'error') {
      const turn = this.turns.get(event.messageId);
      if (!turn) return;
      this.turns.delete(event.messageId);
      const final = event.type === 'done' ? event.usage : undefined;
      void this.closeTurn(turn, final ? usageTotals(final) : turn.usage);
    }
  }

  private async closeTurn(turn: OpenTurn, totals: UsageTotals | null): Promise<void> {
    const occurredAt = new Date(turn.startedAt).toISOString();
    const durationMs = clampDuration(this.now() - turn.startedAt);
    const before = this.reported.get(turn.messageId);
    const usage = totals ? toReplyUsage(await turn.model, totals, before) : null;
    if (totals) this.remember(turn.messageId, before ? mergeTotals(before, totals) : totals);
    const events: ActivityEvent[] = [
      {
        eventId: this.id(),
        occurredAt,
        durationMs,
        type: 'session',
        sessionId: turn.sessionId,
        ...(usage ? { usage } : {}),
      },
    ];
    const repository = await this.deps.repositoryFor(turn.sessionId).catch(() => null);
    if (repository) {
      events.push({
        eventId: this.id(),
        occurredAt,
        durationMs,
        type: 'repository',
        sessionId: turn.sessionId,
        repository: { ...repository, action: turn.edited ? 'edit' : 'view' },
      });
    }
    if (this.deps.enabled()) this.deps.record(events);
  }

  private remember(messageId: string, totals: UsageTotals): void {
    this.reported.delete(messageId);
    this.reported.set(messageId, totals);
    for (const oldest of this.reported.keys()) {
      if (this.reported.size <= MAX_REPORTED_REPLIES) break;
      this.reported.delete(oldest);
    }
  }

  /** A reply that never reported an end must not hold its entry forever. */
  private prune(): void {
    const cutoff = this.now() - MAX_DURATION_MS;
    for (const [messageId, turn] of this.turns) {
      if (turn.startedAt < cutoff) this.turns.delete(messageId);
    }
  }
}
