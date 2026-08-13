import { describe, it, expect } from 'vitest';
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

/**
 * Guards the FabFile.embeddingModel exact-match lockstep. Several independent readers compare a
 * file's recorded embedding label to the query's as an exact string, and each holds its OWN copy of
 * the rule rather than calling isForeignEmbeddingModel. Relaxing one does not propagate - it makes
 * the sites DIVERGE, and the symptom is silent: a correctly-embedded file stops being retrievable
 * and the user is told to re-embed it. Nothing crashes.
 *
 * So the rule has to move across every site in lockstep or not at all, and until this test existed
 * the only thing saying so was a docstring. This makes an unregistered site fail loudly instead.
 *
 * NOT a push toward uniformity: sites 2 and 3 are deliberately STRICTER than the predicate (they
 * count an unlabeled file as unreachable where it scores one), and their own comments explain why
 * they must not be consolidated. The guard protects the SET, not sameness within it.
 */
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

const PREDICATE_FILE = 'b4m-core/services/src/dataLakeService/embeddingMismatch.ts';

/**
 * The canonical list, kept in step with the isForeignEmbeddingModel docstring (asserted below).
 * `matches` is how many CODE lines in that file the patterns below hit, so a comparison added or
 * removed inside an ALREADY-listed file is caught too - the likeliest drift here, since the two
 * client sites are already near-duplicates of each other.
 */
const SITES: { path: string; matches: number; note: string }[] = [
  {
    path: PREDICATE_FILE,
    matches: 0,
    // The predicate compares its own parameters (`parent !== queryModel.trim()`), so the token
    // `embeddingModel` never appears beside the operator and the patterns cannot see it. Listed
    // anyway because it is site 1 of the rule, and its docstring is what the second test reads.
    note: 'isForeignEmbeddingModel - the shared predicate. Absent/blank label counts as NOT foreign',
  },
  {
    path: 'b4m-core/services/src/llm/ChatCompletionProcess.ts',
    matches: 1,
    note: 'Corpus defer gate. Deliberately STRICTER: an unlabeled file counts as unreachable',
  },
  {
    path: 'apps/client/server/memory/lakeSourceReachability.ts',
    matches: 1,
    note: 'isFabFileCitable. Deliberately STRICTER, same reason',
  },
  {
    path: 'packages/database/src/models/content/FabFileModel.ts',
    matches: 1,
    note: 'Atlas $vectorSearch filter clause - the match happens inside the database',
  },
  {
    path: 'b4m-core/services/src/dataLakeService/openSearchChunkAdapter.ts',
    matches: 1,
    note: 'Self-host OpenSearch term clause - the same rule on the other backend',
  },
  {
    path: 'apps/client/app/components/Session/AISettings/FilesSection.tsx',
    matches: 1,
    note: 'Client badge: drives the per-file reprocess affordance. Misleads rather than loses content',
  },
  {
    path: 'apps/client/app/hooks/useEmbeddingMismatchStatus.ts',
    matches: 1,
    note: 'Client badge: reddens the session-toolbar file count. Same tier as FilesSection',
  },
];

/**
 * An inline `===`/`!==` against something named embeddingModel, in either operand order. The
 * capital-E alternative matters: it also catches a comparison whose operands are only ever spelled
 * `queryEmbeddingModel`/`currentEmbeddingModel`, which the bare lowercase token would walk past.
 * It costs nothing today - both spellings select the same 4 lines.
 */
