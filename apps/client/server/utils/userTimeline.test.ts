import { describe, expect, it, vi } from 'vitest';
import { Types } from 'mongoose';
import type { UserTimelineEntry } from '@bike4mind/common';

vi.mock('@bike4mind/database', () => ({
  adminAuditLogRepository: {},
  CREDIT_BALANCE_EVENT_TYPES: ['purchase'],
  CreditTransaction: {},
  Session: {},
  UserApiKeyAuditLog: {},
  UserAuthAuditLogModel: {},
  userRepository: {},
  organizationRepository: {},
  creditTransactionRepository: {},
}));

import { mergeTimelinePages, notebookIdClauses } from './userTimeline';

const entry = (id: string, at: string): UserTimelineEntry => ({
  type: 'usage',
  id,
  at: new Date(at),
  summary: id,
  notebookId: id,
});

describe('mergeTimelinePages', () => {
  it('orders newest first, breaks time ties by id descending, and cuts at the limit', () => {
    const result = mergeTimelinePages(
      [
        { entries: [entry('a1', '2026-10-20T10:00:00Z'), entry('a2', '2026-10-20T08:00:00Z')], hasMore: false },
        { entries: [entry('b1', '2026-10-20T10:00:00Z'), entry('b2', '2026-10-20T09:00:00Z')], hasMore: false },
      ],
      3
    );
    expect(result.entries.map(e => e.id)).toEqual(['b1', 'a1', 'b2']);
    expect(result.nextCursor).toEqual({ occurredAt: new Date('2026-10-20T09:00:00Z'), id: 'b2' });
  });

  it('has no next page when every source fits and none has more', () => {
    const result = mergeTimelinePages([{ entries: [entry('a1', '2026-10-20T10:00:00Z')], hasMore: false }], 5);
    expect(result.nextCursor).toBeNull();
  });

  it('keeps paging when a source says it has more, even on a short page', () => {
    const result = mergeTimelinePages([{ entries: [entry('a1', '2026-10-20T10:00:00Z')], hasMore: true }], 5);
    expect(result.nextCursor).toEqual({ occurredAt: new Date('2026-10-20T10:00:00Z'), id: 'a1' });
  });

  it('returns an empty page with no cursor', () => {
    expect(mergeTimelinePages([], 5)).toEqual({ entries: [], nextCursor: null });
  });
});

describe('notebookIdClauses', () => {
  const second = 1_790_000_000;
  const idAt = (seconds: number) => Types.ObjectId.createFromTime(seconds).toString();

  it('excludes the cursor second when the cursor has milliseconds (no tie is possible)', () => {
    const [clause] = notebookIdClauses({ occurredAt: new Date(second * 1000 + 500), id: 'c'.repeat(24) }, {});
    expect(JSON.parse(JSON.stringify(clause))).toEqual({ _id: { $lt: idAt(second + 1) } });
  });

  it('breaks a tie on a whole-second cursor by id when the id is in the same second', () => {
    const cursorId = Types.ObjectId.createFromTime(second).toString().replace(/.$/, 'f');
    const [clause] = notebookIdClauses({ occurredAt: new Date(second * 1000), id: cursorId }, {});
    expect(JSON.parse(JSON.stringify(clause))).toEqual({
      $or: [{ _id: { $lt: idAt(second) } }, { _id: { $gte: idAt(second), $lt: cursorId } }],
    });
  });

  it('caps the tie at the cursor second when the cursor id was minted later', () => {
    const [clause] = notebookIdClauses({ occurredAt: new Date(second * 1000), id: idAt(second + 5) }, {});
    expect(JSON.parse(JSON.stringify(clause))).toEqual({
      $or: [{ _id: { $lt: idAt(second) } }, { _id: { $gte: idAt(second), $lt: idAt(second + 1) } }],
    });
  });

  it('turns an inclusive range into _id bounds', () => {
    const clauses = notebookIdClauses(undefined, {
      from: new Date(second * 1000 + 1),
      to: new Date(second * 1000 + 999),
    });
    expect(JSON.parse(JSON.stringify(clauses))).toEqual([
      { _id: { $gte: idAt(second + 1) } },
      { _id: { $lt: idAt(second + 1) } },
    ]);
  });
});
