import { describe, it, expect } from 'vitest';
import { execSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
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
 * The site half reads three spellings of the comparison, because a copy is only as findable as the
 * narrowest of them: the counter named on the comparison line (FULLY_VECTORIZED), both counters
 * destructured on one line (`bindsBothCounters`), and both counters read into locals by member access
 * first (`findMemberAccessGates`). The last is the shape #2503 records, and the only one no line rule
 * can reach - its comparison line names neither field, so the grep prefilter never emits it at all.
 * What is still NOT covered is a copy that spells the comparison across a boundary none of the three
 * follow - a helper taking two numbers, a counter carried through an object field. Those stay
 * invisible, which is the honest limit of a grep-and-AST tripwire over duplicated logic.
 *
 * Why the clause half is AST-scoped and not a wider regex: the clauses sit on their OWN lines (and
 * as a bare conjunction in one of the three copies rather than an early return), so a line-oriented
 * detector cannot see them however wide it is. A file-scoped symbol search would see them and be
 * vacuous - two of the three sites mention these symbols outside the predicate, so it would pass on
 * a predicate that had lost the clause entirely. It is narrower still than the enclosing function:
 * only what the predicate APPLIES counts (see appliedIdentifiers), so a clause left computed in a
 * local that nothing returns or branches on is a failure rather than a pass.
 *
 * KNOWN RESIDUALS, listed because a tripwire that hides its blind spots reads as coverage:
 *  - A clause satisfied by a bare MENTION. The clause half tests symbol presence, so an applied
 *    object literal spelling the names (`return { deletedAt, archivedAt } && ...`) passes without
 *    testing anything. Inherent to symbol matching; scoping to applied expressions narrows it but
 *    does not close it, and a green run here is evidence the clause is NAMED, not that it is enforced.
 *  - A gate line that starts INSIDE a wrapped callback. `enclosingPredicateBody` takes the innermost
 *    function, so if formatting puts the comparison in a nested arrow whose body does not carry the
 *    clauses, both report missing on a rule that is intact. It fails CLOSED - a red build on correct
 *    code, never a silent pass - and the fix is to name the clauses in that region or hoist the gate.
 *  - `isFileVectorized =` (NOT_THIS_RULE) exempts by NAME, tree-wide. Today its one hit is the
 *    write-side vectorize handler the reason text describes, but that is also a natural name for a
 *    new reachability gate, which would then be exempted anywhere. Kept a line-content rule rather
 *    than a path exemption on purpose - see NOT_THIS_RULE's note - so tighten the pattern, not the
 *    path, if it ever swallows a real copy.
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

/** The two counter fields, for the AST detector below. */
const COUNTERS = { vectorized: 'vectorizedChunkCount', total: 'chunkCount' } as const;

/**
 * Locals that `body` binds to a member access of `field`, including the `?? 0` and optional-chaining
 * wrappers these gates are usually written with. A declaration naming BOTH counters is skipped: that
 * is a comparison being stored under a name, not a counter being bound.
 */
function localsBoundToField(body: ts.Node, field: string, otherField: string): Set<string> {
  const bound = new Set<string>();
  const visit = (node: ts.Node) => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      const names = identifiersIn(node.initializer);
      if (names.has(field) && !names.has(otherField)) bound.add(node.name.text);
    }
    node.forEachChild(visit);
  };
  visit(body);
  return bound;
}

/**
 * The third spelling, and the one #2503 actually records: BOTH counters read into locals by member
 * access first, so the comparison spells neither field name and the `[cC]hunkCount` prefilter never
 * even emits that line, let alone matches it.
 *
 *     const done = f.vectorizedChunkCount;
 *     const total = f.chunkCount;
 *     return done >= total;
 *
 * Function-scoped and not a line rule, because that IS the difficulty: the evidence that this is the
 * reachability comparison is spread over three lines. Both operands must be locals bound by member
 * access - a copy with a counter still on the comparison line is FULLY_VECTORIZED's, and one that
 * destructures is `bindsBothCounters`'.
 */
