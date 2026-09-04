#!/usr/bin/env tsx
/**
 * Vectorize Help Content Script
 *
 * Chunks help articles by heading sections and generates embeddings
 * using OpenAI text-embedding-3-small. Output is saved to help-embeddings.json
 * for runtime vector similarity search.
 *
 * Reads from apps/client/public/help-content/ which already contains
 * the filtered, bundled markdown files.
 *
 * Usage: OPENAI_API_KEY=sk-... pnpm --filter @bike4mind/scripts help:vectorize
 */

import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import matter from 'gray-matter';
import { glob } from 'glob';
import { EmbeddingFactory } from '@bike4mind/fab-pipeline';
import { OpenAIEmbeddingModel } from '@bike4mind/common';
import type { HelpEmbeddingChunk, HelpEmbeddingsIndex, HelpIndex, HelpAccessLevel } from './types.js';
import { chunkByHeadings, estimateTokenCount, truncateAndNormalize } from './utils.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const HELP_CONTENT_ROOT = path.resolve(__dirname, '../../../apps/client/public/help-content');
const HELP_INDEX_PATH = path.resolve(__dirname, '../../../apps/client/app/generated/help-index.json');
const OUTPUT_PATH = path.resolve(__dirname, '../../../apps/client/app/generated/help-embeddings.json');

const EMBEDDING_MODEL = OpenAIEmbeddingModel.TEXT_EMBEDDING_3_SMALL;
const BATCH_SIZE = 20;

// --- Configurable size optimizations ---
// text-embedding-3-small is a Matryoshka model (native: 1536 dims). The first
// N dims remain useful at lower dimensionality, so if the chunk count grows
// significantly you can reduce this to 1024 or 512 to shrink the embeddings
// file (~0.84 MB at 512 vs ~2.4 MB at 1536 for ~184 chunks).
const EMBEDDING_DIMENSIONS = 1536;
// Number of decimal places to keep per float. 6 gives ample precision
// for cosine similarity while reducing JSON character count per number.
const FLOAT_PRECISION = 6;

/**
 * Truncate a float to a fixed number of decimal places.
 */
function truncateFloat(value: number, precision: number): number {
  const factor = Math.pow(10, precision);
  return Math.round(value * factor) / factor;
}

interface ChunkData {
  slug: string;
  title: string;
  sectionPath: string;
  content: string;
  accessLevel: HelpAccessLevel;
}

/** Remedy quoted in every failure below; see also .husky/check-help-content.sh. */
const REGENERATE_HINT = 'regenerate the help artifacts with `pnpm --filter @bike4mind/scripts help:regenerate`';

/**
 * Load slug -> accessLevel mapping from help-index.json. Throws if the index
 * can't be read, parsed, or is not a non-empty entries[]: access-level labels
 * gate admin-only content out of the Help AI chat for non-admin users, so a
 * broken index must fail the build rather than silently produce chunks whose
 * labels were never derived from it. An empty entries[] parses fine but would
 * leave every slug unresolvable, so it is rejected here rather than surfacing
 * as one "no entry for slug" complaint per bundled article.
 */
export function loadAccessLevelMap(indexPath: string = HELP_INDEX_PATH): Map<string, HelpAccessLevel> {
  const raw = fs.readFileSync(indexPath, 'utf-8');
  const index = JSON.parse(raw) as HelpIndex;
  if (!Array.isArray(index.entries) || index.entries.length === 0) {
    throw new Error(`unexpected artifact shape in ${indexPath}: expected a non-empty entries[] - ${REGENERATE_HINT}`);
  }
  const map = new Map<string, HelpAccessLevel>();
  for (const entry of index.entries) {
    map.set(entry.slug, entry.accessLevel);
  }
  console.log(`Loaded access levels for ${map.size} entries from help-index.json`);
  return map;
}

/**
 * Resolve a slug's access level, throwing when the slug is absent from the index.
 * No level is ever inferred from a miss: defaulting to 'public' bypasses the Help
 * AI chat's admin gate, and defaulting to 'admin' silently hides the public docs.
 * A miss is an invariant violation, not a normal condition - bundle-help-content.ts
 * copies exactly the index's entries and sweeps everything else, so the bundled
 * corpus and the index agree unless help:vectorize ran without a preceding bundle.
 */
export function resolveAccessLevel(slug: string, accessLevelMap: Map<string, HelpAccessLevel>): HelpAccessLevel {
  const accessLevel = accessLevelMap.get(slug);
  if (!accessLevel) {
    throw new Error(`no help-index.json entry for bundled help article "${slug}" - ${REGENERATE_HINT}`);
  }
  return accessLevel;
}

/**
 * Derive a slug from a content-root-relative markdown path. Must stay in sync with
 * filePathToSlug in loadHelpArticles.ts, which builds the index this slug is looked
 * up in - including normalizing separators last, so both agree on Windows, where a
 * relative path arrives as `features\\notebooks` and would otherwise never match.
 */
export function relativePathToSlug(relativePath: string): string {
  let slug = relativePath.replace(/\.md$/, '');
  if (slug.endsWith('/index')) slug = slug.replace(/\/index$/, '');
  else if (slug === 'index') slug = '';
  return slug.replace(/\\/g, '/');
}

export interface BuildChunksOptions {
  /** Overridable roots for testing; default to the real repo locations. */
  contentRoot?: string;
  indexPath?: string;
}

/**
 * Process all help articles into chunks ready for embedding.
 * Reads directly from apps/client/public/help-content/ (already filtered and bundled).
 */
