#!/usr/bin/env tsx
/**
 * Help Coverage Report
 *
 * Compares user-facing SPA route definitions (apps/client/app/router.tsx) against
 * the help corpus and reports feature routes that have no matching help article -
 * i.e. features that appear to be undocumented.
 *
 * The route->article mapping is inherently fuzzy (there is no 1:1 relationship), so
 * this report is ADVISORY and always exits 0. It surfaces gaps for humans to
 * triage; it does not gate CI.
 *
 * Usage: pnpm --filter @bike4mind/scripts help:coverage
 */

import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { loadHelpArticles, type LoadedHelpArticle } from './loadHelpArticles.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const ROUTER_PATH = path.resolve(__dirname, '../../../apps/client/app/router.tsx');

/**
 * Top-level route segments that are not user-facing features (auth flows,
 * OAuth callbacks, transactional pages, etc.). These are excluded from the
 * documentation-coverage expectation.
 */
const NON_FEATURE_SEGMENTS = new Set([
  '',
  'new',
  'auth',
  'login',
  'register',
  'password-reset',
  'forgot-password',
  'force-password-change',
  'verify-email',
  'verify-change',
  'admin-emergency',
  'google-drive',
  'oauth',
  'email',
  'share',
  'report',
  'subscribe',
  'subscriptions',
  'activate',
  'auth-success',
]);

/** Extract the distinct top-level route segments from router.tsx path literals. */
export function extractRouteSegments(routerSource: string): string[] {
  const pathRegex = /path:\s*['"]([^'"]+)['"]/g;
  const segments = new Set<string>();
  let match: RegExpExecArray | null;

  while ((match = pathRegex.exec(routerSource)) !== null) {
    const routePath = match[1];
    // First non-empty, non-parameter segment.
    const first = routePath.split('/').filter(seg => seg && !seg.startsWith('$'))[0];
    if (first) segments.add(first);
  }

  return [...segments].sort();
}

/** Build the set of tokens a help article "covers" (slug segments + tags). */
function articleTokens(article: LoadedHelpArticle): string[] {
  const tokens = article.slug.split('/');
  return [...tokens, ...(article.frontmatter.tags ?? [])].map(t => t.toLowerCase());
}

/** True if any article plausibly documents the given route segment. */
export function isDocumented(segment: string, articles: LoadedHelpArticle[]): boolean {
  const seg = segment.toLowerCase();
  // Tolerate simple plural/singular differences (agents / agent).
  const variants = [seg, seg.replace(/s$/, ''), `${seg}s`];
  return articles.some(article => {
    const tokens = articleTokens(article);
    return tokens.some(token => variants.includes(token));
  });
}

async function main(): Promise<void> {
  const routerSource = fs.readFileSync(ROUTER_PATH, 'utf-8');
  const segments = extractRouteSegments(routerSource);
  const featureSegments = segments.filter(seg => !NON_FEATURE_SEGMENTS.has(seg));

  const articles = await loadHelpArticles();

  const documented: string[] = [];
  const undocumented: string[] = [];
  for (const segment of featureSegments) {
    (isDocumented(segment, articles) ? documented : undocumented).push(segment);
  }

  console.log('📊 Help Documentation Coverage Report');
  console.log(`   Help articles: ${articles.length}`);
  console.log(`   Feature routes considered: ${featureSegments.length}`);
  console.log(`   Documented: ${documented.length}  |  Undocumented: ${undocumented.length}`);

  if (documented.length > 0) {
    console.log(`\n✅ Documented feature routes:\n   ${documented.join(', ')}`);
  }

  if (undocumented.length > 0) {
    console.log('\n⚠️  Feature routes with no matching help article (candidates to document):');
    for (const segment of undocumented) {
      console.log(`   • /${segment}`);
    }
    console.log('\n   (Advisory only — some routes intentionally have no standalone article.)');
  } else {
    console.log('\n✅ Every considered feature route has a matching help article.');
  }
}

// Only run when invoked directly (not when imported by tests)
if (process.argv[1] && process.argv[1].endsWith('help-coverage-report.ts')) {
  main().catch(error => {
    console.error('Failed to generate help coverage report:', error);
    process.exit(1);
  });
}