function findMemberAccessGates(source: ts.SourceFile): number[] {
  const lines: number[] = [];
  const inspect = (fn: ts.Node) => {
    const body = (fn as ts.FunctionLikeDeclaration).body;
    if (!body) return;
    const vectorized = localsBoundToField(body, COUNTERS.vectorized, COUNTERS.total);
    const total = localsBoundToField(body, COUNTERS.total, COUNTERS.vectorized);
    if (vectorized.size === 0 || total.size === 0) return;
    const visit = (node: ts.Node) => {
      if (ts.isBinaryExpression(node) && ts.isIdentifier(node.left) && ts.isIdentifier(node.right)) {
        const operator = node.operatorToken.kind;
        const forward =
          operator === ts.SyntaxKind.GreaterThanEqualsToken &&
          vectorized.has(node.left.text) &&
          total.has(node.right.text);
        const reversed =
          operator === ts.SyntaxKind.LessThanEqualsToken &&
          total.has(node.left.text) &&
          vectorized.has(node.right.text);
        if (forward || reversed) {
          lines.push(source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1);
        }
      }
      node.forEachChild(visit);
    };
    visit(body);
  };
  const walk = (node: ts.Node) => {
    if (isFunctionLike(node)) inspect(node);
    node.forEachChild(walk);
  };
  source.forEachChild(walk);
  return lines;
}

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
      '`bindsBothCounters`, which sees any object literal naming both counters.',
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
 * Where a copy could be written. `premium` stays excluded for the reason checkEmbeddingModelComparison
 * Sites gives: that mount is a separate repo and is not always present. `infra` and the repo-root
 * `scripts` are here and not in the sibling guard, so a copy written outside the packages is visible.
 */
const SCAN_ROOTS = ['apps/client', 'b4m-core', 'packages', 'infra', 'scripts'];

/**
 * Every `[cC]hunkCount` mention under SCAN_ROOTS, as `path:line:text`.
 *
 * `[cC]` because the clause is usually spelled `vectorizedChunkCount`, which a lowercase `chunkCount`
 * prefilter walks straight past.
 *
 * Deliberately NOT `|| true`: that swallows a root that has been renamed or moved out from under this
 * list along with the "no matches" case, which would leave a root silently unscanned on a green suite.
 * grep's exit 1 means "searched, found nothing" and is the only non-zero status accepted here.
 */
function grepCounterMentions(): string {
  const missing = SCAN_ROOTS.filter(root => !existsSync(path.join(REPO_ROOT, root)));
  if (missing.length > 0) {
    throw new Error(
      `Scan roots no longer exist: ${missing.join(', ')}. A renamed root drops out of discovery ` +
        'silently, so update SCAN_ROOTS rather than letting the grep miss it.'
    );
  }
  try {
    return execSync(
      'grep -rn -E "[cC]hunkCount" --include="*.ts" --include="*.tsx" --include="*.mts" --include="*.cts" ' +
        '--exclude-dir=node_modules --exclude-dir=premium --exclude-dir=dist --exclude-dir=.next ' +
        SCAN_ROOTS.join(' '),
      { cwd: REPO_ROOT, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 }
    );
  } catch (error) {
    if ((error as { status?: number }).status === 1) return '';
    throw error;
  }
}

/** A file this guard is willing to read a gate out of: not a test, and not this guard itself. */
const isScannableFile = (filePath: string) => filePath !== SELF_PATH && !isTestFile(filePath);

/**
 * Every fully-vectorized gate in the tree, as `path:line` plus the source text.
 *
 * Two passes over the same grep, because the three spellings are not all visible to the same kind of
 * rule: the line pass matches FULLY_VECTORIZED / `bindsBothCounters` against the text grep emitted,
 * and the AST pass re-reads the files that mention `vectorizedChunkCount` to find the member-access
 * shape, whose comparison line grep never emits at all. Unioned and de-duplicated by `path:line`, so
 * a gate both passes can see is still one gate.
 */
