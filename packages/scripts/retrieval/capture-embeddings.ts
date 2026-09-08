#!/usr/bin/env tsx
/**
 * Capture one lake's chunk vectors under one or more embedding models, for the model comparison.
 *
 * PHASE A of a two-phase harness. This half needs a live Mongo and a provider key; `model-comparison.ts`
 * scores what it writes and needs neither. The split exists because the analysis must be verifiable in
 * CI and re-runnable at a new width without paying to embed twice - see MODEL-COMPARISON.md.
 *
 * READ-ONLY against Mongo, deliberately and structurally: it issues finds and never a write. No scratch
 * lake is created and no vector is persisted, which also disposes of the width hazard that a scratch-lake
 * approach carries - `FabFile.embeddingModel` records the model with no width, so two vectors both
 * honestly labelled `text-embedding-3-small` at 1536 and 512 would compare as noise. Nothing here is
 * stored, so nothing can be mislabelled.
 *
 *   npx sst shell --stage <stage> -- tsx packages/scripts/retrieval/capture-embeddings.ts \
 *     --lake system-help --userId <id> --models text-embedding-3-small,text-embedding-3-large --dry-run
 *
 * Drop --dry-run and add --yes once the printed cost is acceptable.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import { Resource } from 'sst';
import {
  adminSettingsRepository,
  apiKeyRepository,
  connectDB,
  dataLakeRepository,
  fabFileChunkRepository,
  fabFileRepository,
} from '@bike4mind/database';
import { apiKeyService } from '@bike4mind/services';
import { EmbeddingFactory, getProviderFromModel, resolveEmbeddingConfig } from '@bike4mind/fab-pipeline';
import { getSettingsByNames } from '@bike4mind/utils';
import { countCodePoints } from '@bike4mind/common';
import { PROBE_QUESTIONS } from './corpus';
import {
  parseSupportedModels,
  formatCapturePlan,
  planCapture,
  selectReusableChunks,
  totalExcluded,
  type StoredChunk,
} from './capturePlan';
import { corpusRegime, formatCorpusRegime, isLongDocumentRegime } from './embeddingFixture';

/** The ingest tags each help file `help:<slug>`; that slug is what corpus.ts's ground truth names. */
const HELP_TAG_PREFIX = 'help:';
const SCRIPTS_PACKAGE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const argv = await yargs(hideBin(process.argv))
  .option('lake', { type: 'string', default: 'system-help', describe: 'Data-lake slug to capture' })
  .option('userId', { type: 'string', demandOption: true, describe: 'User whose effective API key is used' })
  .option('models', { type: 'string', demandOption: true, describe: 'Comma-separated embedding models' })
  .option('reuse-stored-vectors', {
    type: 'boolean',
    default: false,
    describe: 'Reuse the stored vectors instead of re-embedding (the ~free baseline arm)',
  })
  .option('dry-run', { type: 'boolean', default: false, describe: 'Print the cost and corpus regime, then stop' })
  .option('yes', { type: 'boolean', default: false, describe: 'Approve the printed spend and embed' })
  .option('out-dir', { type: 'string', default: path.resolve(SCRIPTS_PACKAGE_DIR, 'out') })
  .strict()
  .parse();

const models = parseSupportedModels(
  argv.models
    .split(',')
    .map(m => m.trim())
    .filter(Boolean)
);

await connectDB(Resource.MONGODB_URI.value.replace('%STAGE%', Resource.App.stage));
console.log(`Connected (stage: ${Resource.App.stage})`);

// --- Resolve the corpus (read-only) ---
const lake = await dataLakeRepository.findBySlug(argv.lake);
if (!lake) throw new Error(`No "${argv.lake}" lake on this stage.`);
if (lake.status !== 'active') throw new Error(`Lake "${argv.lake}" is ${lake.status}, not active.`);

const fileIds = await fabFileRepository.findIdsByDataLakeTag({ kind: 'registry', datalakeTag: lake.datalakeTag });
if (fileIds.length === 0) throw new Error(`Lake "${argv.lake}" holds no files.`);

const stored: StoredChunk[] = [];
const tokenCounts: number[] = [];
for (const fileId of fileIds) {
  const file = await fabFileRepository.findById(fileId);
  if (!file) continue;
  // Prefer the help slug so the capture joins to corpus.ts's ground truth; fall back to the file id,
  // which is the right document identity for any other lake.
  const helpTag = file.tags?.find(t => t.name.startsWith(HELP_TAG_PREFIX));
  const docId = helpTag ? helpTag.name.slice(HELP_TAG_PREFIX.length) : fileId;

  for (const chunk of await fabFileChunkRepository.findByFabFileId(fileId)) {
    const text = chunk.text ?? '';
    stored.push({
      chunkId: String(chunk.id ?? chunk._id),
      docId,
      text,
      vector: (chunk.vector as number[]) ?? [],
      parentEmbeddingModel: file.embeddingModel,
    });
    tokenCounts.push(chunk.tokenCount ?? Math.ceil(text.length / 4));
  }
}
if (stored.length === 0) throw new Error(`Lake "${argv.lake}" has ${fileIds.length} files but no chunks.`);

// --- Corpus-regime gate: is this the long-document case the model question is about? ---
const regime = corpusRegime(
  stored.map(c => ({ docId: c.docId, charLength: countCodePoints(c.text) })),
  fileIds.length
);
console.log(`\n${formatCorpusRegime(regime)}\n`);
if (!isLongDocumentRegime(regime)) {
  console.warn(
    'WARNING: this corpus is NOT in the long-document regime. text-embedding-3-small was chosen on ' +
      'short facts, and the argument for it is exactly the one that does not transfer to long prose. ' +
      'A model verdict read off this capture inherits that bias - capture a production lake instead.'
  );
}

