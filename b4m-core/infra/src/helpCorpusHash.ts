import { createHash } from 'node:crypto';

/**
 * The two inputs the help corpus hash covers, injected so the computation is testable without a
 * git repo or a generated index on disk.
 */
export interface HelpCorpusHashSources {
  /** `git ls-tree -r HEAD docs-site/docs` output: the article bodies the datalake mirror ingests. */
  readDocsTree: () => string;
  /** Raw bytes of the generated help index, which the docs tree does not carry. */
  readIndex: () => Buffer;
}

/**
 * Content hash of the help corpus, used as HELP_CORPUS_VERSION so SST redeploys the ingest cron
 * when the corpus moves. SST does not notice copyFiles CONTENT changes, so without this the
 * bundle keeps whatever corpus it had when the handler last changed.
 *
 * Both halves are needed: the docs tree covers the article bodies, the index covers a generator
 * change that alters the index's shape without touching an article.
 *
 * Every failure mode here is deliberately loud, because this value's whole job is to CHANGE and a
 * silently-constant hash re-creates the stale-corpus loop it exists to prevent. The shell pipeline
 * this replaced had two such holes: it ended in `awk`, so a missing `md5sum` (not a macOS default)
 * reported success and yielded an empty hash, and an absent index hashed the docs alone. A third
 * survives in `git ls-tree` itself, which exits 0 with NO output for a path that is not in the
 * tree - so an empty docs tree is treated as a failure here rather than hashed as if it were real.
 */
export function computeHelpCorpusHash(sources: HelpCorpusHashSources): string {
  const docsTree = sources.readDocsTree();
  if (docsTree.trim().length === 0) {
    throw new Error(
      'help corpus hash: `git ls-tree` listed no files under docs-site/docs. That exits 0 when the ' +
        'path is absent from the tree, so this would otherwise hash to a constant and pin ' +
        'HELP_CORPUS_VERSION while the corpus drifts.'
    );
  }

  return createHash('md5').update(docsTree).update(sources.readIndex()).digest('hex').slice(0, 8);
}