export async function buildChunks(opts: BuildChunksOptions = {}): Promise<ChunkData[]> {
  const contentRoot = opts.contentRoot ?? HELP_CONTENT_ROOT;
  const indexPath = opts.indexPath ?? HELP_INDEX_PATH;
  const accessLevelMap = loadAccessLevelMap(indexPath);

  const files = await glob('**/*.md', {
    cwd: contentRoot,
    absolute: true,
  });

  console.log(`Found ${files.length} markdown files in help-content`);

  const articles: { slug: string; title: string; content: string }[] = [];
  for (const filePath of files) {
    const fileContent = fs.readFileSync(filePath, 'utf-8');
    const { data: frontmatter, content } = matter(fileContent);

    if (!frontmatter.title) {
      console.warn(`Skipping ${filePath}: No title in frontmatter`);
      continue;
    }

    articles.push({
      slug: relativePathToSlug(path.relative(contentRoot, filePath)),
      title: frontmatter.title as string,
      content,
    });
  }

  // Report every unresolvable slug at once: a stale bundle typically misses many,
  // and throwing on the first would make it a one-slug-at-a-time fix. Sorted
  // because glob order is not stable and the list is read by a human.
  const unindexed = articles
    .filter(article => !accessLevelMap.has(article.slug))
    .map(article => article.slug)
    .sort();
  if (unindexed.length > 0) {
    throw new Error(
      `${unindexed.length} bundled help article(s) have no help-index.json entry: ${unindexed.join(', ')} - ${REGENERATE_HINT}`
    );
  }

  const chunks: ChunkData[] = [];
  for (const { slug, title, content } of articles) {
    const accessLevel = resolveAccessLevel(slug, accessLevelMap);

    for (const section of chunkByHeadings(content, title)) {
      // Prepend article title for embedding context
      const embeddingContent = `# ${title}\n\n${section.content}`;
      chunks.push({
        slug,
        title,
        sectionPath: section.sectionPath,
        content: embeddingContent,
        accessLevel,
      });
    }
  }

  return chunks;
}

/**
 * Generate embeddings for all chunks in batches.
 * Vectors are truncated to EMBEDDING_DIMENSIONS (no-op at native 1536) and
 * floats are rounded to FLOAT_PRECISION decimal places for JSON size savings.
 */
async function generateEmbeddings(chunks: ChunkData[]): Promise<HelpEmbeddingChunk[]> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error('OPENAI_API_KEY environment variable is required');
  }

  const factory = new EmbeddingFactory({ openaiApiKey: apiKey });
  const service = factory.createEmbeddingService(EMBEDDING_MODEL);

  const results: HelpEmbeddingChunk[] = [];
  const totalBatches = Math.ceil(chunks.length / BATCH_SIZE);

  for (let batchIdx = 0; batchIdx < totalBatches; batchIdx++) {
    const batchStart = batchIdx * BATCH_SIZE;
    const batch = chunks.slice(batchStart, batchStart + BATCH_SIZE);

    console.log(`Processing batch ${batchIdx + 1}/${totalBatches} (${batch.length} chunks)`);

    const embeddings = await Promise.all(batch.map(chunk => service.generateEmbedding(chunk.content)));

    for (let i = 0; i < batch.length; i++) {
      // Dimension reduction + L2 normalization (no-op at native 1536)
      const reduced = truncateAndNormalize(embeddings[i], EMBEDDING_DIMENSIONS);
      // Truncate float precision for smaller JSON output
      const vector = reduced.map(v => truncateFloat(v, FLOAT_PRECISION));

      results.push({
        slug: batch[i].slug,
        title: batch[i].title,
        sectionPath: batch[i].sectionPath,
        vector,
        tokenCount: estimateTokenCount(batch[i].content),
        accessLevel: batch[i].accessLevel,
      });
    }
  }

  return results;
}

async function main(): Promise<void> {
  console.log('Vectorizing help content...');
  console.log(`Source: ${HELP_CONTENT_ROOT}`);
  console.log(`Output: ${OUTPUT_PATH}`);
  console.log(`Model: ${EMBEDDING_MODEL}`);
  console.log(`Dimensions: ${EMBEDDING_DIMENSIONS}`);
  console.log(`Float precision: ${FLOAT_PRECISION} decimal places`);

  const chunks = await buildChunks();
  console.log(`Generated ${chunks.length} chunks from help articles`);

  if (chunks.length === 0) {
    console.error('No chunks generated — check that help-content directory has .md files');
    process.exit(1);
  }

  const embeddedChunks = await generateEmbeddings(chunks);

  // Count unique articles
  const uniqueSlugs = new Set(embeddedChunks.map(c => c.slug));

  const index: HelpEmbeddingsIndex = {
    chunks: embeddedChunks,
    model: EMBEDDING_MODEL,
    dimensions: EMBEDDING_DIMENSIONS,
    generatedAt: new Date().toISOString(),
    sourceArticleCount: uniqueSlugs.size,
  };

  // Ensure output directory exists
  const outputDir = path.dirname(OUTPUT_PATH);
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  // Write non-pretty-printed to save space
  fs.writeFileSync(OUTPUT_PATH, JSON.stringify(index));

  const fileSizeMB = (fs.statSync(OUTPUT_PATH).size / (1024 * 1024)).toFixed(2);
  console.log(`\nDone!`);
  console.log(`  Chunks: ${embeddedChunks.length}`);
  console.log(`  Articles: ${uniqueSlugs.size}`);
  console.log(`  Dimensions: ${EMBEDDING_DIMENSIONS}`);
  console.log(`  File size: ${fileSizeMB} MB`);
  console.log(`  Output: ${OUTPUT_PATH}`);
}

// Only run when invoked directly (not when imported by tests). Compared by resolved
// path rather than filename suffix so a mismatch cannot silently no-op the script.
if (process.argv[1] && path.resolve(process.argv[1]) === __filename) {
  main().catch(error => {
    console.error('Failed to vectorize help content:', error);
    process.exit(1);
  });
}
