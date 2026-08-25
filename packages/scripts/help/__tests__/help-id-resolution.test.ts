import { describe, it, expect } from 'vitest';
import { glob } from 'glob';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { loadHelpArticles } from '../loadHelpArticles';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/** Absolute path to the client source tree that hosts every ContextHelpButton. */
const CLIENT_APP_ROOT = path.resolve(__dirname, '../../../../apps/client/app');

/** Matches a hand-written `helpId="..."` literal; `helpId={expr}` is skipped by construction. */
const HELP_ID_LITERAL = /helpId="([^"]+)"/g;

/**
 * Help ids with no article yet. Each needs content authored (or the id corrected)
 * before it can be removed from this list - until then its help button opens an
 * empty panel. Tracked as follow-up work, not as a licence to add more.
 */
const KNOWN_UNRESOLVED_HELP_IDS = new Set([
  // No admin GitHub-connection article has been written yet.
  'admin/github-connection',
  // No organization GitHub-connection article has been written yet.
  'organizations/github-connection',
  // Looks like a FieldTooltip field key pasted into a ContextHelpButton; needs the
  // right slug, not a new article.
  'image-edit-model',
]);

/**
 * CI gate: every `helpId` literal in the client must name a real help article.
 *
 * A help id is a keyed identifier duplicated between the component and the
 * docs-site filename, and nothing else cross-checks them: `useHelpContent` leaves
 * the query disabled for an unknown slug, so a stale id renders a benign "No
 * content found" instead of an error. Resolving against `loadHelpArticles()` (the
 * corpus itself, not the generated index) catches the drift even when the
 * generated artifacts have not been rebuilt yet.
 */
describe('help id resolution', () => {
  it('every helpId literal in the client resolves to a help article', async () => {
    const articles = await loadHelpArticles();
    expect(articles.length).toBeGreaterThan(0);
    const slugs = new Set(articles.map(article => article.slug));

    const files = await glob('**/*.{ts,tsx}', {
      cwd: CLIENT_APP_ROOT,
      absolute: true,
      ignore: ['**/node_modules/**'],
    });
    expect(files.length).toBeGreaterThan(0);

    const unresolved: string[] = [];
    for (const file of files) {
      const source = fs.readFileSync(file, 'utf-8');
      for (const [, helpId] of source.matchAll(HELP_ID_LITERAL)) {
        if (slugs.has(helpId) || KNOWN_UNRESOLVED_HELP_IDS.has(helpId)) continue;
        unresolved.push(`${path.relative(CLIENT_APP_ROOT, file)}: helpId="${helpId}"`);
      }
    }

    expect(unresolved, `helpId literals with no matching help article:\n${unresolved.join('\n')}`).toEqual([]);
  });

  it('every known-unresolved helpId is still unresolved', async () => {
    const articles = await loadHelpArticles();
    const slugs = new Set(articles.map(article => article.slug));

    const stale = [...KNOWN_UNRESOLVED_HELP_IDS].filter(helpId => slugs.has(helpId));
    expect(stale, `Now resolvable - drop from KNOWN_UNRESOLVED_HELP_IDS:\n${stale.join('\n')}`).toEqual([]);
  });
});
