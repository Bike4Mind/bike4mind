import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Static-analysis guard: every server-side construction of a `ToolContext['db']` /
 * `ToolBuilderDeps['db']` adapter bundle - the object literal wired into the KB tools
 * (search_knowledge_base, retrieve_knowledge_content) and forced retrieval - must wire
 * `lakeAccessEvents`.
 *
 * The field is OPTIONAL on the type (a lean tool harness with no lake concept degrades to a
 * silent no-op without it), which is exactly what makes a missed site invisible: no type error,
 * no runtime error, no failing existing test - the surface just quietly writes zero audit rows.
 * Confirmed the hard way: two real construction sites (the deep-agent tool materializer and the
 * public embed-chat route) shipped without it and were only caught by a manual code review, not
 * by anything automated. This test is the backstop.
 *
 * Heuristic: a KB-capable db literal is identified by carrying BOTH `fabfiles:` and
 * `fabfilechunks:` as object keys (not `fabFiles`/`fabFileChunks`, which name a different,
 * non-tool-context repository shape used elsewhere) - verified against every file under
 * apps/client/server to match exactly the known construction sites and nothing else.
 *
 * The COUNT is keyed on `dataLakes:`, not on `fabfilechunks:`. `fabfilechunks:` is no longer 1:1
 * with a tool-context bundle: `processFabFilesServer`'s own deps take the same key and wire no
 * lake at all (agentExecutor's attachment materialization), so counting it demanded a
 * `lakeAccessEvents` that would be a dead field there. `dataLakes:` is the key that makes a bundle
 * lake-capable in the first place, which is exactly the population that owes an audit row - it is
 * 1:1 with `lakeAccessEvents:` at every real site today, including agentExecutor's two. This is
 * tighter about intent, not looser: a bundle wiring `dataLakes` without `lakeAccessEvents` still
 * fails, and one wiring neither has no lake access to audit. Scoped to
 * apps/client/server on purpose: b4m-core/services only ever CONSUMES ToolContext, it cannot
 * construct the concrete, @bike4mind/database-backed adapter bundle (the same import-direction
 * rule DataLakeAccessGrantModel and LakeAccessEventModel both split around), so a real
 * construction site can only ever live in apps/client.
 *
 * Pure string parsing - no imports of the modules, no AWS/SST calls. Lives outside `pages/api/`
 * for the same NFT-bundling reason as sessionRedactionGuard.test.ts.
 */

// This test lives at apps/client/server/__tests__ -> repo root is four levels up.
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const SERVER_DIR = resolve(REPO_ROOT, 'apps/client/server');

/** Recursively collect every `.ts` file under apps/client/server, skipping tests. */
const collectServerFiles = (dir: string): string[] => {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = resolve(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === '__tests__') continue;
      out.push(...collectServerFiles(full));
    } else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) {
      out.push(full);
    }
  }
  return out;
};

const isKbCapableDbLiteral = (content: string) => content.includes('fabfiles:') && content.includes('fabfilechunks:');
const countOccurrences = (content: string, needle: string) => content.split(needle).length - 1;

describe('ToolContext db construction sites wire lakeAccessEvents', () => {
  const kbCapableFiles = collectServerFiles(SERVER_DIR)
    .map(file => ({ file, content: readFileSync(file, 'utf8') }))
    .filter(({ content }) => isKbCapableDbLiteral(content));

  it('found at least one KB-capable construction site (sanity check the heuristic still matches)', () => {
    expect(kbCapableFiles.length).toBeGreaterThan(0);
  });

  // Count, not just presence: agentExecutor.ts alone has two separate lake-capable db literals
  // (top-level agent loop + delegated subagent) - a boolean "does the file mention it anywhere"
  // check would stay green even if wiring regressed at just one of the two.
  it.each(kbCapableFiles.map(({ file, content }) => [relative(REPO_ROOT, file), content] as const))(
    '%s wires lakeAccessEvents at every one of its lake-capable db literals',
    (_label, content) => {
      const lakeCapableLiteralCount = countOccurrences(content, 'dataLakes:');
      const wiredCount = countOccurrences(content, 'lakeAccessEvents:');
      expect(wiredCount).toBeGreaterThanOrEqual(lakeCapableLiteralCount);
    }
  );
});
