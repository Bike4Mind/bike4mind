import { describe, expect, it } from 'vitest';
import {
  formatServedScreen,
  loadServedEmission,
  selectServedFloor,
  type ServedChunkText,
  type ServedEmission,
} from './servedTextScreen';

const floorPoint = (label: string, queries: ServedEmission['floors'][number]['queries']) => ({
  floor: label,
  distinctServedChunkIds: [...new Set(queries.flatMap(q => q.servedChunkIds))],
  queries,
});

const EMISSION: ServedEmission = {
  model: 'text-embedding-3-small',
  dims: 1536,
  corpus: 'a-lake',
  charBudget: 12_000,
  floors: [
    floorPoint('relative=85% absolute=49% spread=0%', [
      { id: 'n01', supportingCount: 0, accepted: 2, topScore: 0.5123, servedChunkIds: ['c1', 'c2'] },
      { id: 'n02', supportingCount: 0, accepted: 0, topScore: 0.41, servedChunkIds: [] },
      { id: 'q01', supportingCount: 1, accepted: 1, topScore: 0.71, servedChunkIds: ['c3'] },
    ]),
    floorPoint('relative=85% absolute=75% spread=0%', [
      { id: 'n01', supportingCount: 0, accepted: 0, topScore: 0.5123, servedChunkIds: [] },
      { id: 'n02', supportingCount: 0, accepted: 0, topScore: 0.41, servedChunkIds: [] },
      { id: 'q01', supportingCount: 1, accepted: 0, topScore: 0.71, servedChunkIds: [] },
    ]),
  ],
};

const text = (id: string, body: string, fabFileId = 'f1'): [string, ServedChunkText] => [
  id,
  { id, fabFileId, text: body },
];

const TEXTS = new Map([
  text('c1', 'a passage about annealing'),
  text('c2', 'another passage'),
  text('c3', 'ground truth'),
]);

const QUESTIONS = new Map([
  ['n01', 'What is the airspeed of a swallow?'],
  ['n02', 'Who won in 1904?'],
  ['q01', 'What does the corpus say about annealing?'],
]);

describe('loadServedEmission', () => {
  it('accepts an emission and names the file when it is something else', () => {
    expect(loadServedEmission(JSON.parse(JSON.stringify(EMISSION)), 'served.json')).toEqual(EMISSION);
    expect(() => loadServedEmission({ model: 'm' }, 'served.json')).toThrow(/served\.json/);
    expect(() => loadServedEmission({ ...EMISSION, floors: [] }, 'served.json')).toThrow(/floors/);
  });
});

describe('selectServedFloor', () => {
  it('matches a floor by a substring of its label', () => {
    expect(selectServedFloor(EMISSION, 'absolute=49%').floor).toBe('relative=85% absolute=49% spread=0%');
    expect(selectServedFloor(EMISSION, 'relative=85% absolute=75% spread=0%').floor).toContain('absolute=75%');
  });

  it('refuses to guess when the emission holds several points and none was named', () => {
    // A screen names its floor in the heading, so defaulting to the first point would produce a
    // document that reads as the right one and is not.
    expect(() => selectServedFloor(EMISSION)).toThrow(/--floor/);
    expect(selectServedFloor({ ...EMISSION, floors: [EMISSION.floors[0]] }).floor).toContain('absolute=49%');
  });

  it('refuses an ambiguous or unmatched selector', () => {
    expect(() => selectServedFloor(EMISSION, 'relative=85%')).toThrow(/matches 2 floor points/);
    expect(() => selectServedFloor(EMISSION, 'absolute=60%')).toThrow(/No floor point matching/);
  });
});

describe('formatServedScreen', () => {
  const screen = (overrides: Partial<Parameters<typeof formatServedScreen>[0]> = {}) =>
    formatServedScreen({
      emission: EMISSION,
      floor: EMISSION.floors[0],
      texts: TEXTS,
      questions: QUESTIONS,
      ...overrides,
    });

  it('pairs each question with the text of what it was served', () => {
    const out = screen();
    expect(out).toContain('What is the airspeed of a swallow?');
    expect(out).toContain('> a passage about annealing');
    expect(out).toContain('> another passage');
    expect(out).toContain('served 1/2 - chunk c1 (file f1)');
  });

  it('labels a negative candidate as one, and a positive by its supporting count', () => {
    const out = screen();
    expect(out).toContain('## n01 - NEGATIVE candidate');
    expect(out).toContain('## q01 - 1 supporting doc(s)');
  });

  it('keeps a question the floor emptied, rather than dropping it from the screen', () => {
    // Dropping it would make every question in the document look like one that got something,
    // which is the measurement under review.
    const out = screen();
    expect(out).toContain('## n02 - NEGATIVE candidate');
    expect(out).toContain('Served NOTHING');
  });

  it('marks a chunk that has left the corpus instead of rendering it blank', () => {
    const out = screen({ texts: new Map([text('c1', 'a passage about annealing')]) });
    expect(out).toContain('(missing from the corpus at read time)');
    expect(out).toMatch(/2 of 3 served chunk ids are no longer in the corpus/);
  });

  it('says so when a question id is absent from the question file', () => {
    const out = screen({ questions: new Map() });
    expect(out).toContain('(not in the questions file)');
  });

  it('truncates a long chunk and says it did', () => {
    const out = screen({ texts: new Map([text('c1', 'x'.repeat(4000))]), maxChars: 100 });
    expect(out).toContain('[truncated at 100 chars]');
    expect(out).not.toContain('x'.repeat(101));
  });

  it('quotes every line of a multi-paragraph chunk, so one passage reads as one unit', () => {
    const out = screen({ texts: new Map([text('c1', 'first line\n\nsecond line')]) });
    expect(out).toContain('> first line');
    expect(out).toContain('> second line');
  });

  it('counts the negatives and the distinct chunks in its header', () => {
    expect(screen()).toContain('3 questions (2 negative candidates), 2 served something, 3 distinct chunks.');
  });
});
