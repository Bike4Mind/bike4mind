import {
  QUEST_OUTCOME_ERROR_CODES,
  type MessageDataToClient,
  type QuestOutcomeErrorCode,
  type SessionTurnSettledEvent,
  type SessionTurnSlotEvent,
  type SessionTurnStreamEvent,
} from '@bike4mind/common';
import type { ClientFrameSender } from '@bike4mind/services/llm';
import type { z } from 'zod';

/**
 * Turns the websocket frames of one turn into the session-turns SSE events (turnsRoute.ts).
 *
 * A `streamed_chat_completion` frame carries the ACCUMULATED reply slots, not deltas, and the
 * process can reset or rebuild a slot mid-turn (a provider retry, a rapid-reply handoff, the final
 * save stripping narrated tool calls). So each slot's last text is remembered: new text that extends
 * it goes out as the suffix (`delta`), anything else as the whole slot (`replace`). Applying the
 * events in order always reproduces the server's slots, whatever the server did to them.
 */

/** The slice of a quest the differ reads, from a websocket frame or from the stored quest. */
export type QuestSnapshot = {
  id: string;
  status?: string | null;
  reply?: string | null;
  replies?: readonly string[] | null;
  creditsUsed?: number | null;
  errorCode?: string | null;
};

export type TerminalQuestStatus = SessionTurnSettledEvent['status'];

export function isTerminalQuestStatus(status: string | null | undefined): status is TerminalQuestStatus {
  return status === 'done' || status === 'stopped';
}

function isQuestOutcomeErrorCode(code: string | null | undefined): code is QuestOutcomeErrorCode {
  return (QUEST_OUTCOME_ERROR_CODES as readonly string[]).includes(code ?? '');
}

/** `replies` when the process has filled any slot, else `reply` as the only slot (an error-only settle). */
function slotsOf(snapshot: QuestSnapshot): readonly string[] {
  if (snapshot.replies && snapshot.replies.length > 0) return snapshot.replies;
  return snapshot.reply ? [snapshot.reply] : [];
}

export class TurnReplyDiffer {
  private lastSlots: string[] = [];
  private settled = false;

  constructor(private readonly questId: string) {}

  get isSettled(): boolean {
    return this.settled;
  }

  /** Slot events for a mid-turn snapshot. Nothing for another quest or once the turn has settled. */
  observe(snapshot: QuestSnapshot): SessionTurnSlotEvent[] {
    if (snapshot.id !== this.questId || this.settled) return [];
    const slots = slotsOf(snapshot);
    const events: SessionTurnSlotEvent[] = [];
    const slotCount = Math.max(slots.length, this.lastSlots.length);
    for (let slot = 0; slot < slotCount; slot++) {
      const previous = this.lastSlots[slot] ?? '';
      const next = slots[slot] ?? '';
      if (next === previous) continue;
      events.push(
        next.startsWith(previous)
          ? { type: 'delta', questId: this.questId, slot, text: next.slice(previous.length) }
          : { type: 'replace', questId: this.questId, slot, text: next }
      );
    }
    this.lastSlots = [...slots];
    return events;
  }

  /**
   * The closing events from a terminal snapshot (the stored quest, which alone carries `errorCode`):
   * any slot change still unsent, then `settled`. Nothing when the snapshot is not terminal or the
   * turn already settled, so it is safe to call from both a terminal frame and the end of the run.
   */
  settle(snapshot: QuestSnapshot): SessionTurnStreamEvent[] {
    if (snapshot.id !== this.questId || this.settled || !isTerminalQuestStatus(snapshot.status)) return [];
    const events: SessionTurnStreamEvent[] = this.observe(snapshot);
    this.settled = true;
    events.push({
      type: 'settled',
      questId: this.questId,
      status: snapshot.status,
      ...(typeof snapshot.creditsUsed === 'number' ? { creditsUsed: snapshot.creditsUsed } : {}),
      ...(isQuestOutcomeErrorCode(snapshot.errorCode) ? { errorCode: snapshot.errorCode } : {}),
    });
    return events;
  }
}

/**
 * A frame sender that always forwards to `forward` (so the web app and other devices keep their
 * live websocket frames) and hands this quest's `streamed_chat_completion` snapshots to `onFrame`.
 * `onFrame` runs after the forward is started and must not throw; the forward's own result is
 * returned unchanged, so the process sees the websocket send exactly as it would without the tee.
 */
export function createTurnFrameTee({
  questId,
  forward,
  onFrame,
}: {
  questId: string;
  forward: ClientFrameSender;
  onFrame: (snapshot: QuestSnapshot) => void;
}): ClientFrameSender {
  return {
    sendToClient(userId: string, endpoint: string, action: z.infer<typeof MessageDataToClient>) {
      const forwarded = forward.sendToClient(userId, endpoint, action);
      if (action.action === 'streamed_chat_completion' && action.quest?.id === questId) {
        onFrame({ ...action.quest, id: questId });
      }
      return forwarded;
    },
  };
}
