import { describe, it, expect } from 'vitest';
import { glob } from 'glob';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { loadHelpArticles } from '../loadHelpArticles';
import { chunkByHeadings, estimateTokenCount } from '../utils';
import type { HelpIndex, HelpEmbeddingsIndex } from '../types';
import { ROUTE_HELP_SUGGESTIONS } from '../../../../apps/client/app/components/help/routeHelpSuggestions';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/** Absolute path to the client source tree that hosts every ContextHelpButton. */
const CLIENT_APP_ROOT = path.resolve(__dirname, '../../../../apps/client/app');

/** The generated runtime index - what the help panel can actually resolve. */
const HELP_INDEX_PATH = path.resolve(__dirname, '../../../../apps/client/app/generated/help-index.json');

/** The generated runtime vectors - what the Help AI chat can actually retrieve. */
const HELP_EMBEDDINGS_PATH = path.resolve(__dirname, '../../../../apps/client/app/generated/help-embeddings.json');

/**
 * The three shapes a help slug is hard-coded in. `helpId={expr}` is skipped by
 * construction: the only three indirection sites (`ExperimentalFeatureToggle.tsx`,
 * `SectionContainer.tsx`, `DestructiveActionHelp.tsx`) forward a `helpId?: string`
 * prop, and every caller passes a literal that these patterns catch at the call site.
 *
 * Test files are swept too, deliberately - a fixture slug is as capable of going stale
 * as a production one, and a made-up slug in a fixture should be allowlisted rather
 * than invisible.
 */
