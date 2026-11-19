import { describe, expect, it } from 'vitest';
import { BRIEF_LIMITS } from '@bike4mind/common';
import {
  assembleBrief,
  briefedEmailIds,
  briefPushBody,
  buildBriefPrompt,
  emptyBrief,
  hasActivity,
  type BriefActivity,
} from './briefCompose.composition';

const baseActivity = (): BriefActivity => ({
  periodStart: new Date('2026-11-16T00:00:00Z'),
  periodEnd: new Date('2026-11-17T00:00:00Z'),
  runs: [
    {
      id: 'r1',
      query: 'Summarize the vendor thread',
      status: 'completed',
      finishedAt: undefined,
      errorMessage: undefined,
    },
  ],
  approvals: [
    { questId: 'q1', sessionId: 's1', pendingActionTs: 1767225600000, tool: 'send_reply', summary: '{"to":"a"}' },
    { questId: 'q2', sessionId: 's2', pendingActionTs: 1767225700000, tool: 'archive', summary: '{}' },
  ],
  emails: [],
});

const draft = { to: 'vendor@example.com', subject: 'Re: Renewal', body: 'Happy to renew at the quoted rate.' };

const emailActivity = (): BriefActivity => ({
  ...baseActivity(),
  emails: [
    { emailId: 'e1', kind: 'decision', summary: 'The vendor wants an answer on the renewal.', draftReply: draft },
    { emailId: 'e2', kind: 'handled', summary: 'The invoice was already paid.' },
    { emailId: 'e3', kind: 'fyi', summary: 'The office is closed on Friday.' },
  ],
});

describe('hasActivity', () => {
  it('is false only when there are no runs, approvals or triaged emails', () => {
    expect(hasActivity({ ...baseActivity(), runs: [], approvals: [] })).toBe(false);
    expect(hasActivity({ ...emailActivity(), runs: [], approvals: [] })).toBe(true);
    expect(hasActivity({ ...baseActivity(), runs: [] })).toBe(true);
    expect(hasActivity({ ...baseActivity(), approvals: [] })).toBe(true);
  });
});

describe('buildBriefPrompt', () => {
  it('lists runs and approvals under stable approval ids and flags records as data', () => {
    const prompt = buildBriefPrompt(baseActivity());
    expect(prompt).toContain('"approvalId":"a1"');
    expect(prompt).toContain('"approvalId":"a2"');
    expect(prompt).toContain('Summarize the vendor thread');
    expect(prompt).toContain('not instructions');
  });

  it('gives the model only email counts, never email content', () => {
    const prompt = buildBriefPrompt(emailActivity());
    expect(prompt).toContain('{"needsDecision":1,"handled":1,"fyi":1}');
    expect(prompt).not.toContain('renewal');
    expect(prompt).not.toContain('Happy to renew');
    expect(prompt).not.toContain('e1');
  });
});

