import { describe, expect, it } from 'vitest';
import { hasSingleLineImportFrom, scanImportStatements } from './importStatements';

/**
 * The scanner here replaced four backtracking regexes, so those regexes are the oracle for its
 * match set: anything the scanner finds, drops or spans differently is a behavior change.
 * Copied verbatim from the pre-change `artifactParser.ts` and `transpileReactArtifact.ts`.
 */
const originalStatement = () => /import\s+([\s\S]*?)\s+from\s+['"]([^'"]+)['"]/g;
const originalTypeStrip = () => /import\s+type\s+[\s\S]*?\s+from\s+['"][^'"]+['"]\s*;?/g;
const originalClauseStrip = () => /import\s+([\s\S]*?)\s+from\s+['"][^'"]+['"]\s*;?/g;
const originalReactImport = () => /import\s+.*\s+from\s+['"]react['"]/;

/** One record per match: span plus whichever captures the caller compares. */
function oracleRecords(re: RegExp, source: string, fields: (m: RegExpExecArray) => string[]): string[] {
  const out: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(source)) !== null) {
    out.push(JSON.stringify([m.index, m.index + m[0].length, ...fields(m)]));
    if (m[0].length === 0) re.lastIndex++;
  }
  return out;
}

function scannerRecords(
  source: string,
  opts: { typeKeyword?: boolean; consumeTrailing?: boolean },
  fields: (s: { clause: string; specifier: string }) => string[]
): string[] {
  return scanImportStatements(source, opts).map(s => JSON.stringify([s.index, s.end, ...fields(s)]));
}

interface Directions {
  /** Oracle matches the implementation under test did not produce. */
  missing: number;
  /** Matches the implementation produced that the oracle does not have. */
  extra: number;
  examples: string[];
}

function compare(expected: string[], actual: string[], label: string, source: string, into: Directions): void {
  const missing = expected.filter(r => !actual.includes(r));
  const extra = actual.filter(r => !expected.includes(r));
  into.missing += missing.length;
  into.extra += extra.length;
  if ((missing.length || extra.length) && into.examples.length < 5) {
    into.examples.push(`${label} ${JSON.stringify(source)} missing=${missing.join('')} extra=${extra.join('')}`);
  }
}

/** Deterministic LCG (Numerical Recipes constants) so CI generates the identical corpus every run. */
function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

/** Pieces the generator splices into import-shaped cases, including the near-miss mutations. */
const WS_RUNS: readonly string[] = [
  ' ',
  '  ',
  '   ',
  '\t',
  '\n',
  '\r\n',
  '\u00a0',
  '\ufeff',
  '\u3000',
  '\v',
  '\f',
  '\u2028',
  '\u2029',
  ' \n  ',
  '',
];
const CLAUSES: readonly string[] = [
  '',
  'React',
  'x',
  'ns',
  '{a}',
  '{ useState }',
  '{ a, b }',
  '* as ns',
  'A, { b as c }',
  '{\n  A,\n  B,\n}',
  'type X',
  'type',
  '{ type X, y }',
  'a from',
  'a\nb',
  'a\u2028b',
  'a\u00a0b',
];
const SPECS: readonly string[] = ['react', 'lodash', './rel', 'lucide-react', '', 'd3', 'preact', 'react '];
const QUOTES: readonly string[] = ["'", '"'];
const TAILS: readonly string[] = ['', ';', ' ;', '\n', '  ', ';\n', '\t;'];
const KEYWORDS: readonly string[] = [
  'import',
  'import',
  'import',
  'import',
  'reimport',
  'importantThing',
  'import(',
  'import.meta',
  'import type',
];
const NOISE: readonly string[] = [
  '\n',
  ' ',
  '',
  '\nconst x = 1;\n',
  '// comment\n',
  '\nimport\n',
  'from ',
  "'",
  '"',
  '}',
  '\nimport ',
  ' from ',
  '/* import a from "m" */',
];

const LUCIDE_CLAUSE = Array.from({ length: 400 }, (_, i) => `Icon${i}`).join(', ');

/** Clauses past the removed 2000-char bound; these are what make the control below diverge. */
const LONG_CASES: readonly string[] = [
  `import {\n  ${LUCIDE_CLAUSE}\n} from 'lucide-react';`,
  `import { ${LUCIDE_CLAUSE} } from 'lucide-react'`,
  `import type { ${LUCIDE_CLAUSE} } from 'lucide-react';`,
  `import Default, { ${LUCIDE_CLAUSE} } from 'react';`,
  `const a = 1;\nimport { ${LUCIDE_CLAUSE} } from 'react';\nconst b = 2;`,
  `import * as NS from 'd3';\nimport { ${LUCIDE_CLAUSE} } from 'lucide-react';`,
];

