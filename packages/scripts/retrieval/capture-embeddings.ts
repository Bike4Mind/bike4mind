#!/usr/bin/env tsx
/**
 * Capture one lake's chunk vectors under one or more embedding models, for the model comparison.
 *
 * PHASE A of a two-phase harness. This half needs a live Mongo and a provider key; `model-comparison.ts`
 * scores what it writes and needs neither. The split exists because the analysis must be verifiable in
 * CI and re-runnable at a new width without paying to embed twice - see MODEL-COMPARISON.md.
 *
 * READ-ONLY against the CORPUS, deliberately and structurally: it issues finds against FabFile and
 * FabFileChunk and persists no vector. No scratch lake is created, which also disposes of the width
 * hazard that a scratch-lake approach carries - `FabFile.embeddingModel` records the model with no
 * width, so two vectors both honestly labelled `text-embedding-3-small` at 1536 and 512 would compare
 * as noise. Nothing here is stored, so nothing can be mislabelled.
 *
 * `connectDB` itself is NOT write-free, and "never a write" would be wrong: `@bike4mind/database`
 * shadows db-core's export with the price-catalog bootstrap, which builds indexes and seeds
 * catalog/price rows on first connect, and db-core connects with `autoIndex: true`. All idempotent and
 * no different from what every deploy boot already does - but it is not nothing.
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
import { ApiKeyType, countCodePoints } from '@bike4mind/common';
import { PROBE_QUESTIONS } from './corpus';
import {
  assertOnePerInput,
  chunkTokenCount,
  embedAll,
  findOversizedChunks,
  formatCapturePlan,
  isCapturableFile,
  modalLength,
  parseSupportedModels,
  planCapture,
  readAllPages,
  selectReusableChunks,
  toBatches,
  totalExcluded,
  type StoredChunk,
} from './capturePlan';
import { corpusRegime, formatCorpusRegime, isLongDocumentRegime, loadEmbeddingFixture } from './embeddingFixture';

/** The ingest tags each help file `help:<slug>`; that slug is what corpus.ts's ground truth names. */
const HELP_TAG_PREFIX = 'help:';
const SCRIPTS_PACKAGE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
/** File ids per read - see `toBatches` for why a whole lake does not go into one `$in`. */
const FILE_ID_BATCH = 200;
/** Chunk rows per page. Vector-free rows, so this is prose and counters, not embeddings. */
const CHUNK_PAGE = 5_000;

const argv = await yargs(hideBin(process.argv))
  .option('lake', {
    type: 'string',
    default: 'system-help',
    describe: 'Data-lake slug (org-less lakes only) or datalakeTag (any lake)',
  })
  .option('userId', {
    type: 'string',
    demandOption: true,
    describe: 'User whose effective API key is used - and therefore WHO PAYS; pass your own id',
  })
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
// By slug first, then by datalakeTag. `findBySlug` with no org list only reaches an ORG-LESS lake
// (its own docblock: the own-org arm is skipped when organizationIds is empty), so `system-help`
// resolves and the org-owned production lake the runbook calls the confirmatory arm does not.
// `datalakeTag` carries a globally-unique index, so it resolves either without an org.
const lake =
  (await dataLakeRepository.findBySlug(argv.lake)) ?? (await dataLakeRepository.findByDatalakeTag(argv.lake));
if (!lake) {
  throw new Error(
    `No lake on this stage with slug or datalakeTag "${argv.lake}". An ORG-OWNED lake is not ` +
      'resolvable by slug here - pass its datalakeTag instead.'
  );
}
if (lake.status !== 'active') throw new Error(`Lake "${argv.lake}" is ${lake.status}, not active.`);

// The LIFECYCLE-SWEEP reader: it returns every id the lake has ever held, with no archivedAt or
// deletedAt condition (see its index docblock in FabFileModel, and the findLakeMemoryExtractionMembers
// docblock that explains what it deliberately is NOT). Everything it hands back is a candidate, not a
// member - `isCapturableFile` below is what reduces it to the set the served path can actually reach.
const fileIds = await fabFileRepository.findIdsByDataLakeTag({ kind: 'registry', datalakeTag: lake.datalakeTag });
if (fileIds.length === 0) throw new Error(`Lake "${argv.lake}" holds no files.`);

