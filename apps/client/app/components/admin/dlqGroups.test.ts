import { beforeEach, describe, expect, it } from 'vitest';
import type { DlqRecommendation } from '@bike4mind/common';
import {
  defaultDiscardReason,
  DLQ_BURST_QUIET_MS,
  groupDlqRows,
  parseDiscardReason,
  reasonForRecommendation,
  rememberDiscardReason,
  toDlqRows,
} from './dlqGroups';

const NOW = Date.UTC(2026, 10, 18, 12);
const MINUTE = 60_000;
const OBSOLETE: DlqRecommendation = { action: 'discard', label: 'Job obsolete, discard', basis: 'Superseded.' };
const INSPECT: DlqRecommendation = { action: 'inspect', label: 'Inspect first', basis: 'Unclear.' };

const row = (messageId: string, signature: string | undefined, minutesAgo: number, extra = {}) => ({
  queueLabel: 'cron',
  messageId,
  body: '{}',
  entity: null,
  sentTimestamp: String(NOW - minutesAgo * MINUTE),
  ...(signature !== undefined && { failureSignature: signature }),
  failure: { errorMessage: `failure ${signature}`, category: 'unknown' as const, source: 'attributes' as const },
  recommendation: OBSOLETE,
  ...extra,
});

const rows = (...messages: ReturnType<typeof row>[]) =>
  toDlqRows(messages, [
    {
      label: 'cron',
      displayName: 'Spend Monitor',
      application: 'Ops',
      owner: 'Platform ops',
      approximateMessageCount: 3,
      approximateNotVisibleCount: 0,
    },
  ]);

describe('groupDlqRows', () => {
  it('groups by queue and signature, largest first, with first and last seen', () => {
    const groups = groupDlqRows(
      rows(row('a1', 'aaaa', 120), row('b1', 'bbbb', 30), row('a2', 'aaaa', 60), row('a3', 'aaaa', 90)),
      NOW
    );
    expect(groups.map(group => [group.id, group.messageIds])).toEqual([
      ['cron:aaaa', ['a1', 'a2', 'a3']],
      ['cron:bbbb', ['b1']],
    ]);
    expect(groups[0]).toMatchObject({
      feature: 'Platform ops',
      firstSentMs: NOW - 120 * MINUTE,
      lastSentMs: NOW - 60 * MINUTE,
      stillArriving: false,
      recommendation: OBSOLETE,
      discardable: true,
    });
  });

  it('marks a group still arriving while its newest message is recent', () => {
    const [group] = groupDlqRows(rows(row('a1', 'aaaa', DLQ_BURST_QUIET_MS / MINUTE - 1)), NOW);
    expect(group.stillArriving).toBe(true);
  });

  it('keeps each message without a usable signature on its own, and not discardable', () => {
    const groups = groupDlqRows(rows(row('u1', 'unavailable', 5), row('u2', undefined, 6)), NOW);
    expect(groups.map(group => [group.messageIds, group.discardable])).toEqual([
      [['u1'], false],
      [['u2'], false],
    ]);
  });

  it('drops the recommendation when the group does not share one', () => {
    const [group] = groupDlqRows(rows(row('a1', 'aaaa', 5), row('a2', 'aaaa', 6, { recommendation: INSPECT })), NOW);
    expect(group.recommendation).toBeNull();
  });
});

describe('discard reason defaults', () => {
  beforeEach(() => sessionStorage.clear());

  it('maps a discard recommendation to a reason and ignores the others', () => {
    expect(reasonForRecommendation(OBSOLETE)).toEqual({ preset: 'Job obsolete', note: '' });
    expect(
      reasonForRecommendation({ action: 'discard', label: 'Discard', basis: '3 recorded replay attempts.' })
    ).toEqual({ preset: null, note: '3 recorded replay attempts.' });
    expect(reasonForRecommendation(INSPECT)).toBeNull();
  });

  it('prefers a shared recommendation, then the last reason this session, then nothing', () => {
    expect(defaultDiscardReason([INSPECT])).toEqual({ preset: null, note: '' });
    rememberDiscardReason('Fixed with no replay needed: deployed the fix');
    expect(defaultDiscardReason([INSPECT, OBSOLETE])).toEqual({
      preset: 'Fixed with no replay needed',
      note: 'deployed the fix',
    });
    expect(defaultDiscardReason([OBSOLETE, OBSOLETE])).toEqual({ preset: 'Job obsolete', note: '' });
  });

  it('splits a composed reason back into its preset and note', () => {
    expect(parseDiscardReason('Bad payload')).toEqual({ preset: 'Bad payload', note: '' });
    expect(parseDiscardReason('Other: cleanup')).toEqual({ preset: 'Other', note: 'cleanup' });
    expect(parseDiscardReason('free text')).toEqual({ preset: null, note: 'free text' });
  });
});
