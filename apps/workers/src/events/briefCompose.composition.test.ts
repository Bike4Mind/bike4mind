import { describe, expect, it } from 'vitest';
import {
  assembleBrief,
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
});

describe('hasActivity', () => {
  it('is false only when there are no runs and no approvals', () => {
    expect(hasActivity({ ...baseActivity(), runs: [], approvals: [] })).toBe(false);
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