const SLUG_LITERAL_PATTERNS = [/helpId=["']([^"']+)["']/g, /openHelpPanel\(['"]([^'"]+)['"]/g];

/**
 * Help ids with no article yet. Each needs content authored (or the id corrected)
 * before it can be removed from this list - until then its help button opens an
 * empty panel. Tracked as follow-up work, not as a licence to add more.
 */
const KNOWN_UNRESOLVED_HELP_IDS = new Set([
  // No admin GitHub-connection article has been written yet.
  'admin/github-connection',
  // No organization GitHub-connection article yet. Note: the fix is a slug under
  // admin/ or features/ - INCLUDED_CATEGORIES never loads an organizations/ path.
  'organizations/github-connection',
  // A bare invented slug with no article and no source to have been copied from:
  // FieldTooltipProps has no key/field prop for this to be pasted from. Needs the
  // right slug, not a new article.
  'image-edit-model',
]);

/** Every hard-coded help slug in the client, as `slug -> where it was found`. */
async function collectReferencedHelpIds(): Promise<Map<string, string[]>> {
  const files = await glob('**/*.{ts,tsx}', {
    cwd: CLIENT_APP_ROOT,
    absolute: true,
    ignore: ['**/node_modules/**'],
  });
  expect(files.length).toBeGreaterThan(0);

  const referenced = new Map<string, string[]>();
  const record = (helpId: string, where: string) => {
    const sites = referenced.get(helpId) ?? [];
    sites.push(where);
    referenced.set(helpId, sites);
  };

  for (const file of files) {
    const source = fs.readFileSync(file, 'utf-8');
    const where = path.relative(CLIENT_APP_ROOT, file);
    for (const pattern of SLUG_LITERAL_PATTERNS) {
      for (const [, helpId] of source.matchAll(pattern)) {
        record(helpId, where);
      }
    }
  }

  // Route suggestions hold their slugs in an array of object properties, which no
  // call-site pattern can see. Imported rather than scanned so the mapping is checked
  // as data.
  for (const suggestion of ROUTE_HELP_SUGGESTIONS) {
    for (const helpId of suggestion.helpIds) {
      record(helpId, `ROUTE_HELP_SUGGESTIONS[${suggestion.path}]`);
    }
  }

  return referenced;
}

/**
 * CI gate: every hard-coded help slug in the client must name a real help article.
 *
 * A help id is a keyed identifier duplicated between the component and the
 * docs-site filename, and nothing else cross-checks them: `useHelpContent` leaves
 * the query disabled for an unknown slug, so a stale id renders a benign "No
 * content found" instead of an error. Resolving against `loadHelpArticles()` (the
 * corpus itself, not the generated index) catches the drift even when the
 * generated artifacts have not been rebuilt yet.
 */
describe('help id resolution', () => {
  it('every hard-coded help slug in the client resolves to a help article', async () => {
    const articles = await loadHelpArticles();
    expect(articles.length).toBeGreaterThan(0);
    const slugs = new Set(articles.map(article => article.slug));

    const referenced = await collectReferencedHelpIds();
    const unresolved: string[] = [];
    for (const [helpId, sites] of referenced) {
      if (slugs.has(helpId) || KNOWN_UNRESOLVED_HELP_IDS.has(helpId)) continue;
      unresolved.push(`${helpId} (${sites.join(', ')})`);
    }

    expect(unresolved, `help slugs with no matching help article:\n${unresolved.join('\n')}`).toEqual([]);
  });

  /**
   * The corpus is a superset of the index: `build-help-index` drops a title-less
   * article, and `useHelpContent` resolves through the index. So a helpId can name a
   * real file, pass the gate above, and still open an empty panel. Requiring the two
   * sets to be equal closes that, and catches an article added, removed or renamed
   * without a regenerate - the only check on index-vs-corpus anywhere.
   *
   * Slug sets only: an article whose title, description, headings or sidebarPosition
   * changed without a regenerate still passes this. Tracked in #2172.
   */
  it('the generated index covers exactly the help corpus', async () => {
    const articles = await loadHelpArticles();
    const corpusSlugs = new Set(articles.map(article => article.slug));

    // `filePathToSlug` collapses a directory index into its parent, so
    // `features/tavern/index.md` and a sibling `features/tavern.md` would both
    // resolve to `features/tavern`. A Set swallows the collision silently.
    expect(articles.length, 'two docs files collapsed to the same slug').toBe(corpusSlugs.size);

    const index = JSON.parse(fs.readFileSync(HELP_INDEX_PATH, 'utf-8'));
    const indexSlugs = new Set<string>(index.entries.map((entry: { slug: string }) => entry.slug));

    const missingFromIndex = [...corpusSlugs].filter(slug => !indexSlugs.has(slug)).sort();
    const missingFromCorpus = [...indexSlugs].filter(slug => !corpusSlugs.has(slug)).sort();

    expect(
      { missingFromIndex, missingFromCorpus },
      'help-index.json is out of step with docs-site. Run `pnpm --filter @bike4mind/scripts help:regenerate`.\n' +
        `In the corpus but not the index (regenerate, or the article has no frontmatter title):\n${missingFromIndex.join('\n')}\n` +
        `In the index but not the corpus (stale artifact):\n${missingFromCorpus.join('\n')}`
    ).toEqual({ missingFromIndex: [], missingFromCorpus: [] });
  });

  /**
   * The index/corpus check above is slug-level: it catches an article added, removed
   * or renamed without a regenerate, but not one whose *sections* changed without a
   * re-embed - a heading added, renamed, or re-split by the chunker's 800-token H3
   * threshold. That drift is invisible in review (the help panel renders `docs-site`
   * directly) and invisible at runtime (`retrieval.ts`'s `buildVectorContext` drops an
   * unresolvable chunk with an unconditional `continue`, no warning).
   *
   * `bundle-help-content.ts` copies each `help-index.json` entry's `filePath` byte for
   * byte into the bundle that `vectorize-help-content.ts` chunks, so re-deriving
   * `chunkByHeadings` straight from the corpus (via `loadHelpArticles`, keyed to each
   * index entry's title) reproduces the exact chunk set `help:vectorize` would produce
   * - without needing the bundle step, an API key, or the network.
   */
  it('the committed help-embeddings.json matches what the chunker derives from docs-site', async () => {
    const articles = await loadHelpArticles();
    const articleBySlug = new Map(articles.map(article => [article.slug, article]));
    const index: HelpIndex = JSON.parse(fs.readFileSync(HELP_INDEX_PATH, 'utf-8'));
    const embeddings: HelpEmbeddingsIndex = JSON.parse(fs.readFileSync(HELP_EMBEDDINGS_PATH, 'utf-8'));

    interface DerivedChunk {
      slug: string;
      sectionPath: string;
      tokenCount: number;
    }
    const chunkKey = (chunk: { slug: string; sectionPath: string }): string => `${chunk.slug}::${chunk.sectionPath}`;

    const derived: DerivedChunk[] = [];
    for (const entry of index.entries) {
      const article = articleBySlug.get(entry.slug);
      // An index entry with no corpus article is already reported by the test above.
      // Skipping it still surfaces its committed chunks below as orphan vectors, which
      // is the honest reading: with no article there is nothing to derive against.
      if (!article) continue;
      for (const section of chunkByHeadings(article.content, entry.title)) {
        derived.push({
          slug: entry.slug,
          sectionPath: section.sectionPath,
          tokenCount: estimateTokenCount(`# ${entry.title}\n\n${section.content}`),
        });
      }
    }

    const derivedKeys = new Set(derived.map(chunkKey));
    const embeddedKeys = new Set(embeddings.chunks.map(chunkKey));

    // Nothing enforces (slug, sectionPath) uniqueness today (e.g. two identical H2
    // headings in one article) - a Set comparison is only sound while it holds. The
    // remedy is renaming the duplicate heading, not a regenerate: `retrieval.ts`'s
    // `resolveChunkContent` keys its content map on this same composite, so a collision
    // makes one chunk render another's text.
    expect(
      derived.length,
      'chunkByHeadings produced two chunks with the same (slug, sectionPath) key - rename the duplicate heading'
    ).toBe(derivedKeys.size);
    expect(
      embeddings.chunks.length,
      'help-embeddings.json has two chunks with the same (slug, sectionPath) key - rename the duplicate heading'
    ).toBe(embeddedKeys.size);

    const missingVectors = [...derivedKeys].filter(key => !embeddedKeys.has(key)).sort();
    const orphanVectors = [...embeddedKeys].filter(key => !derivedKeys.has(key)).sort();

    expect(
      { missingVectors, orphanVectors },
      'help-embeddings.json is out of step with docs-site at section granularity. ' +
        'Run `OPENAI_API_KEY=... pnpm --filter @bike4mind/scripts help:regenerate`.\n' +
        `Derived but not embedded - never retrieved by the Help AI chat:\n${missingVectors.join('\n')}\n` +
        `Embedded but not derived - orphan vector, consumes a retrieval slot for nothing:\n${orphanVectors.join('\n')}`
    ).toEqual({ missingVectors: [], orphanVectors: [] });

    // Restricted to keys present on both sides - a missing/orphan key is already
    // reported above, and would otherwise show here too as a confusing
    // "committed=undefined" mismatch.
    const embeddedTokenCountByKey = new Map(embeddings.chunks.map(chunk => [chunkKey(chunk), chunk.tokenCount]));
    const tokenCountMismatches = derived
      .filter(
        chunk => embeddedKeys.has(chunkKey(chunk)) && embeddedTokenCountByKey.get(chunkKey(chunk)) !== chunk.tokenCount
      )
      .map(
        chunk =>
          `${chunkKey(chunk)}: committed=${embeddedTokenCountByKey.get(chunkKey(chunk))} derived=${chunk.tokenCount}`
      )
      .sort();

    // Warn rather than fail: unlike the key sets above, this one is not clean on
    // `main` today for a reason outside this test's control. A docs-only PR (#2196)
    // edited two of these articles and regenerated help-index.json but not
    // help-embeddings.json; a later rebase of an in-flight artifact-regeneration PR
    // replayed its own (older) full-file embeddings snapshot on top, which silently
    // preserved the staleness instead of surfacing it. Hard-failing here would block
    // unrelated PRs on a pre-existing drift this test cannot itself fix, and this
    // repo has no CI-held OPENAI_API_KEY to regenerate automatically.
    //
    // Waiting for the set to reach zero is NOT a workable promotion path: ordinary
    // docs edits keep landing without a re-embed, so it was two chunks when this test
    // was written and is four now (#2272, #2312 grew it). #2331 tracks the fix -
    // allowlist the currently-drifted keys, the way KNOWN_UNRESOLVED_HELP_IDS above
    // already does for slugs, and hard-fail on any new one, so the gate stops
    // depending on a regenerate CI cannot run.
    if (tokenCountMismatches.length > 0) {
      console.warn(
        'help-embeddings.json chunk content has changed since it was embedded (tokenCount drift). ' +
          `Run \`OPENAI_API_KEY=... pnpm --filter @bike4mind/scripts help:regenerate\`.\n${tokenCountMismatches.join('\n')}`
      );
    }
  });

  it('every known-unresolved helpId is still unresolved, and still referenced', async () => {
    const articles = await loadHelpArticles();
    const slugs = new Set(articles.map(article => article.slug));
    const referenced = await collectReferencedHelpIds();

    const resolvable = [...KNOWN_UNRESOLVED_HELP_IDS].filter(helpId => slugs.has(helpId));
    expect(resolvable, `Now resolvable - drop from KNOWN_UNRESOLVED_HELP_IDS:\n${resolvable.join('\n')}`).toEqual([]);

    // An entry whose component was deleted is dead config that nothing else notices.
    const unreferenced = [...KNOWN_UNRESOLVED_HELP_IDS].filter(helpId => !referenced.has(helpId));
    expect(
      unreferenced,
      `No longer referenced in the client - drop from KNOWN_UNRESOLVED_HELP_IDS:\n${unreferenced.join('\n')}`
    ).toEqual([]);
  });
});
