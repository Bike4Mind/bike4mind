import { describe, expect, it } from 'vitest';
import { formatQuestionResult, parseOutcome, parseQuestions, sanitizeAnswers, type ChatQuestion } from './questions';

const option = (label: string, description = 'd') => ({ label, description });
const question = (overrides: Record<string, unknown> = {}) => ({
  question: 'Which auth method?',
  header: 'Auth',
  options: [option('OAuth (Recommended)'), option('API keys')],
  ...overrides,
});

const error = (value: unknown): string => {
  const parsed = parseQuestions(value);
  if (!('error' in parsed)) throw new Error('expected an error');
  return parsed.error;
};

describe('parseQuestions', () => {
  it('accepts a valid call and trims text', () => {
    const parsed = parseQuestions([question({ question: '  Which auth method?  ', multiSelect: true })]);
    expect(parsed).toEqual({ questions: [{ ...question(), multiSelect: true }] });
  });

  it('requires one to four questions', () => {
    expect(error(undefined)).toMatch(/non-empty array/);
    expect(error([])).toMatch(/non-empty array/);
    expect(error([1, 2, 3, 4, 5].map(n => question({ question: `Q${n}?` })))).toMatch(/at most 4/i);
    expect('questions' in parseQuestions([1, 2, 3, 4].map(n => question({ question: `Q${n}?` })))).toBe(true);
  });

  it('requires two to four options', () => {
    expect(error([question({ options: [option('A')] })])).toMatch(/2 to 4 options/);
    expect(error([question({ options: ['a', 'b', 'c', 'd', 'e'].map(l => option(l)) })])).toMatch(/2 to 4 options/);
  });

  it('holds the header to 12 characters', () => {
    expect(error([question({ header: 'Thirteen char' })])).toMatch(/12 characters/);
    expect(error([question({ header: '' })])).toMatch(/header/);
  });

  it('holds labels to five words and refuses an Other option', () => {
    expect(error([question({ options: [option('one two three four five six'), option('B')] })])).toMatch(/5 words/);
    expect(error([question({ options: [option('Other'), option('B')] })])).toMatch(/Other/);
    expect(error([question({ options: [option('Other (specify)'), option('B')] })])).toMatch(/Other/);
  });

  it('refuses duplicate labels and duplicate questions', () => {
    expect(error([question({ options: [option('A'), option('a')] })])).toMatch(/unique/);
    expect(error([question(), question()])).toMatch(/repeats/);
  });

  it('needs a description on every option', () => {
    expect(error([question({ options: [option('A', ''), option('B')] })])).toMatch(/description/);
  });

  it('rejects a non-boolean multiSelect', () => {
    expect(error([question({ multiSelect: 'yes' })])).toMatch(/multiSelect/);
  });
});

describe('sanitizeAnswers', () => {
  const single = parseQuestions([question()]) as { questions: ChatQuestion[] };
  const multi = parseQuestions([question({ multiSelect: true })]) as { questions: ChatQuestion[] };

  it('keeps only labels the question offered', () => {
    expect(sanitizeAnswers(single.questions, [{ selected: ['nope', 'API keys'] }])).toEqual([
      { selected: ['API keys'] },
    ]);
  });

  it('keeps one pick on a single-select question and all on a multi-select one', () => {
    const both = { selected: ['OAuth (Recommended)', 'API keys'] };
    expect(sanitizeAnswers(single.questions, [both])[0].selected).toHaveLength(1);
    expect(sanitizeAnswers(multi.questions, [both])[0].selected).toHaveLength(2);
  });

  it('lets typed text replace the pick on a single-select question', () => {
    expect(sanitizeAnswers(single.questions, [{ selected: ['API keys'], other: ' mTLS ' }])).toEqual([
      { selected: [], other: 'mTLS' },
    ]);
  });

  it('returns an entry per question whatever came in', () => {
    expect(sanitizeAnswers(single.questions, 'junk')).toEqual([{ selected: [] }]);
  });
});

describe('formatQuestionResult', () => {
  const two = (
    parseQuestions([question(), question({ question: 'Which tests?', header: 'Tests', multiSelect: true })]) as {
      questions: ChatQuestion[];
    }
  ).questions;

  it('lists each question with its chosen label', () => {
    const text = formatQuestionResult(two.slice(0, 1), {
      status: 'answered',
      answers: [{ selected: ['OAuth (Recommended)'] }],
    });
    expect(text).toContain('"Which auth method?" -> "OAuth (Recommended)"');
  });

  it('joins a multi-select answer and shows typed Other text', () => {
    const text = formatQuestionResult(two, {
      status: 'answered',
      answers: [
        { selected: [], other: 'mTLS' },
        { selected: ['OAuth (Recommended)', 'API keys'], other: 'custom' },
      ],
    });
    expect(text).toContain('"Which auth method?" -> Other: "mTLS"');
    expect(text).toContain('"Which tests?" -> "OAuth (Recommended)", "API keys", Other: "custom"');
  });

  it('marks a question left blank', () => {
    expect(formatQuestionResult(two.slice(0, 1), { status: 'answered', answers: [] })).toContain('(no answer)');
  });

  it('says the user skipped, and what to do about it', () => {
    const text = formatQuestionResult(two, { status: 'skipped' });
    expect(text).toMatch(/skipped/);
    expect(text).toMatch(/best judgment/);
  });

  it('says the question was cancelled', () => {
    expect(formatQuestionResult(two, { status: 'cancelled' })).toMatch(/cancelled/);
  });
});

describe('parseOutcome', () => {
  it('reads each shape and rejects the rest', () => {
    expect(parseOutcome({ status: 'skipped' })).toEqual({ status: 'skipped' });
    expect(parseOutcome({ status: 'cancelled' })).toEqual({ status: 'cancelled' });
    expect(parseOutcome({ status: 'answered', answers: [] })).toEqual({ status: 'answered', answers: [] });
    expect(parseOutcome({ status: 'answered' })).toBeNull();
    expect(parseOutcome(undefined)).toBeNull();
  });
});