// --- Cost preflight, priced from the shipped rate table ---
const embedModels = argv['reuse-stored-vectors'] ? [] : models;
const plan = planCapture(tokenCounts, embedModels);
console.log(`${formatCapturePlan(plan)}\n`);
if (plan.anyUnpriced) {
  throw new Error('At least one model has no published rate, so the real spend is unknown. Add its rate first.');
}
if (argv['dry-run']) {
  console.log('--dry-run: nothing embedded.');
  process.exit(0);
}
if (embedModels.length > 0 && !argv.yes) {
  throw new Error('Refusing to spend without --yes. Re-run with --yes once the cost above is acceptable.');
}

// --- Credentials, resolved the shipped way ---
const keyTable = await apiKeyService.getEffectiveLLMApiKeys(argv.userId, {
  db: { apiKeys: apiKeyRepository, adminSettings: adminSettingsRepository },
  getSettingsByNames,
});

mkdirSync(argv['out-dir'], { recursive: true });
const capturedAt = new Date().toISOString();

for (const model of models) {
  const { config, missing } = resolveEmbeddingConfig(getProviderFromModel(model), keyTable);
  if (missing)
    throw new Error(`No ${missing} credential resolved for user ${argv.userId}; cannot embed with ${model}.`);
  const service = new EmbeddingFactory(config).createEmbeddingService(model);

  // Query vectors are always freshly embedded: the corpus stores no vector for a probe question, and
  // a query must live in the same space as the chunks it is scored against.
  const questions = PROBE_QUESTIONS.map(q => q.question);
  const queryVectors = await embedAll(service, questions);

  let chunks: { chunkId: string; docId: string; vector: number[]; charLength: number }[];
  let chunksExcluded = 0;
  let filesExcluded = 0;

  if (argv['reuse-stored-vectors']) {
    // Two passes: the first finds which width the labelled vectors actually are, the second holds
    // every kept vector to it. Reading the width off the corpus rather than assuming one is what
    // makes a partly-re-embedded lake surface as dimensionMismatch instead of scoring as noise.
    const first = selectReusableChunks(stored, model);
    const dims = modalLength(first.reusable.map(c => c.vector.length));
    const selection = selectReusableChunks(stored, model, dims);
    if (selection.reusable.length === 0) {
      throw new Error(
        `No stored vector in "${argv.lake}" is labelled ${model}. ` +
          `Excluded: ${JSON.stringify(selection.excluded)}. Drop --reuse-stored-vectors to embed instead.`
      );
    }
    chunksExcluded = totalExcluded(selection.excluded);
    filesExcluded = selection.excludedDocs;
    console.log(`${model}: reusing ${selection.reusable.length} stored vectors at ${dims} dims`);
    console.log(`  excluded ${chunksExcluded} chunks ${JSON.stringify(selection.excluded)}`);
    chunks = selection.reusable.map(c => ({
      chunkId: c.chunkId,
      docId: c.docId,
      vector: c.vector,
      charLength: countCodePoints(c.text),
    }));
  } else {
    const vectors = await embedAll(
      service,
      stored.map(c => c.text)
    );
    chunks = stored.map((c, i) => ({
      chunkId: c.chunkId,
      docId: c.docId,
      vector: vectors[i],
      charLength: countCodePoints(c.text),
    }));
  }

  const dims = chunks[0].vector.length;
  const fixture = {
    model,
    dims,
    corpus: argv.lake,
    capturedAt,
    filesInScope: fileIds.length,
    chunksExcluded,
    filesExcluded,
    chunks,
    queries: PROBE_QUESTIONS.map((q, i) => ({ id: q.id, vector: queryVectors[i] })),
  };

  const outPath = path.join(argv['out-dir'], `${model}.${argv.lake}.fixture.json`);
  writeFileSync(outPath, `${JSON.stringify(fixture)}\n`);
  console.log(`Wrote ${outPath} (${chunks.length} chunks, ${dims} dims)`);
}

console.log('\nNow score them:\n  pnpm --filter @bike4mind/scripts retrieval:model-comparison --fixtures <paths>');
process.exit(0);

/**
 * Embed via the provider's batch path when it has one. `generateEmbeddingBatch` lives on the OpenAI
 * service rather than the abstract EmbeddingService, so this narrows instead of casting, and falls
 * back to the one-at-a-time contract every provider does implement.
 */
async function embedAll(service: unknown, texts: string[]): Promise<number[][]> {
  const batch = (service as { generateEmbeddingBatch?: (t: string[]) => Promise<number[][]> }).generateEmbeddingBatch;
  if (typeof batch === 'function') return batch.call(service, texts);
  const single = service as { generateEmbedding: (t: string) => Promise<number[]> };
  const out: number[][] = [];
  for (const text of texts) out.push(await single.generateEmbedding(text));
  return out;
}

/** The most common vector width in a set - the width the corpus is actually stored at. */
function modalLength(lengths: number[]): number | undefined {
  const tally = new Map<number, number>();
  for (const n of lengths) tally.set(n, (tally.get(n) ?? 0) + 1);
  let best: number | undefined;
  let bestCount = 0;
  for (const [len, count] of tally) {
    if (count > bestCount) {
      best = len;
      bestCount = count;
    }
  }
  return best;
}
