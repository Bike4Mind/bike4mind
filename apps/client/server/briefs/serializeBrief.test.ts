import { describe, expect, it, vi } from 'vitest';
import { BriefSchema, PENDING_ACTION_TTL_MS } from '@bike4mind/common';
import type { IAssistantBrief } from '@bike4mind/database';
import {
  approvalStateFor,
  questionStateFor,
  serializeBrief,
  serializeBriefs,
  type PendingActionState,
} from './serializeBrief';

const NOW = new Date('2026-11-17T12:00:00Z');
const TS = NOW.getTime() - 60_000;

const storedBrief = (id: string, decisions: unknown[]) =>
  ({
    _id: { toString: () => id },
    userId: 'u1',
    status: 'ready',
    createdAt: new Date('2026-11-17T00:00:00Z'),
    updatedAt: new Date('2026-11-17T00:01:00Z'),
    composedAt: new Date('2026-11-17T00:01:00Z'),
    periodStart: new Date('2026-11-16T00:00:00Z'),
    periodEnd: new Date('2026-11-17T00:00:00Z'),
    headline: 'Done.',
    happened: [{ id: 'h1', text: 'A' }],
    handled: [],
    decisions,
    failureReason: 'secret detail',
  }) as unknown as IAssistantBrief;

describe('serializeBrief', () => {
  it('produces a body that satisfies the public contract and hides internal fields', async () => {
    const stored = storedBrief('b1', [
      { id: 'd1', text: 'Send?', approval: { questId: 'q1', sessionId: 's1', pendingActionTs: TS } },
      { id: 'd2', text: 'Ask' },
    ]);
    const deps = {
      findPendingActionStates: vi.fn().mockResolvedValue([{ questId: 'q1', pendingActionTs: TS }]),
      findQuestionStates: vi.fn().mockResolvedValue([]),
    };

    const wire = await serializeBrief(stored, NOW, deps);
    expect(BriefSchema.parse(wire)).toEqual(wire);
    expect(wire).not.toHaveProperty('userId');
    expect(wire).not.toHaveProperty('failureReason');
    expect(wire.decisions[0].approval?.state).toBe('pending');
    expect(wire.decisions[1]).toEqual({ id: 'd2', text: 'Ask' });
  });

  it('carries the email source and draft reply through to the wire', async () => {
    const source = { kind: 'email' as const, emailId: 'e1' };
    const draftReply = { to: 'sender@example.com', subject: 'Re: Renewal', body: 'Confirming.' };
    const stored = {
      _id: { toString: () => 'b2' },
      status: 'ready',
      createdAt: new Date('2026-11-17T00:00:00Z'),
      composedAt: new Date('2026-11-17T00:01:00Z'),
      periodStart: new Date('2026-11-16T00:00:00Z'),
      periodEnd: new Date('2026-11-17T00:00:00Z'),
      headline: 'Mail.',
      happened: [{ id: 'h1', text: 'Newsletter', source: { kind: 'email', emailId: 'e3' } }],
      handled: [{ id: 'k1', text: 'Receipt filed', source: { kind: 'email', emailId: 'e2' } }],
      decisions: [{ id: 'd1', text: 'Confirm the renewal', source, draftReply }],
    } as unknown as IAssistantBrief;

    const deps = { findPendingActionStates: vi.fn(), findQuestionStates: vi.fn() };

    const wire = await serializeBrief(stored, NOW, deps);
    expect(BriefSchema.parse(wire)).toEqual(wire);
    expect(wire.decisions[0]).toEqual({ id: 'd1', text: 'Confirm the renewal', source, draftReply });
    expect(wire.handled[0].source).toEqual({ kind: 'email', emailId: 'e2' });
    expect(wire.happened[0].source).toEqual({ kind: 'email', emailId: 'e3' });
  });

  it('carries follow-up refs with remindAt as ISO or null and drops the stored stamps', async () => {
    const remindAt = new Date('2026-11-20T09:00:00Z');
    const draftReply = { to: 'Sam', subject: 'Notes', body: 'Here are the notes.' };
    const stored = {
      _id: { toString: () => 'b3' },
      status: 'ready',
      createdAt: new Date('2026-11-17T00:00:00Z'),
      composedAt: new Date('2026-11-17T00:01:00Z'),
      periodStart: new Date('2026-11-17T00:00:00Z'),
      periodEnd: new Date('2026-11-17T00:00:00Z'),
      headline: 'Follow-ups.',
      happened: [],
      handled: [],
      decisions: [
        {
          id: 'fu-reminder-1',
          text: 'Remind me: call back',
          followUp: { kind: 'reminder', state: 'approved', remindAt, decidedAt: remindAt, surfacedAt: remindAt },
        },
        {
          id: 'fu-email',
          text: 'Send follow-up to Sam: Notes',
          draftReply,
          followUp: { kind: 'followUpEmail', state: 'pending', remindAt: null },
        },
      ],
    } as unknown as IAssistantBrief;

    const wire = await serializeBrief(stored, NOW, { findPendingActionStates: vi.fn(), findQuestionStates: vi.fn() });
    expect(BriefSchema.parse(wire)).toEqual(wire);
    expect(wire.decisions[0].followUp).toEqual({
      kind: 'reminder',
      state: 'approved',
      remindAt: '2026-11-20T09:00:00.000Z',
    });
    expect(wire.decisions[1]).toEqual({
      id: 'fu-email',
      text: 'Send follow-up to Sam: Notes',
      draftReply,
      followUp: { kind: 'followUpEmail', state: 'pending', remindAt: null },
    });
  });

  it('carries a delegation source through to the wire', async () => {
    const stored = {
      _id: { toString: () => 'b3' },
      status: 'ready',
      createdAt: new Date('2026-11-17T00:00:00Z'),
      composedAt: new Date('2026-11-17T00:01:00Z'),
      periodStart: new Date('2026-11-16T00:00:00Z'),
      periodEnd: new Date('2026-11-17T00:00:00Z'),
      headline: 'Delegated.',
      happened: [],
      handled: [{ id: 'x1', text: 'Summarized the report', source: { kind: 'delegation', delegationId: 'g1' } }],
      decisions: [],
    } as unknown as IAssistantBrief;

    const wire = await serializeBrief(stored);
    expect(BriefSchema.parse(wire)).toEqual(wire);
    expect(wire.handled[0].source).toEqual({ kind: 'delegation', delegationId: 'g1' });
  });

  it('carries an obligation source through to the wire', async () => {
    const stored = {
      _id: { toString: () => 'b4' },
      status: 'ready',
      createdAt: new Date('2026-11-17T00:00:00Z'),
      composedAt: new Date('2026-11-17T00:01:00Z'),
      periodStart: new Date('2026-11-16T00:00:00Z'),
      periodEnd: new Date('2026-11-17T00:00:00Z'),
      headline: 'A bill is due.',
      happened: [
        { id: 'x1', text: 'Due Nov 20: Example Utilities', source: { kind: 'obligation', obligationId: 'o1' } },
      ],
      handled: [],
      decisions: [],
    } as unknown as IAssistantBrief;

    const wire = await serializeBrief(stored);
    expect(BriefSchema.parse(wire)).toEqual(wire);
    expect(wire.happened[0].source).toEqual({ kind: 'obligation', obligationId: 'o1' });
  });

  it('serializes a composing brief with no composed time yet', async () => {
    const stored = {
      _id: { toString: () => 'b4' },
      status: 'composing',
      createdAt: new Date('2026-11-17T00:00:00Z'),
      composedAt: null,
      periodStart: new Date('2026-11-16T00:00:00Z'),
      periodEnd: new Date('2026-11-17T00:00:00Z'),
      headline: null,
      happened: [],
      handled: [],
      decisions: [],
    } as unknown as IAssistantBrief;

    expect(await serializeBrief(stored)).toMatchObject({ status: 'composing', composedAt: null });
  });

  it('looks up every cited quest once across a page of briefs, and not at all with no approvals', async () => {
    const approval = (questId: string) => ({ questId, sessionId: 's1', pendingActionTs: TS });
    const deps = { findPendingActionStates: vi.fn().mockResolvedValue([]), findQuestionStates: vi.fn() };

    const wire = await serializeBriefs(
      [
        storedBrief('b1', [{ id: 'd1', text: 'x', approval: approval('q1') }]),
        storedBrief('b2', [
          { id: 'd1', text: 'y', approval: approval('q1') },
          { id: 'd2', text: 'z', approval: approval('q2') },
        ]),
      ],
      NOW,
      deps
    );
    expect(deps.findPendingActionStates).toHaveBeenCalledTimes(1);
    expect(deps.findPendingActionStates).toHaveBeenCalledWith(['q1', 'q2']);
    expect(wire.flatMap(b => b.decisions.map(d => d.approval?.state))).toEqual(['resolved', 'resolved', 'resolved']);

    deps.findPendingActionStates.mockClear();
    await serializeBriefs([storedBrief('b3', [{ id: 'd1', text: 'Ask' }])], NOW, deps);
    expect(deps.findPendingActionStates).not.toHaveBeenCalled();
    expect(deps.findQuestionStates).not.toHaveBeenCalled();
  });

  it('reports each question with its live state from one batched lookup', async () => {
    const question = (questId: string) => ({ questId, sessionId: 's1', options: ['Yes', 'No'] });
    const deps = {
      findPendingActionStates: vi.fn(),
      findQuestionStates: vi.fn().mockResolvedValue([
        { questId: 'q1', selected: false, isLatest: true },
        { questId: 'q2', selected: false, isLatest: false },
      ]),
    };
    const wire = await serializeBrief(
      storedBrief('b1', [
        { id: 'd1', text: 'Pick', question: question('q1') },
        { id: 'd2', text: 'Pick', question: question('q1'), repliedAt: new Date(TS) },
        { id: 'd3', text: 'Pick', question: question('q2') },
      ]),
      NOW,
      deps
    );
    expect(BriefSchema.parse(wire)).toEqual(wire);
    expect(deps.findPendingActionStates).not.toHaveBeenCalled();
    expect(deps.findQuestionStates).toHaveBeenCalledWith(['q1', 'q2']);
    expect(wire.decisions.map(d => d.question?.state)).toEqual(['open', 'answered', 'superseded']);
    expect(wire.decisions[1]).not.toHaveProperty('repliedAt');
  });
});