// Stored vectors are only read by the --reuse-stored-vectors arm, and on that arm only. Every other
// path needs a token count, a text length and an embedding label, so reading the vectors would pull a
// whole lake's embeddings over the wire - under --dry-run, to print a cost table that does not use
// them.
const needStoredVectors = argv['reuse-stored-vectors'];

// Batched, not per file. The lake read hands back every candidate id at once; reading them one at a
// time was two sequential round-trips per file, which is fine on 49 help files and is not what the
// runbook points this at.
type CapturedFile = { fileId: string; docId: string; embeddingModel?: string | null };
const capturedFiles: CapturedFile[] = [];
let filesUnreachable = 0;
for (const batch of toBatches(fileIds, FILE_ID_BATCH)) {
  const files = await fabFileRepository.findAllByIds(batch);
  const byId = new Map(files.map(f => [String(f.id), f]));
  // Iterated in the LAKE's id order rather than the read's, so what lands in the fixture does not
  // depend on Mongo document order.
  for (const fileId of batch) {
    const file = byId.get(fileId);
    // A tombstone (or a soft-deleted file) and a file the reachability predicate rejects are one
    // class for this counter: the served path would never have returned either, so scoring their
    // chunks would move the band by chunks production cannot surface.
    if (!file || !isCapturableFile(file)) {
      filesUnreachable++;
      continue;
    }
    // Prefer the help slug so the capture joins to corpus.ts's ground truth; fall back to the file
    // id, which is the right document identity for any other lake.
    const helpTag = file.tags?.find(t => t.name.startsWith(HELP_TAG_PREFIX));
    capturedFiles.push({
      fileId,
      docId: helpTag ? helpTag.name.slice(HELP_TAG_PREFIX.length) : fileId,
      embeddingModel: file.embeddingModel,
    });
  }
}

const stored: StoredChunk[] = [];
const tokenCounts: number[] = [];
const capturedDocs = new Set<string>();
for (const fileBatch of toBatches(capturedFiles, FILE_ID_BATCH)) {
  const batch = fileBatch.map(f => f.fileId);
  const fields = await readAllPages(
    after => fabFileChunkRepository.findChunkFieldsByFabFileIds(batch, { limit: CHUNK_PAGE, afterChunkId: after }),
    CHUNK_PAGE
  );
  // The vector read is a SECOND pass, joined on chunk id, so the width of a chunk row on the
  // planning path does not depend on whether this arm wants embeddings. It skips vectorless chunks
  // at the DB layer, so a chunk absent from this map is exactly `selectReusableChunks`' missingVector.
  const vectorById = new Map<string, number[]>();
  if (needStoredVectors) {
    const withVectors = await readAllPages(
      after => fabFileChunkRepository.findVectorsByFabFileIds(batch, { limit: CHUNK_PAGE, afterChunkId: after }),
      CHUNK_PAGE
    );
    for (const chunk of withVectors) vectorById.set(chunk.id, chunk.vector);
  }

  const chunksByFile = new Map<string, typeof fields>();
  for (const chunk of fields) {
    const existing = chunksByFile.get(chunk.fabFileId);
    if (existing) existing.push(chunk);
    else chunksByFile.set(chunk.fabFileId, [chunk]);
  }

  for (const { fileId, docId, embeddingModel } of fileBatch) {
    const fileChunks = chunksByFile.get(fileId) ?? [];
    // The parent's label is a fallback for a WHOLE file, never for a single chunk. A file with no
    // chunk-level stamps predates the field, and its parent label is the only truth there is. But once
    // any chunk in the file is stamped, an unstamped sibling is genuinely unknown - and lending it the
    // parent label would re-admit, one layer above `selectReusableChunks`, exactly the chunk that
    // predicate excludes for being unlabeled. ada-002 and 3-small are both 1536, so the width guard
    // would not catch the two spaces pooling.
    const anyChunkStamped = fileChunks.some(c => Boolean(c.embeddingModel));
    for (const chunk of fileChunks) {
      stored.push({
        chunkId: chunk.id,
        docId,
        text: chunk.text,
        vector: vectorById.get(chunk.id) ?? [],
        parentEmbeddingModel: anyChunkStamped ? chunk.embeddingModel : embeddingModel,
      });
      tokenCounts.push(chunkTokenCount(chunk.tokenCount, chunk.text));
      capturedDocs.add(docId);
    }
  }
}
if (stored.length === 0) {
  throw new Error(
    `Lake "${argv.lake}" has ${fileIds.length} candidate files but no capturable chunks ` +
      `(${filesUnreachable} unreachable: archived, deleted, not fully vectorized or retrieval-excluded).`
  );
}
console.log(`\nfiles: ${capturedDocs.size} capturable, ${filesUnreachable} unreachable of ${fileIds.length}`);

