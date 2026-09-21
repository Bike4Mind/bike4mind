import { describe, it, expect } from 'vitest';
import { glob } from 'glob';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { loadHelpArticles } from '../loadHelpArticles';
import { chunkByHeadings } from '../utils';
import { ROUTE_HELP_SUGGESTIONS } from '../../../../apps/client/app/components/help/routeHelpSuggestions';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/** Absolute path to the client source tree that hosts every ContextHelpButton. */
const CLIENT_APP_ROOT = path.resolve(__dirname, '../../../../apps/client/app');

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
   * Both of these were assertions inside the artifact-vs-corpus gates that used to live
   * here. The index and the vectors are generated at build and deploy time now, so there
   * is no stored copy left to compare against - but these two are properties of the
   * corpus itself, so they outlive the gates that happened to carry them.
   */
  it('no two help articles collapse to the same slug', async () => {
    const articles = await loadHelpArticles();
    expect(articles.length).toBeGreaterThan(0);
    const slugs = new Set(articles.map(article => article.slug));

    // `filePathToSlug` collapses a directory index into its parent, so
    // `features/tavern/index.md` and a sibling `features/tavern.md` would both resolve to
    // `features/tavern`, and one article shadows the other everywhere downstream.
    expect(articles.length, 'two docs files collapsed to the same slug').toBe(slugs.size);
  });

  it('no two help chunks share a (slug, sectionPath) key', async () => {
    // `retrieval.ts`'s `resolveChunkContent` keys its content map on this composite, so a
    // collision (two identical H2 headings in one article) makes one chunk render
    // another's text. The remedy is renaming the duplicate heading, and this matters more
    // now than it did as a Set-comparison caveat: chunking happens at deploy time with no
    // committed artifact left to inspect, so nothing else would surface it.
    const articles = await loadHelpArticles();
    const seen = new Set<string>();
    const duplicates = new Set<string>();
    for (const article of articles) {
      for (const section of chunkByHeadings(article.content, article.frontmatter.title ?? article.slug)) {
        const key = `${article.slug}::${section.sectionPath}`;
        if (seen.has(key)) duplicates.add(key);
        seen.add(key);
      }
    }
    // Without this the whole test passes on an empty corpus or a chunker that returns nothing.
    expect(seen.size).toBeGreaterThan(articles.length);

    const offenders = [...duplicates].sort();
    expect(
      offenders,
      `Duplicate (slug, sectionPath) keys - rename the duplicate heading:\n${offenders.join('\n')}`
    ).toEqual([]);
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
