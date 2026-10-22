import { describe, expect, it } from 'vitest';
import {
  fitText,
  formatQuestionResult,
  MAX_DESCRIPTION_CHARS,
  MAX_HEADER_CHARS,
  MAX_LABEL_CHARS,
  parseOutcome,
  parseQuestions,
  sanitizeAnswers,
  type ChatQuestion,
} from './questions';

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

  const parsed = (value: unknown): ChatQuestion[] => {
    const result = parseQuestions(value);
    if ('error' in result) throw new Error(result.error);
    return result.questions;
  };
  const headerOf = (header: unknown) => parsed([question({ header })])[0].header;

  it('shortens a long header at a word boundary instead of refusing it', () => {
    expect(headerOf('Deployment target')).toBe('Deployment\u2026');
    expect(headerOf('API/auth flow')).toBe('API/auth\u2026');
  });

  it('hard-cuts a long header with no boundary in reach', () => {
    expect(headerOf('board-watchers')).toBe('board-watch\u2026');
    expect(headerOf('Supercalifragilistic')).toBe('Supercalifr\u2026');
    expect(headerOf('board-watchers')).toHaveLength(MAX_HEADER_CHARS);
  });

  it('falls back when the header is empty or missing', () => {
    expect(headerOf('   ')).toBe('Question');
    expect(headerOf(undefined)).toBe('Question');
    expect(headerOf('  Auth  ')).toBe('Auth');
  });

  it('is idempotent, so a stored call parses back to what the card showed', () => {
    const once = parsed([
      question({
        header: 'board-watchers',
        options: [option(`${'x'.repeat(70)} (Recommended)`, 'y '.repeat(200)), option('B')],
      }),
    ]);
    expect(parsed(once)).toEqual(once);
  });

  it('shortens a long label and description, keeping the recommendation', () => {
    const [entry] = parsed([
      question({
        options: [
          option('Revert the scrub and ship the migration as its own pull request (Recommended)', 'z'.repeat(400)),
          option('B'),
        ],
      }),
    ]);
    expect(entry.options[0].label).toBe('Revert the scrub and ship the migration as\u2026 (Recommended)');
    expect(entry.options[0].description).toHaveLength(MAX_DESCRIPTION_CHARS);
  });

  it('refuses labels that only collide once shortened, saying why', () => {
    const stem = 'a'.repeat(MAX_LABEL_CHARS);
    expect(error([question({ options: [option(`${stem} one`), option(`${stem} two`)] })])).toMatch(/differ sooner/);
  });

  it('accepts a long label and refuses an Other option', () => {
    const long = option('Revert the scrub, PR the migration alone (Recommended)');
    expect(parseQuestions([question({ options: [long, option('B')] })])).not.toHaveProperty('error');
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

  it('still refuses a missing or over-long question', () => {
    expect(error([question({ question: '  ' })])).toMatch(/non-empty "question"/);
    expect(error([question({ question: `${'q'.repeat(300)}?` })])).toMatch(/300 characters/);
  });
});

describe('fitText', () => {
  it('leaves text within the limit alone', () => {
    expect(fitText('Auth method', 12)).toBe('Auth method');
  });

  it('cuts at a hyphen, plus or slash boundary when that keeps half the room', () => {
    expect(fitText('Single-tenant-db', 12)).toBe('Single\u2026');
    expect(fitText('Cache+CDN layer', 12)).toBe('Cache+CDN\u2026');
    expect(fitText('Read-only mode', 12)).toBe('Read-only\u2026');
  });

  it('hard-cuts when the only boundary would keep less than half', () => {
    expect(fitText('ab-cdefghijklmn', 12)).toBe('ab-cdefghij\u2026');
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