const CORPUS: readonly string[] = (() => {
  const rand = lcg(0x5eed1234);
  const pick = (arr: readonly string[]): string => arr[Math.floor(rand() * arr.length)];
  const fragment = (): string =>
    `${pick(KEYWORDS)}${pick(WS_RUNS)}${pick(CLAUSES)}${pick(WS_RUNS)}from${pick(WS_RUNS)}${pick(QUOTES)}${pick(
      SPECS
    )}${pick(QUOTES)}${pick(TAILS)}`;
  const cases: string[] = [];
  for (let i = 0; i < 3000; i++) {
    const n = 1 + Math.floor(rand() * 3);
    let text = pick(NOISE);
    for (let j = 0; j < n; j++) text += fragment() + pick(NOISE);
    cases.push(text);
  }
  return [...cases, ...LONG_CASES];
})();

describe('scanImportStatements differential vs the original regexes', () => {
  it('reproduces every original match, and produces no match the originals did not have', () => {
    const statement: Directions = { missing: 0, extra: 0, examples: [] };
    const typeStrip: Directions = { missing: 0, extra: 0, examples: [] };
    const clauseStrip: Directions = { missing: 0, extra: 0, examples: [] };
    for (const source of CORPUS) {
      compare(
        oracleRecords(originalStatement(), source, m => [m[1], m[2]]),
        scannerRecords(source, {}, s => [s.clause, s.specifier]),
        'statement',
        source,
        statement
      );
      compare(
        oracleRecords(originalTypeStrip(), source, () => []),
        scannerRecords(source, { typeKeyword: true, consumeTrailing: true }, () => []),
        'type-strip',
        source,
        typeStrip
      );
      compare(
        oracleRecords(originalClauseStrip(), source, m => [m[1]]),
        scannerRecords(source, { consumeTrailing: true }, s => [s.clause]),
        'clause-strip',
        source,
        clauseStrip
      );
    }
    expect(statement).toEqual({ missing: 0, extra: 0, examples: [] });
    expect(typeStrip).toEqual({ missing: 0, extra: 0, examples: [] });
    expect(clauseStrip).toEqual({ missing: 0, extra: 0, examples: [] });
  });

  it('agrees with the original single-line react-import predicate on every case', () => {
    const disagreements: string[] = [];
    for (const source of CORPUS) {
      const expected = originalReactImport().test(source);
      if (hasSingleLineImportFrom(source, 'react') !== expected) {
        disagreements.push(JSON.stringify(source));
      }
    }
    expect({ count: disagreements.length, examples: disagreements.slice(0, 5) }).toEqual({ count: 0, examples: [] });
  });

  it('exercises the corpus rather than passing vacuously', () => {
    const withMatches = CORPUS.filter(s => scanImportStatements(s).length > 0).length;
    const withReact = CORPUS.filter(s => hasSingleLineImportFrom(s, 'react')).length;
    expect(withMatches).toBeGreaterThan(200);
    expect(withReact).toBeGreaterThan(20);
  });
});

/**
 * Control: the 2000-char clause bound this module dropped. A clause past it silently stopped
 * matching, leaving a bare ESM import in the published bundle so the artifact blanked at load.
 */
describe('vacuity control: the removed 2000-char clause bound', () => {
  const MAX_IMPORT_CLAUSE_CHARS = 2000;
  const boundedStatement = () =>
    new RegExp(`import\\s[\\s\\S]{0,${MAX_IMPORT_CLAUSE_CHARS}}?\\sfrom\\s+['"]([^'"]+)['"]`, 'g');

  it('loses a clause past the bound entirely, which is how the dependency went missing', () => {
    const src = `import { ${LUCIDE_CLAUSE} } from 'lucide-react';`;
    expect(originalStatement().test(src)).toBe(true);
    expect(boundedStatement().test(src)).toBe(false);
  });

  it('diverges from the original regexes, so the differential above can fail', () => {
    // Scoped to LONG_CASES, not the whole CORPUS: the bounded regex also diverges from
    // the original on plenty of short, unrelated cases, so a whole-corpus missing > 0
    // would still pass with every LONG_CASES entry deleted.
    const bounded: Directions = { missing: 0, extra: 0, examples: [] };
    for (const source of LONG_CASES) {
      compare(
        oracleRecords(originalStatement(), source, m => [m[2]]),
        oracleRecords(boundedStatement(), source, m => [m[1]]),
        'bounded',
        source,
        bounded
      );
    }
    expect(bounded.missing).toBeGreaterThan(0);
  });
});

