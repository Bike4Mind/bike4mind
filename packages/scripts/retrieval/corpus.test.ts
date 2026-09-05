import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { loadHelpArticles } from '../help/loadHelpArticles';
import { NEGATIVES, NEVER_SUPPORTING, POSITIVES, PROBE_QUESTIONS, REFERENCED_SLUGS } from './corpus';

/**
 * CI gate on the probe's ground truth, validated against the REAL help corpus rather than a fixture.
 *
 * The failure this exists to prevent is silent and expensive: a docs rename turns a supporting slug
 * into one no article carries, every question citing it loses recall it should have had, and the
 * sweep concludes a budget setting is worse than it is. Retrieval would not have changed at all.
 */
describe('probe ground truth', () => {
  it('references only slugs that exist as PUBLIC help articles', async () => {
    // Public is the operative filter: `ingest-help-datalake.ts` ingests accessLevel === 'public'
    // only, so an admin-category article is a real doc that is nonetheless not in the lake, and
    // citing one would be unreachable ground truth.
    const publicSlugs = new Set((await loadHelpArticles()).filter(a => a.accessLevel === 'public').map(a => a.slug));
    expect(publicSlugs.size).toBeGreaterThan(0);

    const missing = REFERENCED_SLUGS.filter(slug => !publicSlugs.has(slug));
    expect(
      missing,
      `Ground truth cites slugs that are not public help articles (renamed or moved?):\n  ${missing.join('\n  ')}`
    ).toEqual([]);
  });

  it('references only slugs the help-lake ingest will actually create', () => {
    // loadHelpArticles reads docs-site; the ingest reads the GENERATED index. They are normally in
    // step, but the index is what determines what ends up in the lake, so the ground truth has to
    // hold against that source specifically - a slug present in docs but absent from the index is
    // an article the probe can never retrieve.
    const indexPath = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      '../../../apps/client/app/generated/help-index.json'
    );
    // Generated, so a fresh checkout may not have it yet. Absent is not a failure - the docs-site
    // assertion above still covers the ground truth; this one adds the ingest's own view when built.
    if (!existsSync(indexPath)) return;

    const entries = JSON.parse(readFileSync(indexPath, 'utf-8')).entries as {
      slug: string;
      accessLevel: string;
    }[];
    const ingested = new Set(entries.filter(e => e.accessLevel === 'public').map(e => e.slug));
    const missing = REFERENCED_SLUGS.filter(slug => !ingested.has(slug));
    expect(missing, `Ground truth cites slugs the ingest will not put in the lake:\n  ${missing.join('\n  ')}`).toEqual(
      []
    );
  });

  it('never cites the survey and grab-bag articles as supporting', () => {
    const leaked = REFERENCED_SLUGS.filter(slug => (NEVER_SUPPORTING as readonly string[]).includes(slug));
    expect(leaked, `These are corpus distractors by design and must not be ground truth: ${leaked.join(', ')}`).toEqual(
      []
    );
  });

  it('has unique question ids', () => {
    const ids = PROBE_QUESTIONS.map(q => q.id);
    expect(new Set(ids).size, `Duplicate question ids: ${ids.join(', ')}`).toBe(ids.length);
  });

  it('lists no slug twice within one question', () => {
    const offenders = PROBE_QUESTIONS.filter(q => new Set(q.supporting).size !== q.supporting.length).map(q => q.id);
    // A repeat would inflate that question's recall denominator against a document served once.
    expect(offenders, `Repeated supporting slug in: ${offenders.join(', ')}`).toEqual([]);
  });

  it('carries enough negatives for falsePositiveRate to mean anything', () => {
    // The relevance floor's whole purpose is serving nothing when nothing fits. With no negatives
    // the sweep can only ever see the floor's cost (recall lost) and never its benefit.
    expect(NEGATIVES.length).toBeGreaterThanOrEqual(5);
  });

  it('is mostly multi-document, so the sweep can discriminate between budgets', () => {
    // A question one article fully answers is satisfied at every setting and cannot separate
    // configurations. If this ever drops below half, the set has quietly stopped measuring breadth.
    const multi = POSITIVES.filter(q => q.supporting.length > 1).length;
    expect(multi / POSITIVES.length).toBeGreaterThan(0.5);
  });

  it('partitions cleanly into positives and negatives', () => {
    expect(POSITIVES.length + NEGATIVES.length).toBe(PROBE_QUESTIONS.length);
  });
});