function findReachabilitySites(): ReachabilityHit[] {
  const mentions = grepCounterMentions()
    .split('\n')
    .filter(Boolean)
    .map(line => {
      const match = /^([^:]+):(\d+):(.*)$/.exec(line);
      return match ? { path: match[1], line: Number(match[2]), text: match[3] } : null;
    })
    .filter((hit): hit is { path: string; line: number; text: string } => hit !== null)
    .filter(hit => isScannableFile(hit.path));

  const lineHits = mentions
    .filter(hit => !isCommentLine(hit.text))
    .map(hit => ({ ...hit, text: stripTrailingComment(hit.text) }))
    .filter(hit => FULLY_VECTORIZED.test(hit.text) || bindsBothCounters(hit.text));

  // Only files that mention the vectorized counter at all, so the parse cost stays on the handful of
  // files that could hold a copy rather than every file naming `chunkCount`.
  const candidates = [...new Set(mentions.filter(hit => hit.text.includes(COUNTERS.vectorized)).map(hit => hit.path))];
  const astHits = candidates.flatMap(filePath => {
    const sourceText = readFileSync(path.join(REPO_ROOT, filePath), 'utf8');
    const source = ts.createSourceFile(filePath, sourceText, ts.ScriptTarget.Latest, /* setParentNodes */ true);
    const lines = sourceText.split('\n');
    return findMemberAccessGates(source).map(line => ({ path: filePath, line, text: lines[line - 1] ?? '' }));
  });

  const byLocation = new Map<string, ReachabilityHit>();
  for (const hit of [...lineHits, ...astHits]) {
    if (NOT_THIS_RULE.some(exclusion => exclusion.pattern.test(hit.text))) continue;
    const location = `${hit.path}:${hit.line}`;
    if (!byLocation.has(location)) {
      byLocation.set(location, { location, path: hit.path, line: hit.line, text: hit.text.trim() });
    }
  }
  return [...byLocation.values()];
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
 * The expressions a predicate body actually APPLIES: what it returns, and what it branches or throws
 * on. Everything else in the body is computation, which may or may not reach the outcome.
 *
 * Nested callbacks are walked rather than skipped: a predicate is free to spell a clause inside a
 * `.some()`, and failing that copy would be a wrong failure.
 */
function appliedExpressions(body: ts.Node): ts.Node[] {
  if (!ts.isBlock(body)) return [body]; // concise arrow body - the expression IS the outcome
  const roots: ts.Node[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isReturnStatement(node) && node.expression) roots.push(node.expression);
    else if (ts.isIfStatement(node) || ts.isWhileStatement(node) || ts.isDoStatement(node)) roots.push(node.expression);
    else if (ts.isConditionalExpression(node)) roots.push(node.condition);
    else if (ts.isThrowStatement(node) && node.expression) roots.push(node.expression);
    node.forEachChild(visit);
  };
  visit(body);
  return roots;
}

/**
 * The identifiers the predicate applies: those named in an applied expression, plus - transitively -
 * those in the initializer of any local such an expression names.
 *
 * Following the locals is what lets a predicate compute a clause into a `const` and still count (the
 * corpus defer gate binds `liveAndReachable` before using it). Starting from the APPLIED expressions
 * rather than the whole body is what stops a clause that is still computed but no longer applied from
 * passing: drop `&& liveAndReachable` from that gate's return and nothing reaches the binding, so the
 * clause reports missing - where a body-wide symbol search would happily still find it.
 */
function appliedIdentifiers(body: ts.Node): Set<string> {
  const initializers = new Map<string, ts.Node>();
  const collect = (node: ts.Node) => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      initializers.set(node.name.text, node.initializer);
    }
    node.forEachChild(collect);
  };
  collect(body);

  const applied = new Set<string>();
  const pending = appliedExpressions(body);
  while (pending.length > 0) {
    for (const name of identifiersIn(pending.pop() as ts.Node)) {
      if (applied.has(name)) continue;
      applied.add(name);
      const initializer = initializers.get(name);
      if (initializer) pending.push(initializer);
    }
  }
  return applied;
}