describe('questionStateFor', () => {
  it.each([
    ['open', undefined, { selected: false, isLatest: true }],
    ['answered', new Date(TS), { selected: false, isLatest: true }],
    ['answered', undefined, { selected: true, isLatest: false }],
    ['superseded', undefined, { selected: false, isLatest: false }],
    ['superseded', undefined, undefined],
  ] as const)('is %s', (expected, repliedAt, quest) => {
    expect(questionStateFor(repliedAt, quest && { questId: 'q1', ...quest })).toBe(expected);
  });
});

describe('approvalStateFor', () => {
  const quest = (patch: Partial<PendingActionState>): PendingActionState => ({ questId: 'q1', ...patch });
  const at = (ageMs: number) => ({ pendingActionTs: NOW.getTime() - ageMs });

  it.each([
    ['the quest no longer exists', { pendingActionTs: TS }, undefined, 'resolved'],
    ['the cited action is still current', { pendingActionTs: TS }, quest({ pendingActionTs: TS }), 'pending'],
    [
      'the cited action is exactly at the TTL',
      at(PENDING_ACTION_TTL_MS),
      quest({ pendingActionTs: NOW.getTime() - PENDING_ACTION_TTL_MS }),
      'pending',
    ],
    [
      'the cited action is one ms past the TTL',
      at(PENDING_ACTION_TTL_MS + 1),
      quest({ pendingActionTs: NOW.getTime() - PENDING_ACTION_TTL_MS - 1 }),
      'lapsed',
    ],
    ['a different action is now pending', { pendingActionTs: TS }, quest({ pendingActionTs: TS + 1 }), 'replaced'],
    [
      'the cited action was approved and a newer one is now pending',
      { pendingActionTs: TS },
      quest({ pendingActionTs: TS + 1, resolution: { ts: TS, outcome: 'approved' } }),
      'approved',
    ],
    [
      'the cited action was approved',
      { pendingActionTs: TS },
      quest({ resolution: { ts: TS, outcome: 'approved' } }),
      'approved',
    ],
    [
      'the cited action was denied',
      { pendingActionTs: TS },
      quest({ resolution: { ts: TS, outcome: 'denied' } }),
      'denied',
    ],
    [
      'the cited action was taken off as expired',
      { pendingActionTs: TS },
      quest({ resolution: { ts: TS, outcome: 'lapsed' } }),
      'lapsed',
    ],
    [
      'a newer action replaced it and was then resolved',
      { pendingActionTs: TS },
      quest({ resolution: { ts: TS + 1, outcome: 'approved' } }),
      'replaced',
    ],
    ['it was cleared with no recorded outcome', { pendingActionTs: TS }, quest({}), 'resolved'],
    ['it was cleared with no recorded outcome and is past the TTL', at(PENDING_ACTION_TTL_MS + 1), quest({}), 'lapsed'],
  ] as const)('%s', (_label, ref, state, expected) => {
    expect(approvalStateFor(ref, state, NOW)).toBe(expected);
  });
});
