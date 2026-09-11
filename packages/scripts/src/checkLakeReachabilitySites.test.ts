import { describe, it, expect } from 'vitest';
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

/**
 * Guards the lake REACHABILITY clause set: "live, not retrieval-excluded, and fully vectorized".
 *
 * Sibling of checkEmbeddingModelComparisonSites, and deliberately a second test rather than a wider
 * one. That guard watches the `embeddingModel` exact-match clause; `isCapturableFile` omits that
 * clause on purpose (the comparison harness varies the model), so it is correctly invisible there -
 * and was therefore guarded by nothing. This is the clause set it does share.
 *
 * Same failure shape as its sibling: the rule is duplicated across packages with no shared symbol,
 * relaxing one copy does not propagate, and the symptom is silent - a doc the served path cannot
 * surface gets deferred, cited or scored anyway. Until this existed the only thing saying so was a
 * docblock, and one of the three copies had no pointer aimed at it.
 */
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

/**
 * The three copies. `matches` is how many CODE lines in the file the pattern below hits, so a
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

/**
 * Every fully-vectorized gate in the tree, as `path:line` plus the source text. Same three roots and
 * the same `premium` exclusion as checkEmbeddingModelComparisonSites - see its docblock for why.
 */
function findReachabilitySites(): { location: string; path: string; text: string }[] {
  const out = execSync(
    // `[cC]` because the clause is usually spelled `vectorizedChunkCount`, which a lowercase
    // `chunkCount` prefilter walks straight past.
    'grep -rn -E "[cC]hunkCount" --include="*.ts" --include="*.tsx" --include="*.mts" --include="*.cts" ' +
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
    .map(hit => ({ ...hit, text: stripTrailingComment(hit.text) }))
    .filter(hit => FULLY_VECTORIZED.test(hit.text))
    .filter(hit => !NOT_THIS_RULE.some(exclusion => exclusion.pattern.test(hit.text)))
    .map(hit => ({ location: `${hit.path}:${hit.line}`, path: hit.path, text: hit.text.trim() }));
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