const INLINE_COMPARISON = /[eE]mbeddingModel['"]?\s*(===|!==)|(===|!==)\s*[A-Za-z0-9_.]*[eE]mbeddingModel\b/;

/**
 * An embeddingModel key inside a search-filter clause, which is how the two vector backends express
 * the same comparison. Requires the filter context on the same line, so ordinary assignments
 * (`embeddingModel: defaultEmbeddingModel`) and type annotations do not trip it. Known limit: a
 * filter clause split across lines evades this, which is why the docstring stays the canonical
 * list - this test is a tripwire, not a proof.
 */
const FILTER_CLAUSE = /['"]?(metadata\.)?embeddingModel['"]?\s*:\s*[a-z]\w*/;
const FILTER_CONTEXT = /\b(filter|term|terms|match)\b/;

/**
 * Matches that are NOT this rule. Line-content rules rather than path exemptions on purpose: an
 * exempted PATH would also hide a genuinely new comparison added to that same file.
 */
const NOT_THIS_RULE: { pattern: RegExp; reason: string }[] = [
  {
    pattern: /MEMENTO_EMBEDDING_(ID|MODEL)/,
    reason:
      'The memento corpus is deliberately decoupled and pinned to its own model - see the ' +
      'MEMENTO_EMBEDDING_MODEL rationale in b4m-core/common/src/schemas/embedding.ts. Not this rule.',
  },
  {
    pattern: /\.embedding\.model\b/,
    reason:
      'Session-message embeddings (`message.embedding.model`) are a different field on a different ' +
      'corpus, not FabFile.embeddingModel.',
  },
  {
    pattern: /typeof\s+[A-Za-z0-9_.]*[eE]mbeddingModel\s*(===|!==)/,
    reason: 'A typeof guard on the queue payload, not a comparison of one model to another.',
  },
  {
    pattern: /(?<![.\w])embeddingModel\s*!==\s*defaultEmbeddingModelForEnv\(\)/,
    reason:
      'Compares the QUERY model to the deployment default for a telemetry warning. No file label ' +
      'is involved; a `file.embeddingModel` form still trips the guard.',
  },
];

// This file's own path relative to REPO_ROOT, so it excludes itself by exact match rather than by
// basename (grep's --exclude matches any file with this name, anywhere in the tree).
const SELF_PATH = path.relative(REPO_ROOT, fileURLToPath(import.meta.url)).replace(/\\/g, '/'); // normalize on Windows

const isTestFile = (file: string) => /\.test\.[cm]?tsx?$/.test(file) || file.includes('__tests__/');

// Comment lines carry the canonical list itself and the sites' own explanatory notes, which quote
// the comparisons verbatim. Counting them would make every site self-trip.
const isCommentLine = (text: string) => /^\s*(\/\/|\/\*|\*)/.test(text);

/**
 * Every embeddingModel comparison in the tree, as `path:line` plus the source text.
 *
 * `packages/premium` is excluded: those overlays are private repos hydrated into this tree locally
 * and absent in CI, so grepping them would make this test's result depend on whether a developer
 * has them installed.
 *
 * The three roots mirror the checkNoRawS3Client precedent and cover every source tree today
 * (`apps/` holds only `client`; blueprints/data/docs/docs-site/infra/scripts/selfhost contain no
 * embeddingModel). A NEW top-level workspace directory would be invisible here - add it to the
 * grep if one appears.
 */
function findComparisonSites(): { location: string; path: string; text: string }[] {
  const out = execSync(
    // `[eE]` so the prefilter also admits `queryEmbeddingModel`-style spellings; the JS patterns
    // below do the real selecting, and a case-sensitive grep here would silently starve them.
    'grep -rn -E "[eE]mbeddingModel" --include="*.ts" --include="*.tsx" --include="*.mts" --include="*.cts" ' +
      '--exclude-dir=node_modules --exclude-dir=premium --exclude-dir=dist --exclude-dir=.next ' +
      'apps/client b4m-core packages || true',
    { cwd: REPO_ROOT, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 }
  );

  return out
    .split('\n')
    .filter(Boolean)
    .map(line => {
      const match = /^([^:]+):(\d+):(.*)$/.exec(line);
      return match ? { path: match[1], line: match[2], text: match[3] } : null;
    })
    .filter((hit): hit is { path: string; line: string; text: string } => hit !== null)
    .filter(hit => hit.path !== SELF_PATH && !isTestFile(hit.path))
    .filter(hit => !isCommentLine(hit.text))
    .filter(hit => INLINE_COMPARISON.test(hit.text) || (FILTER_CLAUSE.test(hit.text) && FILTER_CONTEXT.test(hit.text)))
    .filter(hit => !NOT_THIS_RULE.some(exclusion => exclusion.pattern.test(hit.text)))
    .map(hit => ({ location: `${hit.path}:${hit.line}`, path: hit.path, text: hit.text.trim() }));
}

describe('the embeddingModel exact-match rule moves in lockstep', () => {
  it('has no comparison site outside the canonical list', () => {
    const registered = new Set(SITES.map(site => site.path));
    const unexpected = findComparisonSites()
      .filter(hit => !registered.has(hit.path))
      .map(hit => `${hit.location}  ${hit.text}`);

    expect(
      unexpected,
      'A new site compares FabFile.embeddingModel to the query model. That rule is duplicated, not ' +
        'shared, so it has to move across every site in lockstep or not at all. Either register the ' +
        'site in SITES here AND in the isForeignEmbeddingModel canonical list ' +
        `(${PREDICATE_FILE}), or add a NOT_THIS_RULE entry saying why it is a different rule. Do NOT ` +
        'resolve this by consolidating the sites onto isForeignEmbeddingModel: the defer gate and ' +
        'isFabFileCitable are deliberately stricter than it, and folding them in loosens them in the ' +
        'content-losing direction.'
    ).toEqual([]);
  });

  it('has no comparison added to or removed from a listed site', () => {
    const found = findComparisonSites();
    const drift = SITES.filter(site => found.filter(hit => hit.path === site.path).length !== site.matches).map(
      site => `${site.path}: expected ${site.matches}, found ${found.filter(hit => hit.path === site.path).length}`
    );

    expect(
      drift,
      'The number of embeddingModel comparisons inside an already-listed file changed. If a ' +
        'comparison was added, it is a new copy of the rule: fold it into the existing one or update ' +
        "`matches` and say so in the site's note. If one was removed, update `matches` and the " +
        `canonical list in ${PREDICATE_FILE}.`
    ).toEqual([]);
  });

  it('agrees with the isForeignEmbeddingModel canonical list', () => {
    const source = readFileSync(path.join(REPO_ROOT, PREDICATE_FILE), 'utf8');
    const start = source.indexOf('CANONICAL LIST');
    const end = source.indexOf('export function isForeignEmbeddingModel');

    expect(start, `The CANONICAL LIST marker is gone from ${PREDICATE_FILE}; this test reads it.`).toBeGreaterThan(-1);
    expect(
      end,
      `isForeignEmbeddingModel is gone from ${PREDICATE_FILE}; this test reads its docstring.`
    ).toBeGreaterThan(start);

    const canonicalList = source.slice(start, end);
    const unlisted = SITES.filter(site => site.path !== PREDICATE_FILE).filter(
      site => !canonicalList.includes(site.path)
    );

    expect(
      unlisted.map(site => site.path),
      `Every site listed here must also be named in the CANONICAL LIST docstring in ${PREDICATE_FILE}, ` +
        'so a reader who finds one site finds all of them. Add the missing path there.'
    ).toEqual([]);
  });
});
