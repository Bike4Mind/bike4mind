import type { DlqRecommendation } from '@bike4mind/common';
import {
  DLQ_SIGNATURE_UNAVAILABLE,
  type DlqListedMessage,
  type DlqQueueInfo,
} from '@client/app/hooks/data/dlqManagement';
import { ADMIN_REASON_PRESETS, EMPTY_ADMIN_REASON, type AdminReasonDraft } from './shared/adminReason';

/** The area a queue belongs to; overlay-contributed queues have no owner and stand alone. */
export const queueFeature = (queue: DlqQueueInfo | undefined, queueLabel: string): string =>
  queue?.owner ?? queue?.displayName ?? queueLabel;

export type DlqRow = DlqListedMessage & { feature: string; queue: DlqQueueInfo | undefined };

export function toDlqRows(messages: readonly DlqListedMessage[], queues: readonly DlqQueueInfo[]): DlqRow[] {
  const queueByLabel = new Map(queues.map(queue => [queue.label, queue]));
  return messages.map(message => {
    const queue = queueByLabel.get(message.queueLabel);
    return { ...message, queue, feature: queueFeature(queue, message.queueLabel) };
  });
}

// A group whose newest message is younger than this is treated as still arriving.
export const DLQ_BURST_QUIET_MS = 15 * 60_000;

export type DlqGroup = {
  /** `${queueLabel}:${signature}`, unique on the page. */
  id: string;
  queueLabel: string;
  queue: DlqQueueInfo | undefined;
  feature: string;
  signature: string;
  /** Shown for the group: the newest message's failure. */
  failure: DlqListedMessage['failure'];
  messageIds: string[];
  firstSentMs: number | null;
  lastSentMs: number | null;
  stillArriving: boolean;
  /** The shared recommendation when every message in the group has the same one; otherwise null. */
  recommendation: DlqRecommendation | null;
  /** False when the failure could not be looked up or the server predates signatures: no group action. */
  discardable: boolean;
};

const groupSignature = (row: DlqListedMessage) => row.failureSignature ?? DLQ_SIGNATURE_UNAVAILABLE;

/**
 * Groups the listed messages by queue and failure signature, largest group first. A row whose signature is
 * unavailable gets a group of its own, so it is never acted on together with others.
 */
export function groupDlqRows(rows: readonly DlqRow[], now = Date.now()): DlqGroup[] {
  const byKey = new Map<string, DlqRow[]>();
  for (const row of rows) {
    const signature = groupSignature(row);
    const key =
      signature === DLQ_SIGNATURE_UNAVAILABLE
        ? `${row.queueLabel}:${signature}:${row.messageId}`
        : `${row.queueLabel}:${signature}`;
    const members = byKey.get(key);
    if (members) members.push(row);
    else byKey.set(key, [row]);
  }
  const groups = [...byKey].map(([id, members]): DlqGroup => {
    const sent = members.map(row => Number(row.sentTimestamp)).filter(Number.isFinite);
    const newest = [...members].sort((a, b) => Number(b.sentTimestamp ?? 0) - Number(a.sentTimestamp ?? 0))[0];
    const lastSentMs = sent.length ? Math.max(...sent) : null;
    const first = members[0].recommendation;
    const shared = members.every(
      row => row.recommendation?.action === first?.action && row.recommendation?.label === first?.label
    );
    const signature = groupSignature(newest);
    return {
      id,
      queueLabel: newest.queueLabel,
      queue: newest.queue,
      feature: newest.feature,
      signature,
      failure: newest.failure,
      messageIds: members.map(row => row.messageId),
      firstSentMs: sent.length ? Math.min(...sent) : null,
      lastSentMs,
      stillArriving: lastSentMs !== null && now - lastSentMs < DLQ_BURST_QUIET_MS,
      recommendation: shared && first ? first : null,
      discardable: signature !== DLQ_SIGNATURE_UNAVAILABLE,
    };
  });
  return groups.sort((a, b) => b.messageIds.length - a.messageIds.length || (b.lastSentMs ?? 0) - (a.lastSentMs ?? 0));
}

const DISCARD_PRESETS: readonly string[] = ADMIN_REASON_PRESETS.dlqDiscard;
// Must match PRESET_SEPARATOR in shared/adminReason.ts, which composes `${preset}: ${note}`.
const PRESET_SEPARATOR = ': ';
const LAST_REASON_KEY = 'b4m.admin.dlqDiscardReason';

/** The discard reason a recommendation implies, when it recommends discarding. */
export function reasonForRecommendation(recommendation: DlqRecommendation | null | undefined): AdminReasonDraft | null {
  if (recommendation?.action !== 'discard') return null;
  if (/obsolete/i.test(recommendation.label)) return { preset: 'Job obsolete', note: '' };
  return { preset: null, note: recommendation.basis };
}

/** Splits a composed reason back into the preset and note the dialog shows. */
export function parseDiscardReason(reason: string): AdminReasonDraft {
  const preset = DISCARD_PRESETS.find(
    candidate => reason === candidate || reason.startsWith(`${candidate}${PRESET_SEPARATOR}`)
  );
  if (!preset) return { preset: null, note: reason };
  return { preset, note: reason.slice(preset.length + PRESET_SEPARATOR.length) };
}

// Session storage can be unavailable (private windows, blocked site data); the reason is only a convenience.
export function rememberDiscardReason(reason: string): void {
  try {
    sessionStorage.setItem(LAST_REASON_KEY, reason);
  } catch {
    // Nothing to remember.
  }
}

function lastDiscardReason(): AdminReasonDraft | null {
  try {
    const reason = sessionStorage.getItem(LAST_REASON_KEY);
    return reason ? parseDiscardReason(reason) : null;
  } catch {
    return null;
  }
}

/** The recommendation's reason when every selected message shares one, else the last reason this session. */
export function defaultDiscardReason(
  recommendations: readonly (DlqRecommendation | null | undefined)[]
): AdminReasonDraft {
  const implied = recommendations.map(reasonForRecommendation);
  const first = implied[0];
  const shared =
    first && implied.every(reason => reason?.preset === first.preset && reason?.note === first.note) ? first : null;
  return shared ?? lastDiscardReason() ?? EMPTY_ADMIN_REASON;
}
