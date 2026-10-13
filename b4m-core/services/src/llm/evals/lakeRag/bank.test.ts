import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { LAKE_RAG_KINDS, LakeRagBankSchema, loadLakeRagBank, type LakeRagBankRow } from './bank';
import { tokenMatcher as token } from './grade';

const CORPUS_DIR = join(__dirname, 'corpus');
const SUPERSEDED = 'superseded';
const MIN_QUESTIONS_PER_SUBJECT = 10;
const MIN_PER_PLANTED_KIND = 2;

const bank = loadLakeRagBank();
const subjects = readdirSync(CORPUS_DIR);

type CorpusDoc = { path: string; date: string; body: string };

function readDoc(path: string): CorpusDoc {
  const text = readFileSync(path, 'utf8');
  const date = /^---\n[\s\S]*?^date:\s*(\d{4}-\d{2}-\d{2})\s*$[\s\S]*?^---\n/m.exec(text)?.[1];
  if (!date) throw new Error(`${path}: missing frontmatter date`);
  return { path, date, body: text };
}

function docsIn(subject: string): CorpusDoc[] {
  const dir = join(CORPUS_DIR, subject);
  const current = readdirSync(dir).filter(name => name.endsWith('.md'));
  const supersededDir = join(dir, SUPERSEDED);
  const superseded = existsSync(supersededDir) ? readdirSync(supersededDir).map(name => join(SUPERSEDED, name)) : [];
  return [...current, ...superseded].map(name => readDoc(join(dir, name)));
}

function plantedRows(kind: LakeRagBankRow['kind']): LakeRagBankRow[] {
  return bank.filter(row => row.kind === kind);
}

describe('loadLakeRagBank', () => {
  const valid = {
    id: 'x',
    subject: 's',
    kind: 'fact',
    question: 'q?',
    expect: ['a'],
    expectSource: 'a.md',
    rejectTokens: [],
  };

  it('loads the bundled bank', () => {
    expect(bank.length).toBeGreaterThan(0);
  });

  it.each([
    ['a pattern that does not compile', { ...valid, expect: ['(unclosed'] }],
    ['a fact with no expected source', { ...valid, expectSource: null }],
    ['an absent case with an expected answer', { ...valid, kind: 'absent', expectSource: null }],
    ['a stale case with nothing to reject', { ...valid, kind: 'stale-same-name' }],
    ['an unknown kind', { ...valid, kind: 'trivia' }],
  ])('rejects %s', (_label, bad) => {
    expect(() => loadLakeRagBank([bad])).toThrow();
  });

  it('rejects duplicate ids', () => {
    expect(LakeRagBankSchema.safeParse([valid, valid]).success).toBe(false);
  });
});

describe('bank coverage', () => {
  it('spans at least three subjects, each a corpus directory', () => {
    expect(subjects.length).toBeGreaterThanOrEqual(3);
    expect(new Set(bank.map(row => row.subject))).toEqual(new Set(subjects));
  });

  it.each(subjects)('%s has enough questions and every planted kind', subject => {
    const rows = bank.filter(row => row.subject === subject);
    expect(rows.length).toBeGreaterThanOrEqual(MIN_QUESTIONS_PER_SUBJECT);
    for (const kind of LAKE_RAG_KINDS) {
      expect(rows.filter(row => row.kind === kind).length, kind).toBeGreaterThanOrEqual(MIN_PER_PLANTED_KIND);
    }
  });

  it.each(subjects)('every %s document carries a frontmatter date', subject => {
    expect(() => docsIn(subject)).not.toThrow();
  });
});

// These pin that each planted case is real in the corpus: a bank edit that drifts from the files
// would otherwise grade replies against an answer the lake never held.
describe('bank agrees with the corpus', () => {
  it.each(bank.filter(row => row.expectSource !== null).map(row => [row.id, row] as const))(
    '%s: expected answer is in its current source, stale value is not',
    (_id, row) => {
      const source = readDoc(join(CORPUS_DIR, row.subject, row.expectSource as string));
      for (const pattern of row.expect) expect(source.body, pattern).toMatch(token(pattern));
      for (const pattern of row.rejectTokens) expect(source.body, pattern).not.toMatch(token(pattern));
    }
  );

  it.each(plantedRows('stale-same-name').map(row => [row.id, row] as const))(
    '%s: an older generation with the same file name holds the stale value',
    (_id, row) => {
      const dir = join(CORPUS_DIR, row.subject);
      const current = readDoc(join(dir, row.expectSource as string));
      const older = readDoc(join(dir, SUPERSEDED, row.expectSource as string));
      expect(older.date < current.date).toBe(true);
      for (const pattern of row.rejectTokens) expect(older.body, pattern).toMatch(token(pattern));
    }
  );

  it.each(plantedRows('stale-different-name').map(row => [row.id, row] as const))(
    '%s: an older document under another name holds the stale value',
    (_id, row) => {
      const current = readDoc(join(CORPUS_DIR, row.subject, row.expectSource as string));
      const stale = docsIn(row.subject).filter(
        doc =>
          !doc.path.includes(`/${SUPERSEDED}/`) &&
          doc.path !== current.path &&
          row.rejectTokens.every(pattern => token(pattern).test(doc.body))
      );
      expect(stale.length).toBeGreaterThan(0);
      for (const doc of stale) expect(doc.date < current.date).toBe(true);
    }
  );
});
