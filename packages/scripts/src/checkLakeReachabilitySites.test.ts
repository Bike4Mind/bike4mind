import { describe, it, expect } from 'vitest';
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import ts from 'typescript';

/**
 * Guards the lake reachability rule ("live, not retrieval-excluded, fully vectorized") on two axes:
 * the SITES that hold a copy of it, and the CLAUSE SET each of those copies actually spells.
 *
 * The site half tracks which files carry the fully-vectorized comparison and how many copies each
 * holds, so a fourth copy fails. The clause half then reads each copy's enclosing predicate through
 * the TypeScript AST and requires the live and retrieval-excluded clauses to be in it - deleting one
 * leaves the matched line byte-identical, so the site half alone would stay green.
 *
 * Why the clause half is AST-scoped and not a wider regex: the clauses sit on their OWN lines (and
 * as a bare conjunction in one of the three copies rather than an early return), so a line-oriented
 * detector cannot see them however wide it is. A file-scoped symbol search would see them and be
 * vacuous - two of the three sites mention these symbols outside the predicate, so it would pass on
 * a predicate that had lost the clause entirely.
 *
 * Sibling of checkEmbeddingModelComparisonSites, and deliberately a second test rather than a wider
 * one. That guard watches the `embeddingModel` exact-match clause; `isCapturableFile` omits that
 * clause on purpose (the comparison harness varies the model), so it is correctly invisible there -
 * and was therefore guarded by nothing. This is the clause set it does share.
 *
 * Same failure shape as its sibling: the rule is duplicated across packages with no shared symbol,
 * relaxing one copy does not propagate, and the symptom is silent - a doc the served path cannot
 * surface gets deferred, cited or scored anyway.
 */
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

/**
 * The three copies. `matches` is how many CODE lines in the file the patterns below hit, so a
 * fourth copy added inside an already-listed file is caught too.
 */
const SITES: { path: string; matches: number; note: string }[] = [
  {
    path: 'b4m-core/services/src/llm/ChatCompletionProcess.ts',
    matches: 1,
    note: 'Corpus defer gate: may this doc be dropped from the prompt because retrieval can fetch it',
  },
  {
    path: 'apps/client/server/memory/lakeSourceReachability.ts',
    matches: 1,
    note: 'isFabFileCitable: may a lake belief lean on this doc without dangling its citation',
  },
  {
    path: 'packages/scripts/retrieval/capturePlan.ts',
    matches: 1,
    note: 'isCapturableFile: may this file enter the embedding-comparison corpus. Omits embeddingModel',
  },
];

/**
 * A fully-vectorized comparison in either spelling: against `vectorizedChunkCount`, or against a
 * `chunkCount` on the right-hand side. Wide on purpose - a new copy will not be written in the same
 * shape as the three below - with the other rules that share the vocabulary excluded by line content.
 */
const FULLY_VECTORIZED = /vectorizedChunkCount\b[^;]*>=|>=\s*[A-Za-z0-9_.]*\bchunkCount\b/;

/**
 * A copy that binds BOTH counters out of the file before comparing them, which puts no counter on
 * the comparison line for FULLY_VECTORIZED to find. Matches the BINDING line rather than the
 * comparison, which is still inside the predicate - so the clause check below reads the same region
 * either way. Renaming in the pattern (`{ chunkCount: total }`) still spells both field names, which
 * is what makes this catchable at all.
 *
 * BOTH counters are required, not just the vectorized one: `vectorizedChunkCount` alone appears in
 * every `$set`, projection and stats aggregate that touches the field, none of which compare anything.
 */
const bindsBothCounters = (text: string) =>
  /\{[^}]*\bvectorizedChunkCount\b[^}]*\}/.test(text) && /\bchunkCount\b/.test(text);

/**
 * Matches that are a DIFFERENT question about the same two counters. Line-content rules rather than
 * path exemptions, so an exempted file still trips on a genuinely new reachability copy.
 */