// --- Corpus-regime gate: is this the long-document case the model question is about? ---
const regime = corpusRegime(
  stored.map(c => ({ docId: c.docId, charLength: countCodePoints(c.text) })),
  capturedDocs.size
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
// Named here rather than left to the batcher, which throws `Input at index N` - an index into an
// array the operator never sees, and only after they have read the cost and typed --yes.
if (embedModels.length > 0) {
  const oversized = findOversizedChunks(stored.map((c, i) => ({ chunkId: c.chunkId, tokenCount: tokenCounts[i] })));
  if (oversized.length > 0) {
    throw new Error(
      `${oversized.length} chunk(s) exceed the provider's per-input token ceiling, which fails the ` +
        `whole batch: ${oversized
          .slice(0, 5)
          .map(c => `${c.chunkId} (${c.tokenCount} tokens)`)
          .join(', ')}. Re-chunk the lake at a smaller chunk size, or capture a different lake.`
    );
  }
}
if (argv['dry-run']) {
  console.log('--dry-run: nothing embedded.');
  process.exit(0);
}
if (embedModels.length > 0 && !argv.yes) {
  throw new Error('Refusing to spend without --yes. Re-run with --yes once the cost above is acceptable.');
}

// --- Credentials, resolved the shipped way ---
// `getEffectiveLLMApiKeys` resolves personal key -> platform demo key -> env, so --userId silently
// decides WHOSE quota and money this spends. The preflight above prints dollars; it has to print the
// payer too. Read from the same store the resolver reads (isActive, unexpired), not inferred.
const personalKeys = await apiKeyRepository.findByUserIdAndTypes(argv.userId, [ApiKeyType.openai, ApiKeyType.voyageai]);
const personalTypes = personalKeys.filter(k => !k.expiresAt || k.expiresAt > new Date()).map(k => k.type);
console.log(
  personalTypes.length > 0
    ? `credential source    : PERSONAL key(s) of user ${argv.userId} (${personalTypes.join(', ')}). ` +
        "A personal key WINS over the platform key, so this run spends THAT user's quota."
    : `credential source    : platform key / env (user ${argv.userId} stores no active provider key).`
);

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
  assertOnePerInput(queryVectors, questions.length, `${model} probe queries`);

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
    assertOnePerInput(vectors, stored.length, `${model} chunks`);
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
    filesInScope: capturedDocs.size,
    chunksExcluded,
    filesExcluded,
    filesUnreachable,
    chunks,
    queries: PROBE_QUESTIONS.map((q, i) => ({ id: q.id, vector: queryVectors[i] })),
  };

  // Validate before writing, not on the next read: `dims` is taken from chunks[0] alone, so a
  // heterogeneous capture only surfaces in phase B - after the connection and the credentials are
  // gone and re-capturing costs money again.
  loadEmbeddingFixture(fixture);
  const outPath = path.join(argv['out-dir'], `${model}.${argv.lake}.fixture.json`);
  writeFileSync(outPath, `${JSON.stringify(fixture)}\n`);
  console.log(`Wrote ${outPath} (${chunks.length} chunks, ${dims} dims)`);
}

// Paths relative to packages/scripts/, which is the cwd `pnpm --filter` runs in and where --out-dir
// defaults - see MODEL-COMPARISON.md step 3.
console.log(
  '\nNow score them (from the repo root):\n  pnpm --filter @bike4mind/scripts retrieval:model-comparison ' +
    `--fixtures ${models.map(m => `out/${m}.${argv.lake}.fixture.json`).join(',')}`
);
process.exit(0);
