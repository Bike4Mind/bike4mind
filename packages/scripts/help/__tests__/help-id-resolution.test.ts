import { describe, it, expect } from 'vitest';
import { glob } from 'glob';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { loadHelpArticles } from '../loadHelpArticles';
import { ROUTE_HELP_SUGGESTIONS } from '../../../../apps/client/app/components/help/routeHelpSuggestions';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/** Absolute path to the client source tree that hosts every ContextHelpButton. */
const CLIENT_APP_ROOT = path.resolve(__dirname, '../../../../apps/client/app');

/** The generated runtime index - what the help panel can actually resolve. */
const HELP_INDEX_PATH = path.resolve(__dirname, '../../../../apps/client/app/generated/help-index.json');

/**
 * The three shapes a help slug is hard-coded in. `helpId={expr}` is skipped by
 * construction: the only two indirection sites forward a `helpId?: string` prop, and
 * every caller passes a literal that these patterns catch at the call site.
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
  // Looks like a FieldTooltip field key pasted into a ContextHelpButton; needs the
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