const NOT_THIS_RULE: { pattern: RegExp; reason: string }[] = [
  {
    pattern: /isFileVectorized\s*=/,
    reason:
      'The vectorize queue handler deciding whether the file it just processed is complete. It ' +
      'WRITES the state this rule later reads; it is not a retrieval gate.',
  },
  {
    pattern: /vectorizedChunkCount\s*===\s*null/,
    reason:
      'Lake-health P3 (b4m-core/common/src/constants/lakeHealth.ts) asking whether indexing has ' +
      'SETTLED - an absent count settles, where reachability treats it as not yet reachable.',
  },
  {
    pattern: /embeddedChunkCount\s*>=/,
    reason:
      'Lake-health counts chunk rows that truly carry a vector, which deliberately excludes the ' +
      'oversized-unembeddable chunks `vectorizedChunkCount` counts as terminal.',
  },
  {
    pattern: /embedded\s*!==\s*null\s*&&\s*embedded\s*>=\s*chunkCount/,
    reason:
      'describeKnowledgeBase summarizeHealth: same lake-health settledness question as the ' +
      'embeddedChunkCount entry above (its own docblock says so), just destructured to a local ' +
      '`embedded` name instead of the field name.',
  },
  {
    pattern: /\$lt:\s*\[/,
    reason:
      'A Mongo aggregation asking the INVERSE question - which files are still PARTIALLY vectorized ' +
      '(`vectorizedChunkCount < chunkCount`), for reporting indexing progress. Reachability is the ' +
      '>= direction; these two can never be satisfied at once. Only reachable via ' +
      'DESTRUCTURED_COUNTERS, which sees any object literal naming the counter.',
  },
];

/**
 * The clauses that must sit in the SAME predicate as the fully-vectorized comparison. Spelled as the
 * SYMBOLS the predicate has to mention, because that is what survives a rewrite: an author may swap
 * an early return for a conjunction, rename the local, or reorder the tests, and the rule is still
 * intact so long as the predicate still reads these fields.
 *
 * `embeddingModel` is deliberately absent. `isCapturableFile` omits that clause on purpose, so
 * requiring it here would fail a copy that is correct - and it is already guarded, for the two sites
 * that do carry it, by checkEmbeddingModelComparisonSites.
 */
const REQUIRED_CLAUSES: { clause: string; symbols: string[]; why: string }[] = [
  {
    clause: 'live',
    symbols: ['deletedAt', 'archivedAt'],
    why: 'a soft-deleted or archived doc is not retrievable at all, however well vectorized it is',
  },
  {
    clause: 'retrieval-excluded',
    symbols: ['isRetrievalExcluded'],
    why: 'the session filter is enforced on BOTH search arms, so a doc it excludes is unreachable too',
  },
];

const SELF_PATH = path.relative(REPO_ROOT, fileURLToPath(import.meta.url)).replace(/\\/g, '/'); // normalize on Windows

const isTestFile = (file: string) => /\.test\.[cm]?tsx?$/.test(file) || file.includes('__tests__/');
const isCommentLine = (text: string) => /^\s*(\/\/|\/\*|\*)/.test(text);

/**
 * Drop a trailing `//` comment before matching. Unlike the embeddingModel sibling, this rule's
 * vocabulary reads as ordinary English ("rows >= chunkCount"), so it turns up in prose ANNOTATING a
 * line of code rather than only in whole comment lines. Crude about a `//` inside a string literal,
 * which would only ever cost a match this tripwire was not going to find anyway.
 */
const stripTrailingComment = (text: string) => text.replace(/\/\/.*$/, '');

type ReachabilityHit = { location: string; path: string; line: number; text: string };

/**
 * Every fully-vectorized gate in the tree, as `path:line` plus the source text.
 *
 * Roots include `infra` and the repo-root `scripts` alongside the three the sibling guard scans, so a
 * copy written outside the packages is visible here. `premium` stays excluded for the reason
 * checkEmbeddingModelComparisonSites gives: that mount is a separate repo and is not always present.
 */
function findReachabilitySites(): ReachabilityHit[] {
  const out = execSync(
    // `[cC]` because the clause is usually spelled `vectorizedChunkCount`, which a lowercase
    // `chunkCount` prefilter walks straight past.
    'grep -rn -E "[cC]hunkCount" --include="*.ts" --include="*.tsx" --include="*.mts" --include="*.cts" ' +
      '--exclude-dir=node_modules --exclude-dir=premium --exclude-dir=dist --exclude-dir=.next ' +
      'apps/client b4m-core packages infra scripts || true',
    { cwd: REPO_ROOT, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 }
  );

  return out
    .split('\n')
    .filter(Boolean)
    .map(line => {
      const match = /^([^:]+):(\d+):(.*)$/.exec(line);
      return match ? { path: match[1], line: Number(match[2]), text: match[3] } : null;
    })
    .filter((hit): hit is { path: string; line: number; text: string } => hit !== null)
    .filter(hit => hit.path !== SELF_PATH && !isTestFile(hit.path))
    .filter(hit => !isCommentLine(hit.text))
    .map(hit => ({ ...hit, text: stripTrailingComment(hit.text) }))
    .filter(hit => FULLY_VECTORIZED.test(hit.text) || bindsBothCounters(hit.text))
    .filter(hit => !NOT_THIS_RULE.some(exclusion => exclusion.pattern.test(hit.text)))
    .map(hit => ({ location: `${hit.path}:${hit.line}`, path: hit.path, line: hit.line, text: hit.text.trim() }));
}

/** Character offset of the first non-whitespace character on a 1-based line, or null if there is none. */
function firstCodeOffset(source: ts.SourceFile, line: number): number | null {
  const starts = source.getLineStarts();
  if (line < 1 || line > starts.length) return null;
  const text = source.getFullText();
  const end = line < starts.length ? starts[line] : text.length;
  const offset = text.slice(starts[line - 1], end).search(/\S/);
  return offset === -1 ? null : starts[line - 1] + offset;
}

/** The deepest node covering an offset. */
function nodeAt(source: ts.SourceFile, offset: number): ts.Node {
  let deepest: ts.Node = source;
  const visit = (node: ts.Node) => {
    if (node.getStart(source) > offset || offset >= node.getEnd()) return;
    deepest = node;
    node.forEachChild(visit);
  };
  source.forEachChild(visit);
  return deepest;
}

const isFunctionLike = (node: ts.Node) =>
  ts.isFunctionDeclaration(node) ||
  ts.isFunctionExpression(node) ||
  ts.isArrowFunction(node) ||
  ts.isMethodDeclaration(node);

/**
 * The body of the INNERMOST function enclosing an offset. Innermost on purpose: climbing further
 * out buys nothing but false confidence, since a wide enough region reaches symbols the predicate
 * does not read and the check goes vacuous - which is the failure this whole test exists to close.
 */
function enclosingPredicateBody(source: ts.SourceFile, offset: number): ts.Node | null {
  for (let node: ts.Node | undefined = nodeAt(source, offset); node; node = node.parent) {
    if (isFunctionLike(node)) return (node as ts.FunctionLikeDeclaration).body ?? null;
  }
  return null;
}

/**
 * Every identifier named inside a node. Identifiers and not raw text, so a clause mentioned in a
 * COMMENT or a string literal inside the predicate does not satisfy the requirement - a docblock
 * describing the live clause is exactly what a deleted live clause leaves behind.
 */
function identifiersIn(node: ts.Node): Set<string> {
  const names = new Set<string>();
  const visit = (current: ts.Node) => {
    if (ts.isIdentifier(current)) names.add(current.text);
    current.forEachChild(visit);
  };
  visit(node);
  return names;
}

/**
 * Which required clauses are missing from the predicate enclosing `line`, as reader-facing lines.
 * Empty means the clause set is intact.
 *
 * Fails CLOSED: a comparison that sits in no function at all is reported rather than skipped, so a
 * refactor that moves the rule somewhere this cannot read is a failure and not a silent pass.
 */
export function missingClauses(filePath: string, sourceText: string, line: number): string[] {
  const source = ts.createSourceFile(filePath, sourceText, ts.ScriptTarget.Latest, /* setParentNodes */ true);
  const offset = firstCodeOffset(source, line);
  if (offset === null) return [`${filePath}:${line}: no code on this line - the site list is out of date.`];

  const body = enclosingPredicateBody(source, offset);
  if (body === null) {
    return [
      `${filePath}:${line}: this gate is not inside any function, so its clause set cannot be read. ` +
        'Keep the reachability rule in a predicate.',
    ];
  }

  const names = identifiersIn(body);
  return REQUIRED_CLAUSES.filter(clause => !clause.symbols.every(symbol => names.has(symbol))).map(
    clause =>
      `${filePath}:${line}: the ${clause.clause} clause (${clause.symbols.join(' + ')}) is missing from the ` +
      `predicate holding this gate - ${clause.why}.`
  );
}

describe('the lake reachability clause set moves in lockstep', () => {
  it('has no fully-vectorized gate outside the canonical list', () => {
    const registered = new Set(SITES.map(site => site.path));
    const unexpected = findReachabilitySites()
      .filter(hit => !registered.has(hit.path))
      .map(hit => `${hit.location}  ${hit.text}`);

    expect(
      unexpected,
      'A new site gates on "fully vectorized". If it is asking whether RETRIEVAL can reach the doc, ' +
        'it is a fourth copy of the reachability rule: register it in SITES here and give it a ' +
        'MUST STAY IN SYNC pointer naming one of the others. If it is asking a different question ' +
        'about the same counters (has indexing settled, did this vectorize finish), add a ' +
        'NOT_THIS_RULE entry saying so.'
    ).toEqual([]);
  });

  it('has no gate added to or removed from a listed site', () => {
    const found = findReachabilitySites();
    const drift = SITES.filter(site => found.filter(hit => hit.path === site.path).length !== site.matches).map(
      site => `${site.path}: expected ${site.matches}, found ${found.filter(hit => hit.path === site.path).length}`
    );

    expect(
      drift,
      'The number of fully-vectorized gates inside an already-listed file changed. Update `matches` ' +
        'and the note, or fold the new gate into the existing one.'
    ).toEqual([]);
  });

  it('keeps the live and retrieval-excluded clauses in the predicate that gates on fully vectorized', () => {
    // Registered sites only. An UNREGISTERED hit is the first test's business: it may not be a copy
    // of this rule at all, and demanding the rule's clauses of it would be a second, wrong failure.
    const registered = new Set(SITES.map(site => site.path));
    const sources = new Map<string, string>();
    const findings = findReachabilitySites()
      .filter(hit => registered.has(hit.path))
      .flatMap(hit => {
        const source = sources.get(hit.path) ?? readFileSync(path.join(REPO_ROOT, hit.path), 'utf8');
        sources.set(hit.path, source);
        return missingClauses(hit.path, source, hit.line);
      });

    expect(
      findings,
      'A copy of the reachability rule lost a clause. The three conditions are one rule - a doc that ' +
        'is archived, or excluded by the session filter, is unreachable no matter how well vectorized ' +
        'it is, so a predicate keeping only the vector condition widens what gets deferred, cited or ' +
        'scored. Restore the clause, or if this gate genuinely asks a different question, move it out ' +
        'of SITES and add a NOT_THIS_RULE entry.'
    ).toEqual([]);
  });

  it('lets a reader who finds one copy find the others', () => {
    const orphans = SITES.filter(site => {
      const source = readFileSync(path.join(REPO_ROOT, site.path), 'utf8');
      return !SITES.some(other => other.path !== site.path && source.includes(path.basename(other.path)));
    }).map(site => site.path);

    expect(
      orphans,
      'This copy of the reachability rule names none of the others, so whoever edits it gets no ' +
        'signal that two more must move with it. Add a MUST STAY IN SYNC comment naming a sibling.'
    ).toEqual([]);
  });
});

/**
 * The clause check against known-bad predicates.
 *
 * A guard that cannot fail is worse than no guard, because it reads as coverage. These pin the two
 * ways this check could go vacuous - a clause surviving only as prose, and a clause living elsewhere
 * in the file - which are exactly the two cheap "fixes" the region scoping exists to rule out.
 */
describe('missingClauses', () => {
  const PREDICATE = [
    'export function isCapturableFile(file: F, opts: O = {}): boolean {', // 1
    '  if (file.deletedAt || file.archivedAt) return false;', //             2
    '  if (isRetrievalExcluded(file, opts)) return false;', //               3
    '  const chunks = file.chunkCount ?? 0;', //                             4
    '  return chunks > 0 && (file.vectorizedChunkCount ?? 0) >= chunks;', // 5
    '}', //                                                                 6
  ];
  const GATE_LINE = 5;
  const build = (lines: string[]) => lines.join('\n');

  it('passes an intact predicate', () => {
    expect(missingClauses('f.ts', build(PREDICATE), GATE_LINE)).toEqual([]);
  });

  it('catches a deleted live clause', () => {
    const source = build(PREDICATE.filter(line => !line.includes('deletedAt')));
    expect(missingClauses('f.ts', source, GATE_LINE - 1)).toEqual([expect.stringContaining('live clause')]);
  });

  it('catches a deleted retrieval-excluded clause', () => {
    const source = build(PREDICATE.filter(line => !line.includes('isRetrievalExcluded')));
    expect(missingClauses('f.ts', source, GATE_LINE - 1)).toEqual([
      expect.stringContaining('retrieval-excluded clause'),
    ]);
  });

  it('does not accept a clause that survives only as a comment', () => {
    const source = build(
      PREDICATE.map(line =>
        line.includes('isRetrievalExcluded') ? '  // isRetrievalExcluded is applied by the caller' : line
      )
    );
    expect(missingClauses('f.ts', source, GATE_LINE)).toEqual([expect.stringContaining('retrieval-excluded clause')]);
  });

  it('does not accept a clause that lives elsewhere in the file', () => {
    const source = build([
      'function somethingElse(file: F, opts: O) {',
      '  return !file.deletedAt && !file.archivedAt && !isRetrievalExcluded(file, opts);',
      '}',
      ...PREDICATE.filter(line => !line.includes('deletedAt') && !line.includes('isRetrievalExcluded')),
    ]);
    // The gate now sits on the last line of the trimmed predicate, inside a function that reads neither clause.
    const gateLine = source.split('\n').findIndex(line => line.includes('vectorizedChunkCount')) + 1;
    expect(missingClauses('f.ts', source, gateLine)).toEqual([
      expect.stringContaining('live clause'),
      expect.stringContaining('retrieval-excluded clause'),
    ]);
  });

  it('fails closed on a gate that sits at module scope', () => {
    const source = build([
      'const chunks = file.chunkCount ?? 0;',
      'const ok = (file.vectorizedChunkCount ?? 0) >= chunks;',
    ]);
    expect(missingClauses('f.ts', source, 2)).toEqual([expect.stringContaining('not inside any function')]);
  });
});