/**
 * Which required clauses are missing from the predicate enclosing `line`, as reader-facing lines.
 * Empty means the clause set is intact.
 *
 * Fails CLOSED: a comparison that sits in no function at all is reported rather than skipped, so a
 * refactor that moves the rule somewhere this cannot read is a failure and not a silent pass.
 */
function missingClauses(filePath: string, sourceText: string, line: number): string[] {
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

  const names = appliedIdentifiers(body);
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

  it('does not accept a clause that is computed but no longer applied', () => {
    // The shape the corpus defer gate is written in: the clause is bound to a local, and the local is
    // what the return names. Dropping it from the return leaves the binding - and every symbol in it -
    // sitting in the body, which is what a body-wide search would keep finding.
    const source = build([
      'export function isCapturableFile(file: F, opts: O = {}): boolean {',
      '  const live = !file.deletedAt && !file.archivedAt && !isRetrievalExcluded(file, opts);',
      '  const chunks = file.chunkCount ?? 0;',
      '  return chunks > 0 && (file.vectorizedChunkCount ?? 0) >= chunks;',
      '}',
    ]);
    expect(missingClauses('f.ts', source, 4)).toEqual([
      expect.stringContaining('live clause'),
      expect.stringContaining('retrieval-excluded clause'),
    ]);
  });

  it('accepts that same clause while the return still names its local', () => {
    const source = build([
      'export function isCapturableFile(file: F, opts: O = {}): boolean {',
      '  const live = !file.deletedAt && !file.archivedAt && !isRetrievalExcluded(file, opts);',
      '  const chunks = file.chunkCount ?? 0;',
      '  return live && chunks > 0 && (file.vectorizedChunkCount ?? 0) >= chunks;',
      '}',
    ]);
    expect(missingClauses('f.ts', source, 4)).toEqual([]);
  });

  it('fails closed on a gate that sits at module scope', () => {
    const source = build([
      'const chunks = file.chunkCount ?? 0;',
      'const ok = (file.vectorizedChunkCount ?? 0) >= chunks;',
    ]);
    expect(missingClauses('f.ts', source, 2)).toEqual([expect.stringContaining('not inside any function')]);
  });
});

/**
 * The SITE detectors against the two evasions they exist for.
 *
 * Same argument as the clause fixtures above: a detector that cannot fire reads as coverage. Neither
 * of these is pinned by the repo scan - the tree contains no copy in either shape, so neutering them
 * leaves the suite green, which is exactly the state this file warns about.
 */
describe('gate detection', () => {
  const gateLines = (lines: string[]) =>
    findMemberAccessGates(ts.createSourceFile('f.ts', lines.join('\n'), ts.ScriptTarget.Latest, true));

  it('sees a copy that binds both counters by member access, whose comparison names neither', () => {
    // The shape #2503 records. `[cC]hunkCount` does not even emit line 4, so no line rule however
    // wide can reach it - which is why this detector is AST-scoped.
    expect(
      gateLines([
        'export function probe(file: F): boolean {',
        '  const done = file.vectorizedChunkCount ?? 0;',
        '  const total = file.chunkCount ?? 0;',
        '  return total > 0 && done >= total;',
        '}',
      ])
    ).toEqual([4]);
  });

  it('sees a copy that destructures both counters', () => {
    expect(bindsBothCounters('  const { vectorizedChunkCount: done, chunkCount: total } = file;')).toBe(true);
  });

  it('leaves the writes and reports that name the counters without comparing them', () => {
    // BOTH counters are required for a reason: `vectorizedChunkCount` alone appears in every $set,
    // projection and stats aggregate that touches the field, and none of those gate anything.
    expect(bindsBothCounters('  await FabFile.updateOne({ _id }, { $set: { vectorizedChunkCount: n } });')).toBe(false);
    expect(
      gateLines([
        'export function report(file: F): number {',
        '  const done = file.vectorizedChunkCount ?? 0;',
        '  const total = file.chunkCount ?? 0;',
        '  return total - done;',
        '}',
      ])
    ).toEqual([]);
  });
});