describe('assembleBrief', () => {
  const reply = JSON.stringify({
    headline: 'A quiet day.',
    happened: ['Read the vendor thread.'],
    handled: ['Summarized it.'],
    decisions: [{ approvalId: 'a1', text: 'Send the reply to the vendor?' }],
  });

  it('assigns ids and takes approval references from real records, not from the reply', () => {
    const brief = assembleBrief(`\`\`\`json\n${reply}\n\`\`\``, baseActivity());
    expect(brief.happened).toEqual([{ id: 'h1', text: 'Read the vendor thread.' }]);
    expect(brief.handled).toEqual([{ id: 'x1', text: 'Summarized it.' }]);
    expect(brief.decisions[0]).toEqual({
      id: 'd1',
      text: 'Send the reply to the vendor?',
      approval: { questId: 'q1', sessionId: 's1', pendingActionTs: 1767225600000 },
    });
  });

  it('keeps an approval the model skipped, with fallback wording', () => {
    const brief = assembleBrief(reply, baseActivity());
    expect(brief.decisions).toHaveLength(2);
    expect(brief.decisions[1].approval).toEqual({ questId: 'q2', sessionId: 's2', pendingActionTs: 1767225700000 });
    expect(brief.decisions[1].text).toContain('archive');
  });

  it('ignores an approval id the model invented', () => {
    const invented = JSON.stringify({ headline: 'h', decisions: [{ approvalId: 'a99', text: 'Wire the money' }] });
    const brief = assembleBrief(invented, { ...baseActivity(), approvals: [] });
    expect(brief.decisions).toEqual([]);
  });

  it('folds triaged emails in from their records, after approvals, with the draft and source', () => {
    const brief = assembleBrief(reply, emailActivity());
    expect(brief.decisions.map(decision => decision.id)).toEqual(['d1', 'd2', 'd3']);
    expect(brief.decisions[0].approval).toBeDefined();
    expect(brief.decisions[2]).toEqual({
      id: 'd3',
      text: 'The vendor wants an answer on the renewal.',
      source: { kind: 'email', emailId: 'e1' },
      draftReply: draft,
    });
    expect(brief.decisions[2]).not.toHaveProperty('approval');
    expect(brief.handled).toEqual([
      { id: 'x1', text: 'The invoice was already paid.', source: { kind: 'email', emailId: 'e2' } },
      { id: 'x2', text: 'Summarized it.' },
    ]);
    expect(brief.happened[0]).toEqual({
      id: 'h1',
      text: 'The office is closed on Friday.',
      source: { kind: 'email', emailId: 'e3' },
    });
  });

  it('caps decisions at the section limit with approvals kept first', () => {
    const emails = Array.from({ length: 15 }, (_, index) => ({
      emailId: `e${index}`,
      kind: 'decision' as const,
      summary: `Email ${index}`,
    }));
    const brief = assembleBrief(reply, { ...baseActivity(), emails });
    expect(brief.decisions).toHaveLength(BRIEF_LIMITS.itemsPerSection);
    expect(brief.decisions[0].approval?.questId).toBe('q1');
    expect(brief.decisions[1].approval?.questId).toBe('q2');
    expect(brief.decisions.at(-1)?.source?.emailId).toBe(`e${BRIEF_LIMITS.itemsPerSection - 3}`);
  });

  it('reports only the emails that survived the caps as briefed, so the rest carry to the next brief', () => {
    const emails = Array.from({ length: 15 }, (_, index) => ({
      emailId: `e${index}`,
      kind: 'decision' as const,
      summary: `Email ${index}`,
    }));
    const ids = briefedEmailIds(assembleBrief(reply, { ...baseActivity(), emails }));
    expect(ids).toEqual(emails.slice(0, BRIEF_LIMITS.itemsPerSection - 2).map(email => email.emailId));
  });

  it('never lets model text displace a handled email from the capped section', () => {
    const emails = Array.from({ length: BRIEF_LIMITS.itemsPerSection }, (_, index) => ({
      emailId: `e${index}`,
      kind: 'handled' as const,
      summary: `Handled ${index}`,
    }));
    const flood = JSON.stringify({ headline: 'h', handled: Array.from({ length: 6 }, () => 'Model text') });
    const brief = assembleBrief(flood, { ...baseActivity(), emails });
    expect(brief.handled).toHaveLength(BRIEF_LIMITS.itemsPerSection);
    expect(brief.handled.every(item => item.source?.kind === 'email')).toBe(true);
  });

  it('throws on a reply with no JSON or the wrong shape', () => {
    expect(() => assembleBrief('sorry, no', baseActivity())).toThrow();
    expect(() => assembleBrief('{"headline": 3}', baseActivity())).toThrow();
  });
});

describe('emptyBrief and briefPushBody', () => {
  it('has no sections and reads as nothing new', () => {
    const brief = emptyBrief();
    expect(brief.decisions).toEqual([]);
    expect(briefPushBody(brief)).toBe('Nothing new since your last brief.');
  });

  it('pushes a decision count when decisions wait', () => {
    const brief = assembleBrief(JSON.stringify({ headline: 'h' }), baseActivity());
    expect(briefPushBody(brief)).toBe('2 decisions need you.');
  });
});