describe('scanImportStatements invariants', () => {
  it('matches `import  from` (two spaces) with an empty clause', () => {
    expect(scanImportStatements(`import  from 'x'`)).toEqual([{ index: 0, end: 16, clause: '', specifier: 'x' }]);
  });

  it('does not match `import from` (one space)', () => {
    expect(scanImportStatements(`import from 'x'`)).toEqual([]);
  });

  it('takes the ws-run fallback only when no terminator follows the run', () => {
    expect(scanImportStatements(`import   from 'x'`)).toEqual([{ index: 0, end: 17, clause: '', specifier: 'x' }]);
    // A terminator strictly past the run wins over the one sitting at its end.
    expect(scanImportStatements(`import  from  from 'x'`)).toEqual([
      { index: 0, end: 22, clause: 'from', specifier: 'x' },
    ]);
  });

  it('does not pair a `from` that is not preceded by whitespace', () => {
    expect(scanImportStatements(`import {a}from 'm'`)).toEqual([]);
    expect(scanImportStatements(`import ns nsfrom 'm'`)).toEqual([]);
  });

  it('treats the opening and closing quote as independent character classes', () => {
    expect(scanImportStatements(`import a from 'x"`)).toEqual([{ index: 0, end: 17, clause: 'a', specifier: 'x' }]);
  });

  it('matches a clause longer than the removed 2000-char bound', () => {
    expect(LUCIDE_CLAUSE.length).toBeGreaterThan(2000);
    expect(scanImportStatements(`import { ${LUCIDE_CLAUSE} } from 'lucide-react';`)).toEqual([
      { index: 0, end: LUCIDE_CLAUSE.length + 31, clause: `{ ${LUCIDE_CLAUSE} }`, specifier: 'lucide-react' },
    ]);
  });

  it('accepts every exotic JS `\\s` character as a separator', () => {
    for (const ws of ['\u00a0', '\ufeff', '\u3000', '\v', '\f', '\u2028', '\u2029']) {
      expect(scanImportStatements(`import${ws}A${ws}from${ws}'m'`)).toEqual([
        { index: 0, end: 17, clause: 'A', specifier: 'm' },
      ]);
    }
  });

  it('has no word boundary, so an `import` inside an identifier, comment or string still matches', () => {
    expect(scanImportStatements(`reimport a from 'm'`).map(s => s.index)).toEqual([2]);
    expect(scanImportStatements(`// import a from 'm'`).map(s => s.specifier)).toEqual(['m']);
    expect(scanImportStatements(`const s = "import a from 'm'";`).map(s => s.specifier)).toEqual(['m']);
  });

  it('does not match when `import` is not followed by whitespace', () => {
    expect(scanImportStatements(`importantThing from 'm'`)).toEqual([]);
    expect(scanImportStatements(`import('m')`)).toEqual([]);
    expect(scanImportStatements(`import.meta.url from 'm'`)).toEqual([]);
  });

  it('does not match a bare side-effect import, which the original regex also skipped', () => {
    expect(scanImportStatements(`import 'x';`)).toEqual([]);
    expect(originalStatement().test(`import 'x';`)).toBe(false);
  });

  it('matches across CRLF and multi-line clauses', () => {
    expect(scanImportStatements(`import A\r\nfrom 'm'`).map(s => s.clause)).toEqual(['A']);
    expect(scanImportStatements(`import {\n  A,\n  B,\n} from 'm'`).map(s => s.specifier)).toEqual(['m']);
  });
});

describe('hasSingleLineImportFrom', () => {
  it('splits a whitespace-only clause when at least two characters are available', () => {
    expect(hasSingleLineImportFrom(`import  from 'react'`, 'react')).toBe(true);
    expect(hasSingleLineImportFrom(`import from 'react'`, 'react')).toBe(false);
  });

  it('falls back to the second-nearest import when the nearest one cannot reach the terminator', () => {
    expect(hasSingleLineImportFrom(`import a import from 'react'`, 'react')).toBe(true);
    expect(originalReactImport().test(`import a import from 'react'`)).toBe(true);
  });

  it('rejects a clause split by a line terminator and accepts other whitespace', () => {
    for (const lt of ['\n', '\r', '\u2028', '\u2029']) {
      expect(hasSingleLineImportFrom(`import a${lt}b from 'react'`, 'react')).toBe(false);
    }
    for (const ws of ['\u00a0', '\ufeff', '\u3000', '\v', '\f']) {
      expect(hasSingleLineImportFrom(`import a${ws}b from 'react'`, 'react')).toBe(true);
    }
  });

  it('still accepts a line terminator inside the `\\s+` runs on either side of the clause', () => {
    expect(hasSingleLineImportFrom(`import Thing\n  from 'react'`, 'react')).toBe(true);
  });

  it('is specifier-scoped', () => {
    expect(hasSingleLineImportFrom(`import { x } from 'preact'`, 'react')).toBe(false);
  });
});
