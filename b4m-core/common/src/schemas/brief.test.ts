import { describe, it, expect } from 'vitest';
import { BRIEF_LIMITS, BriefDecisionSchema, BriefItemSchema } from './brief';

const draft = { to: 'sender@example.com', subject: 'Re: Renewal', body: 'Confirming the date.' };

describe('BriefDecisionSchema draftReply', () => {
  it('accepts an email decision with a draft and a source', () => {
    const parsed = BriefDecisionSchema.parse({
      id: 'd1',
      text: 'Confirm the renewal date',
      source: { kind: 'email', emailId: 'e1' },
      draftReply: draft,
    });
    expect(parsed.draftReply).toEqual(draft);
    expect(parsed.source).toEqual({ kind: 'email', emailId: 'e1' });
  });

  it('accepts a decision without a draft', () => {
    expect(BriefDecisionSchema.safeParse({ id: 'd1', text: 'Approve the deploy' }).success).toBe(true);
  });

  it('rejects a draft body over the cap', () => {
    const body = 'x'.repeat(BRIEF_LIMITS.draftBody + 1);
    expect(BriefDecisionSchema.safeParse({ id: 'd1', text: 't', draftReply: { ...draft, body } }).success).toBe(false);
  });

  it('rejects a draft subject over the cap', () => {
    const subject = 'x'.repeat(BRIEF_LIMITS.draftSubject + 1);
    expect(BriefDecisionSchema.safeParse({ id: 'd1', text: 't', draftReply: { ...draft, subject } }).success).toBe(
      false
    );
  });

  it('rejects an empty draft body', () => {
    expect(BriefDecisionSchema.safeParse({ id: 'd1', text: 't', draftReply: { ...draft, body: '' } }).success).toBe(
      false
    );
  });
});

describe('BriefItemSchema source', () => {
  it('rejects an unknown source kind', () => {
    expect(BriefItemSchema.safeParse({ id: 'h1', text: 't', source: { kind: 'slack', emailId: 'e1' } }).success).toBe(
      false
    );
  });
});
