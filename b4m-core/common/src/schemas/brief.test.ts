import { describe, it, expect } from 'vitest';
import {
  BRIEF_LIMITS,
  BriefDecisionEditSchema,
  BriefDecisionResolveSchema,
  BriefDecisionSchema,
  BriefFollowUpRequestSchema,
  BriefItemSchema,
} from './brief';

const draft = { to: 'sender@example.com', subject: 'Re: Renewal', body: 'Confirming the date.' };

describe('BriefDecisionSchema draftReply', () => {
  it('rejects a recipient over the cap', () => {
    const to = 'a'.repeat(BRIEF_LIMITS.draftTo + 1);
    expect(BriefDecisionSchema.safeParse({ id: 'd1', text: 't', draftReply: { ...draft, to } }).success).toBe(false);
  });

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

  it('accepts a delegation source and rejects one missing its id', () => {
    const source = { kind: 'delegation', delegationId: 'g1' };
    expect(BriefItemSchema.parse({ id: 'x1', text: 't', source }).source).toEqual(source);
    expect(
      BriefItemSchema.safeParse({ id: 'x1', text: 't', source: { kind: 'delegation', emailId: 'e1' } }).success
    ).toBe(false);
  });
});

describe('BriefDecisionSchema followUp', () => {
  it('accepts a reminder with a due instant and a legacy decision without followUp', () => {
    const reminder = {
      id: 'fu-reminder-1',
      text: 'Remind me: call back',
      followUp: { kind: 'reminder', state: 'pending', remindAt: '2026-11-20T09:00:00.000Z' },
    };
    expect(BriefDecisionSchema.safeParse(reminder).success).toBe(true);
    expect(BriefDecisionSchema.safeParse({ id: 'd1', text: 'Legacy' }).success).toBe(true);
  });

  it('rejects an unknown follow-up kind or state', () => {
    const base = { id: 'fu', text: 'x' };
    expect(
      BriefDecisionSchema.safeParse({ ...base, followUp: { kind: 'call', state: 'pending', remindAt: null } }).success
    ).toBe(false);
    expect(
      BriefDecisionSchema.safeParse({ ...base, followUp: { kind: 'reminder', state: 'sent', remindAt: null } }).success
    ).toBe(false);
  });
});

describe('BriefFollowUpRequestSchema', () => {
  it('accepts a transcript with or without a valid zone', () => {
    expect(BriefFollowUpRequestSchema.safeParse({ transcript: 'Email Sam the notes' }).success).toBe(true);
    expect(BriefFollowUpRequestSchema.safeParse({ transcript: 'x', timeZone: 'America/New_York' }).success).toBe(true);
  });

  it('rejects an empty, blank or oversize transcript and an unknown zone', () => {
    expect(BriefFollowUpRequestSchema.safeParse({ transcript: '' }).success).toBe(false);
    expect(BriefFollowUpRequestSchema.safeParse({ transcript: ' \n\t ' }).success).toBe(false);
    expect(
      BriefFollowUpRequestSchema.safeParse({ transcript: 'a'.repeat(BRIEF_LIMITS.followUpTranscript + 1) }).success
    ).toBe(false);
    expect(
      BriefFollowUpRequestSchema.safeParse({ transcript: 'a'.repeat(BRIEF_LIMITS.followUpTranscript) }).success
    ).toBe(true);
    expect(BriefFollowUpRequestSchema.safeParse({ transcript: 'x', timeZone: 'Mars/Olympus' }).success).toBe(false);
  });
});

describe('BriefDecisionEditSchema', () => {
  it('stores the trimmed recipient it validated', () => {
    const parsed = BriefDecisionEditSchema.parse({ draftReply: { to: ' sam@example.com ' } });
    expect(parsed.draftReply?.to).toBe('sam@example.com');
  });

  it('accepts a single field', () => {
    expect(BriefDecisionEditSchema.safeParse({ text: 'Call Sam' }).success).toBe(true);
    expect(BriefDecisionEditSchema.safeParse({ draftReply: { to: 'sam@example.com' } }).success).toBe(true);
    expect(BriefDecisionEditSchema.safeParse({ remindAt: '2026-11-20T09:00:00Z' }).success).toBe(true);
  });

  it('rejects an empty body, an empty draft, a blank text, an empty draft field and a non-ISO remindAt', () => {
    expect(BriefDecisionEditSchema.safeParse({}).success).toBe(false);
    expect(BriefDecisionEditSchema.safeParse({ draftReply: {} }).success).toBe(false);
    expect(BriefDecisionEditSchema.safeParse({ text: '   ' }).success).toBe(false);
    expect(BriefDecisionEditSchema.safeParse({ draftReply: { body: '' } }).success).toBe(false);
    expect(BriefDecisionEditSchema.safeParse({ remindAt: 'tomorrow' }).success).toBe(false);
  });
});

describe('BriefDecisionResolveSchema', () => {
  it('accepts approve and dismiss only', () => {
    expect(BriefDecisionResolveSchema.safeParse({ outcome: 'approve' }).success).toBe(true);
    expect(BriefDecisionResolveSchema.safeParse({ outcome: 'dismiss' }).success).toBe(true);
    expect(BriefDecisionResolveSchema.safeParse({ outcome: 'send' }).success).toBe(false);
  });
});
