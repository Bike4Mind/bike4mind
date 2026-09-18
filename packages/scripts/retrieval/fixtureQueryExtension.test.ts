import { describe, expect, it } from 'vitest';
import type { ProbeQuestion } from './corpus';
import { hashQuestionText } from './embeddingFixture';
import {
  assembleExtendedQueries,
  formatQueryExtensionPlan,
  planQueryExtension,
  type CapturedQuery,
} from './fixtureQueryExtension';

const question = (id: string, text: string, supporting: string[] = []): ProbeQuestion => ({
  id,
  question: text,
  supporting,
});

const captured = (id: string, text: string, vector: number[], supporting: string[] = []): CapturedQuery => ({
  id,
  vector,
  questionHash: hashQuestionText(text),
  supporting,
});

describe('planQueryExtension', () => {
  it('reuses a vector for an unchanged question and embeds only the new ones', () => {
    const plan = planQueryExtension({
      existing: [captured('n01', 'old negative', [1, 0]), captured('n02', 'other negative', [0, 1])],
      questions: [question('n01', 'old negative'), question('p01', 'new positive', ['fileA'])],
    });
    expect(plan.reused.map(q => q.id)).toEqual(['n01']);
    expect(plan.reused[0].vector).toEqual([1, 0]);
    expect(plan.toEmbed.map(q => q.id)).toEqual(['p01']);
    expect(plan.addedIds).toEqual(['p01']);
    expect(plan.droppedIds).toEqual(['n02']);
  });

  it('re-embeds a question whose TEXT changed under an unchanged id', () => {
    // The hazard the whole module is shaped around: the id still matches, so nothing downstream
    // notices, and the arm is scored on a question the file no longer asks. Keying reuse on the id
    // alone passes every other test here and silently reintroduces it.
    const plan = planQueryExtension({
      existing: [captured('q01', 'what did we measure?', [1, 0])],
      questions: [question('q01', 'what did we measure on Forte-1?')],
    });
    expect(plan.reused).toHaveLength(0);
    expect(plan.rewordedIds).toEqual(['q01']);
    expect(plan.toEmbed.map(q => q.question)).toEqual(['what did we measure on Forte-1?']);
  });

  it('takes ground truth from the question file, not from the capture', () => {
    // A screen can reclassify a question without changing a word of it. Carrying the fixture's copy
    // would score the new file's questions against the old file's answers.
    const plan = planQueryExtension({
      existing: [captured('n01', 'a question', [1, 0], [])],
      questions: [question('n01', 'a question', ['fileA'])],
    });
    expect(plan.reused[0].supporting).toEqual(['fileA']);
    expect(plan.supportingChangedIds).toEqual(['n01']);
  });

  it('does not report a reordered supporting set as a change', () => {
    const plan = planQueryExtension({
      existing: [captured('q01', 'a question', [1, 0], ['b', 'a'])],
      questions: [question('q01', 'a question', ['a', 'b'])],
    });
    expect(plan.supportingChangedIds).toEqual([]);
  });

  it('refuses a capture whose ground truth is the committed question set', () => {
    // Those queries join to corpus.ts by id, and the text pin there is the only thing keeping them
    // honest; splicing an external file on would retire it without saying so.
    expect(() =>
      planQueryExtension({
        existing: [{ id: 'q01', vector: [1, 0], questionHash: hashQuestionText('a question') }],
        questions: [question('q01', 'a question')],
      })
    ).toThrow(/committed PROBE_QUESTIONS/);
  });

  it('refuses an empty question set', () => {
    expect(() => planQueryExtension({ existing: [], questions: [] })).toThrow(/empty question set/);
  });
});

describe('assembleExtendedQueries', () => {
  const existing = [captured('n01', 'kept', [1, 0])];
  const questions = [
    question('p01', 'new one', ['fileA']),
    question('n01', 'kept'),
    question('p02', 'another', ['fileB']),
  ];

  it('returns the queries in the QUESTION FILE order, not reused-then-embedded', () => {
    // The sweep pairs its per-query outcomes with the resolved query list positionally, so any other
    // order produces a table whose rows carry the wrong questions' labels.
    const plan = planQueryExtension({ existing, questions });
    const out = assembleExtendedQueries({
      plan,
      questions,
      embedded: [
        [0, 1],
        [1, 1],
      ],
    });
    expect(out.map(q => q.id)).toEqual(['p01', 'n01', 'p02']);
    expect(out.map(q => q.vector)).toEqual([
      [0, 1],
      [1, 0],
      [1, 1],
    ]);
    expect(out.map(q => q.supporting)).toEqual([['fileA'], [], ['fileB']]);
  });

  it('hashes each freshly embedded question, so a later reuse can tell whether it changed', () => {
    const plan = planQueryExtension({ existing, questions });
    const out = assembleExtendedQueries({
      plan,
      questions,
      embedded: [
        [0, 1],
        [1, 1],
      ],
    });
    expect(out.find(q => q.id === 'p01')!.questionHash).toBe(hashQuestionText('new one'));
  });

  it('refuses a vector count that does not match the plan', () => {
    const plan = planQueryExtension({ existing, questions });
    expect(() => assembleExtendedQueries({ plan, questions, embedded: [[0, 1]] })).toThrow(/for 2 question/);
  });
});

describe('formatQueryExtensionPlan', () => {
  it('names the reworded ids loudly, because an earlier table using them measured something else', () => {
    const plan = planQueryExtension({
      existing: [captured('q01', 'old text', [1, 0])],
      questions: [question('q01', 'new text')],
    });
    const out = formatQueryExtensionPlan(plan);
    expect(out).toContain('REWORDED ids');
    expect(out).toContain('q01');
    expect(out).toMatch(/measured a different question under the same id/);
  });

  it('names the ids whose ground truth moved separately from the reworded ones', () => {
    const plan = planQueryExtension({
      existing: [captured('n01', 'a question', [1, 0], [])],
      questions: [question('n01', 'a question', ['fileA'])],
    });
    const out = formatQueryExtensionPlan(plan);
    expect(out).toContain('GROUND TRUTH MOVED');
    expect(out).not.toContain('REWORDED ids');
  });

  it('stays quiet about all three when nothing moved', () => {
    const plan = planQueryExtension({
      existing: [captured('n01', 'a question', [1, 0], [])],
      questions: [question('n01', 'a question')],
    });
    const out = formatQueryExtensionPlan(plan);
    expect(out).toContain('reuse vectors for    : 1 question(s)');
    expect(out).not.toContain('REWORDED');
    expect(out).not.toContain('GROUND TRUTH MOVED');
    expect(out).not.toContain('dropped from capture');
  });
});
