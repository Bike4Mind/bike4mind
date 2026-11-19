import { describe, expect, it } from 'vitest';
import { BriefSchema } from '@bike4mind/common';
import type { IAssistantBrief } from '@bike4mind/database';
import { serializeBrief } from './serializeBrief';

describe('serializeBrief', () => {
  it('produces a body that satisfies the public contract and hides internal fields', () => {
    const stored = {
      _id: { toString: () => 'b1' },
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
      decisions: [
        { id: 'd1', text: 'Send?', approval: { questId: 'q1', sessionId: 's1', pendingActionTs: 5 } },
        { id: 'd2', text: 'Ask' },
      ],
      failureReason: 'secret detail',
    } as unknown as IAssistantBrief;

    const wire = serializeBrief(stored);
    expect(BriefSchema.parse(wire)).toEqual(wire);
    expect(wire).not.toHaveProperty('userId');
    expect(wire).not.toHaveProperty('failureReason');
    expect(wire.decisions[1]).toEqual({ id: 'd2', text: 'Ask' });
  });

  it('carries the email source and draft reply through to the wire', () => {
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

    const wire = serializeBrief(stored);
    expect(BriefSchema.parse(wire)).toEqual(wire);
    expect(wire.decisions[0]).toEqual({ id: 'd1', text: 'Confirm the renewal', source, draftReply });
    expect(wire.handled[0].source).toEqual({ kind: 'email', emailId: 'e2' });
    expect(wire.happened[0].source).toEqual({ kind: 'email', emailId: 'e3' });
  });
});
