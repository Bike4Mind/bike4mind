/**
 * The capture fixture: what Phase A writes and Phase B reads.
 *
 * This file is the seam that lets the model comparison be verified without credentials. Embedding a
 * real lake needs a provider key and a live Mongo; scoring the result needs neither. So the capture
 * writes a fixture and every downstream number is derived from it offline - which also means a run
 * can be re-analysed at a new width, or re-scored after a metrics fix, without paying to embed
 * anything twice.
 *
 * WIDTH IS PART OF THE IDENTITY. `text-embedding-3-*` are Matryoshka models, so a fixture captured
 * at full width yields every narrower arm for free (see `deriveArm`). That makes it dangerously easy
 * to compare a 1536-wide vector against a 512-wide one - both honestly labelled
 * `text-embedding-3-small` - and score noise. The shipped corpus has hit that exact bug twice (see
 * the MEMENTO_EMBEDDING_ID docblock), and here it would be worse than a silent outage: it would
 * produce a plausible table that is wrong. So the loader validates every vector's width against the
 * fixture's declared `dims` and throws, rather than trusting the label.
 */

import { createHash } from 'crypto';
import { closeSync, openSync, readFileSync, readSync, unlinkSync, writeSync } from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod';
import { isSupportedEmbeddingModel, OpenAIEmbeddingModel } from '@bike4mind/common';
import { truncateAndNormalize } from '../help/utils';
import { PROBE_QUESTIONS } from './corpus';
import type { ScorableChunk } from './scoreDistribution';

/** A captured chunk vector plus the file it came from - the retrieval unit metrics.ts scores. */
const CapturedChunkSchema = z.object({
  chunkId: z.string().min(1),
  /** The parent document: a help slug for the `system-help` corpus, a FabFile id for a real lake. */
  docId: z.string().min(1),
  vector: z.array(z.number()),
  /** Code points of the chunk text, kept so the corpus-regime gate can be re-checked from the fixture. */
  charLength: z.number().int().nonnegative(),
});

const CapturedQuerySchema = z.object({
  /** A `PROBE_QUESTIONS` id, so the fixture joins to the committed ground truth by id alone. */
  id: z.string().min(1),
  vector: z.array(z.number()),
  /**
   * `hashQuestionText` of the question this vector embeds. The id alone cannot say WHICH text was
   * embedded under it, and two captures taken either side of a reworded question hold vectors of
   * different questions under one id - see `assertQuestionTextMatches`.
   */
  questionHash: z.string().min(1),
  /**
   * The question's supporting document ids, carried IN the fixture. Present only for a capture made
   * with `--questions`, where the ground truth lives outside this repo and so cannot be joined to by
   * id. Absent means the committed `PROBE_QUESTIONS` is the ground truth, which is the `system-help`
   * case.
   *
   * An EMPTY array is a real value, not a missing one - it declares a negative, whose correct
   * behavior is to serve nothing. Every read must test for `undefined`, never for length.
   */
  supporting: z.array(z.string().min(1)).optional(),
});

export const EmbeddingFixtureSchema = z.object({
  model: z.string().min(1),
  /** Full capture width. Every arm derived from this fixture is at most this wide. */
  dims: z.number().int().positive(),
  /** Which corpus this came from, so two fixtures cannot be compared across different lakes. */
  corpus: z.string().min(1),
  capturedAt: z.string().min(1),
  /**
   * Declares a fixture whose model is not a shipped one and whose vectors may still be truncated -
   * the synthetic captures this harness tests itself with. Set ONLY by a committed test fixture:
   * without it, "the registry does not know this model" and "this is a synthetic fixture" are the
   * same signal, and a typo'd model id in a hand-edited capture renders width arms of a model that
   * never had them. See `isTruncatableModel`.
   */
  syntheticMatryoshka: z.boolean().optional(),
  filesInScope: z.number().int().nonnegative(),
  /**
   * Chunks the capture refused to include, by the shipped `ChunkSkipReason` vocabulary. Recorded
   * here rather than only logged, so the analysis can report what an arm never saw.
   */
  chunksExcluded: z.number().int().nonnegative(),
  filesExcluded: z.number().int().nonnegative(),
  /**
   * Files the served retrieval path could not have reached - archived, soft-deleted, not fully
   * vectorized, or retrieval-excluded. See `isCapturableFile`. Recorded so an arm reports the number
   * instead of the `n/a` that would claim the harness cannot observe the class at all.
   */
  filesUnreachable: z.number().int().nonnegative(),
  chunks: z.array(CapturedChunkSchema),
  queries: z.array(CapturedQuerySchema),
});

export type EmbeddingFixture = z.infer<typeof EmbeddingFixtureSchema>;
export type CapturedChunk = z.infer<typeof CapturedChunkSchema>;

export function hashQuestionText(question: string): string {
  return createHash('sha256').update(question, 'utf8').digest('hex').slice(0, 16);
}

const QUESTION_HASH_BY_ID = new Map(PROBE_QUESTIONS.map(q => [q.id, hashQuestionText(q.question)]));

/**
 * Every captured query must be a vector of the question `corpus.ts` currently asks under that id.
 *
 * `assertSameQuerySet` compares id SETS, which is one level short: two fixtures both carrying
 * `q01..q25` pass it, but if the wording of `q07` changed between the two captures they hold vectors
 * of DIFFERENT questions under one id, and both are then scored against one ground truth. That is
 * the same hazard the id check exists to stop - an arm scored on different questions reads as a
 * better model - so the text is pinned too, not just the id.
 *
 * An id `corpus.ts` does not know is left to `resolveQueries`, which names it with the error a
 * re-capture actually needs.
 */
function assertQuestionTextMatches(fixture: EmbeddingFixture): void {
  // A query carrying its own `supporting` came from an external question file, so corpus.ts holds no
  // text to pin it to and an id collision with a committed question is meaningless. Those are pinned
  // across arms instead, by `assertSameQuerySet` comparing id AND text hash.
  const stale = fixture.queries
    .filter(q => q.supporting === undefined)
    .filter(q => QUESTION_HASH_BY_ID.has(q.id) && QUESTION_HASH_BY_ID.get(q.id) !== q.questionHash)
    .map(q => q.id);
  if (stale.length > 0) {
    throw new Error(
      `Fixture "${fixture.corpus}" (${fixture.model}) carries query vector(s) of a question text that ` +
        `is no longer what corpus.ts asks: ${stale.join(', ')}. The id still matches, so nothing ` +
        'downstream would notice - the arm would simply be scored on a different question than its ' +
        'neighbours. Re-capture against the current PROBE_QUESTIONS.'
    );
  }
}

/**
 * Parse and validate a capture. Throws on a width that contradicts the declared `dims`, on either
 * side of the comparison.
 *
 * A width mismatch does NOT throw downstream - `computeCosineSimilarity` returns 0 for it, which a
 * ranking then discards as an ordinary low score. That is the failure this check exists to convert
 * into a loud one: a fixture with a few off-width vectors would otherwise render a complete,
 * confident, wrong table.
 */
export function loadEmbeddingFixture(raw: unknown): EmbeddingFixture {
  const fixture = EmbeddingFixtureSchema.parse(raw);
  const wrong = [
    ...fixture.chunks.filter(c => c.vector.length !== fixture.dims).map(c => `chunk ${c.chunkId}:${c.vector.length}`),
    ...fixture.queries.filter(q => q.vector.length !== fixture.dims).map(q => `query ${q.id}:${q.vector.length}`),
  ];
  if (wrong.length > 0) {
    throw new Error(
      `Fixture "${fixture.corpus}" declares ${fixture.model} at ${fixture.dims} dims but carries ` +
        `${wrong.length} vector(s) of another width (${wrong.slice(0, 5).join(', ')}). Cosine across ` +
        'two widths is not less precise, it is undefined - it scores 0 and disappears into the ' +
        'ranking as an ordinary low score. Re-capture rather than trusting this file.'
    );
  }
  assertQuestionTextMatches(fixture);
  return fixture;
}

/**
 * On-disk form of a capture: a header line carrying everything except `chunks`, then one chunk per
 * line.
 *
 * A production lake cannot be one JSON string. 21k chunks at 1536 dims is ~33M floats, and a real
 * embedding component costs 18-20 characters at full precision, so the vectors alone come to ~655M
 * characters against V8's ~537M cap on a single string. `JSON.stringify` throws
 * `RangeError: Invalid string length` - after the capture has been paid for - and a whole-file
 * `JSON.parse` on the read side hits the same wall, so streaming only the write would produce a file
 * nothing could read back. Newline-delimited, no single string exceeds one chunk at any corpus size
 * or width, which is what keeps the 3-large arm (double the dims) from reintroducing this.
 *
 * Reading stays synchronous and buffer-based rather than moving to a `readline` stream: the callers
 * are two small CLIs, and a Buffer is not subject to the string cap, so the per-line decode is all
 * that is needed to stay under it.
 */
const FIXTURE_FORMAT = 'ndjson-v1';
/** Chunk lines per `writeSync`. Trades ~40 syscalls for a 21k-chunk corpus against a bounded join. */
const FIXTURE_WRITE_BATCH = 500;
const NEWLINE = 0x0a;

const FixtureHeaderSchema = EmbeddingFixtureSchema.omit({ chunks: true }).extend({
  format: z.literal(FIXTURE_FORMAT),
  /**
   * Chunk lines the writer claims it wrote, and the guard that matters most here: a capture killed
   * partway through leaves a syntactically perfect file holding a fraction of the corpus. Without a
   * declared count, a floor swept over that file returns numbers that look measured, and truncation
   * is indistinguishable from a smaller lake.
   */
  chunkCount: z.number().int().nonnegative(),
});

export type FixtureHeader = z.infer<typeof FixtureHeaderSchema>;

/**
 * Bytes per header read. The header carries every QUERY vector, so it is megabytes: 89 queries at
 * 1536 dims is 2.6 MB on the real `opti-knowledge` capture, and a byte-at-a-time scan for the first
 * newline would be the slowest part of a splice that otherwise never decodes a vector.
 */
const HEADER_READ_CHUNK = 1 << 20;
/** Give up rather than buffering a whole corpus hunting a newline that is not coming. */
const HEADER_READ_MAX = 64 << 20;
/** Bytes per copy read when chunk lines are moved verbatim. Never parsed, so this is pure I/O. */
const CHUNK_COPY_CHUNK = 8 << 20;

function readHeaderLine(file: string): { text: string; chunkOffset: number } {
  const fd = openSync(file, 'r');
  try {
    const parts: Buffer[] = [];
    let scanned = 0;
    for (;;) {
      const buf = Buffer.allocUnsafe(HEADER_READ_CHUNK);
      const read = readSync(fd, buf, 0, HEADER_READ_CHUNK, scanned);
      if (read === 0) break;
      const slice = buf.subarray(0, read);
      parts.push(slice);
      const found = slice.indexOf(NEWLINE);
      if (found !== -1) {
        const end = scanned + found;
        // A newline cannot occur inside a UTF-8 multi-byte sequence, so cutting on that byte is exact.
        return { text: Buffer.concat(parts).toString('utf8', 0, end), chunkOffset: end + 1 };
      }
      scanned += read;
      if (scanned > HEADER_READ_MAX) {
        throw new Error(
          `Fixture "${file}" has no line break in its first ${HEADER_READ_MAX} bytes, so it is not a ` +
            `"${FIXTURE_FORMAT}" capture.`
        );
      }
    }
    if (parts.length === 0) {
      throw new Error(`Fixture "${file}" is empty, so it carries no header line.`);
    }
    // No line break anywhere: a COMPACT whole-JSON capture. Returned as the header line so the
    // format check rejects it by name, rather than reported as an empty file, which it is not.
    const all = Buffer.concat(parts);
    return { text: all.toString('utf8'), chunkOffset: all.length };
  } finally {
    closeSync(fd);
  }
}

/**
 * Read a capture's header WITHOUT parsing its chunk lines.
 *
 * `readEmbeddingFixtureFile` is the wrong tool for a question about the header alone: it parses
 * 21,327 chunk lines and holds 33M floats to answer it. `chunkOffset` is where the chunk lines
 * begin, which is what lets them be copied rather than re-serialized.
 *
 * Refuses a whole-JSON capture by name. That form holds its chunks in the same document as its
 * queries, so it has no header to replace - and the failure has to be explicit, because the reader
 * deliberately accepts both forms and a caller cannot tell them apart from the extension.
 */
export function readEmbeddingFixtureHeader(file: string): { header: FixtureHeader; chunkOffset: number } {
  const { text, chunkOffset } = readHeaderLine(file);
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    // Names the likeliest cause rather than only the parse error: a PRETTY-PRINTED whole-JSON
    // capture - which the committed test fixtures are - has `{` on its first line, so it arrives
    // here rather than at the format check below.
    throw new Error(
      `Fixture "${file}" does not begin with a parseable header line (${(error as Error).message}). A ` +
        `"${FIXTURE_FORMAT}" capture carries its whole header on one line; a whole-JSON capture keeps ` +
        'its chunks in the same document as its queries and cannot be spliced.'
    );
  }
  if (typeof raw !== 'object' || raw === null || (raw as { format?: unknown }).format !== FIXTURE_FORMAT) {
    throw new Error(
      `Fixture "${file}" does not declare format "${FIXTURE_FORMAT}". A whole-JSON capture keeps its ` +
        'chunks in the same document as its queries, so there is no header line to rewrite.'
    );
  }
  return { header: FixtureHeaderSchema.parse(raw), chunkOffset };
}

/**
 * Write a new capture carrying `queries` over this one's chunk lines, copied byte for byte.
 *
 * Extending a capture's question set costs the embedding of the new questions and nothing else: the
 * corpus vectors are already on disk and are the expensive half. Re-capturing to add a question
 * instead has a worse problem than cost - a live lake moves, so the new fixture would be a
 * DIFFERENT corpus, and two question sets measured either side of that are not one table. This keeps
 * the snapshot fixed and changes only what is asked of it.
 *
 * The chunk lines are moved as bytes, never parsed and re-serialized, so a float cannot be reprinted
 * at a different precision and the copy is verified by counting lines against the header's declared
 * `chunkCount`. On a mismatch the output is deleted: a fixture with new queries over a short corpus
 * scores as a complete one, which is the failure the count exists to prevent.
 */
export function rewriteFixtureQueries(args: { source: string; out: string; queries: EmbeddingFixture['queries'] }): {
  chunkLines: number;
  queries: number;
} {
  const { header, chunkOffset } = readEmbeddingFixtureHeader(args.source);
  if (resolve(args.source) === resolve(args.out)) {
    throw new Error(
      `Refusing to rewrite "${args.source}" in place: the chunk lines are read from it while the new ` +
        'header is written, so the corpus would be truncated by its own replacement.'
    );
  }
  if (args.queries.length === 0) {
    throw new Error(`Refusing to write "${args.out}" with no queries; a capture with none scores nothing.`);
  }
  const offWidth = args.queries.filter(q => q.vector.length !== header.dims);
  if (offWidth.length > 0) {
    throw new Error(
      `Capture "${header.corpus}" is ${header.dims} dims but ${offWidth.length} new query vector(s) ` +
        `are not (${offWidth
          .slice(0, 5)
          .map(q => `${q.id}:${q.vector.length}`)
          .join(', ')}). Cosine ` +
        'across two widths scores 0 and disappears into the ranking as an ordinary low score.'
    );
  }
  const seen = new Set<string>();
  const duplicates = [
    ...new Set(args.queries.filter(q => (seen.has(q.id) ? true : (seen.add(q.id), false))).map(q => q.id)),
  ];
  if (duplicates.length > 0) {
    throw new Error(`Refusing to write repeated query id(s): ${duplicates.join(', ')}.`);
  }
  // Mirrors `resolveQueries`: a half-external query set cannot be scored, because the queries without
  // ground truth fall back to corpus.ts and silently mix two of them.
  const external = args.queries.filter(q => q.supporting !== undefined).length;
  if (external !== 0 && external !== args.queries.length) {
    throw new Error(
      `Refusing to write ground truth on ${external} of ${args.queries.length} queries; a partly ` +
        'external question set scores against two ground truths at once.'
    );
  }

  const src = openSync(args.source, 'r');
  const dst = openSync(args.out, 'w');
  let lines = 0;
  let offset = chunkOffset;
  let lastByte = NEWLINE;
  try {
    writeSync(dst, `${JSON.stringify({ ...header, queries: args.queries })}\n`);
    const buf = Buffer.allocUnsafe(CHUNK_COPY_CHUNK);
    for (;;) {
      const read = readSync(src, buf, 0, CHUNK_COPY_CHUNK, offset);
      if (read === 0) break;
      writeSync(dst, buf, 0, read);
      const slice = buf.subarray(0, read);
      for (let at = slice.indexOf(NEWLINE); at !== -1; at = slice.indexOf(NEWLINE, at + 1)) lines++;
      lastByte = slice[read - 1];
      offset += read;
    }
  } finally {
    closeSync(src);
    closeSync(dst);
  }
  // A final chunk line with no trailing break still holds a chunk.
  if (offset > chunkOffset && lastByte !== NEWLINE) lines++;
  if (lines !== header.chunkCount) {
    unlinkSync(args.out);
    throw new Error(
      `Copied ${lines} chunk line(s) from "${args.source}" whose header declares ${header.chunkCount}. ` +
        'Refusing to leave a capture with new queries over a short corpus - it would score as a ' +
        'complete one over a smaller lake.'
    );
  }
  return { chunkLines: lines, queries: args.queries.length };
}

export function writeEmbeddingFixtureFile(file: string, fixture: EmbeddingFixture): void {
  const { chunks, ...meta } = fixture;
  const fd = openSync(file, 'w');
  try {
    writeSync(fd, `${JSON.stringify({ ...meta, format: FIXTURE_FORMAT, chunkCount: chunks.length })}\n`);
    for (let i = 0; i < chunks.length; i += FIXTURE_WRITE_BATCH) {
      writeSync(
        fd,
        `${chunks
          .slice(i, i + FIXTURE_WRITE_BATCH)
          .map(c => JSON.stringify(c))
          .join('\n')}\n`
      );
    }
  } finally {
    closeSync(fd);
  }
}

/**
 * Read a capture from disk and validate it exactly as `loadEmbeddingFixture` does.
 *
 * Also accepts a pre-format capture, which is a single JSON document. The line format announces
 * itself in its header, and anything else is read whole - not the other way round, because the
 * committed synthetic fixtures are PRETTY-PRINTED, so their first line is bare `{` and only a
 * whole-file parse can read them. Keying off the file extension would be worse still: the runbook
 * points both CLIs at a `.json` that is a real capture.
 */
export function readEmbeddingFixtureFile(file: string): EmbeddingFixture {
  const buf = readFileSync(file);
  const firstBreak = buf.indexOf(NEWLINE);
  let header: unknown;
  try {
    header = JSON.parse(buf.toString('utf8', 0, firstBreak === -1 ? buf.length : firstBreak));
  } catch {
    header = undefined;
  }
  const isLineFormat =
    typeof header === 'object' && header !== null && (header as { format?: unknown }).format === FIXTURE_FORMAT;
  if (!isLineFormat) {
    try {
      return loadEmbeddingFixture(JSON.parse(buf.toString('utf8')) as unknown);
    } catch (error) {
      throw new Error(
        `Fixture "${file}" is neither a "${FIXTURE_FORMAT}" header line nor a whole JSON capture: ` +
          `${(error as Error).message}`
      );
    }
  }

  const parsedHeader = FixtureHeaderSchema.parse(header);
  const chunks: unknown[] = [];
  let offset = firstBreak === -1 ? buf.length : firstBreak + 1;
  while (offset < buf.length) {
    const found = buf.indexOf(NEWLINE, offset);
    const end = found === -1 ? buf.length : found;
    const line = buf.toString('utf8', offset, end).trim();
    offset = end + 1;
    if (line === '') continue;
    try {
      chunks.push(JSON.parse(line));
    } catch (error) {
      throw new Error(
        `Fixture "${file}" chunk line ${chunks.length + 1} is unparseable: ${(error as Error).message}. ` +
          'A capture interrupted mid-write ends in a partial line; re-capture rather than trimming it.'
      );
    }
  }
  if (chunks.length !== parsedHeader.chunkCount) {
    throw new Error(
      `Fixture "${file}" declares ${parsedHeader.chunkCount} chunks but carries ${chunks.length}. ` +
        'A truncated capture scores as a complete one over a smaller corpus, so this refuses rather ' +
        'than reporting floors measured against whatever survived. Re-capture.'
    );
  }
  // The header's own `format` and `chunkCount` are dropped here by the schema, which strips unknown
  // keys - they describe the file, not the capture.
  return loadEmbeddingFixture({ ...parsedHeader, chunks });
}

/**
 * One `model@width` arm derived from a full-width fixture.
 *
 * `arm` is `model@dims`, never the model alone - the vector space is the model AND the width, and
 * naming an arm by its model would let two different spaces share a row label.
 */
export type DerivedArm = {
  arm: string;
  chunks: ScorableChunk[];
  queries: { id: string; vector: number[] }[];
  filesInScope: number;
  chunksExcluded: number;
  filesExcluded: number;
  filesUnreachable: number;
};

/**
 * Models whose vectors survive prefix truncation, so that a narrower arm is a real embedding rather
 * than the first N coordinates of one.
 *
 * Matryoshka is a property of a specific model, not of embeddings (see the MEMENTO_EMBEDDING_DIMS
 * docblock and b4m-core/memory/src/eval/dimensions.test.ts). `text-embedding-ada-002` predates MRL,
 * as do the Bedrock and Ollama embedders - a truncated ada-002 vector is not an embedding of
 * anything, and rendering it as a width arm next to a legitimate `3-small@512` row puts a number in
 * the decision table that measures nothing.
 *
 * `voyage-3-large` is left out for a different reason: it DOES ship MRL widths, but they come from
 * the provider's own `output_dimension` parameter at embed time, not from truncating a full-width
 * vector here. Deriving one by truncation would be an unverified claim about that model, so this
 * harness scores it at its capture width and a Voyage width arm has to be captured, not derived.
 */
const MATRYOSHKA_MODELS = new Set<string>([
  OpenAIEmbeddingModel.TEXT_EMBEDDING_3_SMALL,
  OpenAIEmbeddingModel.TEXT_EMBEDDING_3_LARGE,
]);

/**
 * May a narrower arm be derived from this capture?
 *
 * A synthetic fixture has to say so itself. `capture-embeddings.ts` validates every model against
 * the shipped registry before it spends, so no real capture carries an unregistered id - but the
 * comparison path parses a fixture FILE, whose `model` is only `z.string().min(1)`. Treating
 * "unregistered" as "synthetic" therefore made a typo (`text-embedding-ada-oo2`) truncatable, and
 * rendered its width arms beside a legitimate `3-small@512` - exactly what this gate exists to
 * prevent. The committed test fixtures set `syntheticMatryoshka` instead, so the two signals stay
 * separate.
 *
 * The flag cannot promote a model the registry DOES know: `text-embedding-ada-002` stays non-MRL
 * however a fixture is labelled.
 */
export function isTruncatableModel(fixture: Pick<EmbeddingFixture, 'model' | 'syntheticMatryoshka'>): boolean {
  if (MATRYOSHKA_MODELS.has(fixture.model)) return true;
  return fixture.syntheticMatryoshka === true && !isSupportedEmbeddingModel(fixture.model);
}

/**
 * Truncate a fixture to `dims` and renormalize - exactly what OpenAI's `dimensions` parameter does,
 * and the same arithmetic `toMementoVector` and the memory eval's width sweep apply, so the two
 * evals produce identical vectors for the same width.
 *
 * Reuses the shipped `truncateAndNormalize` (packages/scripts/help/utils.ts) rather than carrying a
 * third copy of five lines of arithmetic. At FULL width that helper returns the input array as-is
 * rather than renormalizing, so the full-width arm aliases the fixture's own vectors - which is
 * correct here (captured vectors are already unit-norm and cosine is scale-invariant) but means the
 * arm must be treated as read-only.
 *
 * Two widths are rejected rather than rendered. Widening past the capture is not a no-op, it is a
 * request for information the capture never held; narrowing a non-Matryoshka model produces a number
 * that measures nothing (see `isTruncatableModel`).
 */
export function deriveArm(fixture: EmbeddingFixture, dims: number): DerivedArm {
  if (dims > fixture.dims) {
    throw new Error(
      `Cannot derive a ${dims}-dim arm from a ${fixture.dims}-dim capture of ${fixture.model}. ` +
        'Matryoshka truncation only goes narrower; re-capture at the wider width.'
    );
  }
  if (dims < fixture.dims && !isTruncatableModel(fixture)) {
    throw new Error(
      `${fixture.model} is not a Matryoshka model, so a ${dims}-dim prefix of its ${fixture.dims}-dim ` +
        'vectors is not an embedding - it is the first coordinates of one. Score it at its capture ' +
        'width only.'
    );
  }
  return {
    arm: `${fixture.model}@${dims}`,
    chunks: fixture.chunks.map(c => ({
      chunkId: c.chunkId,
      docId: c.docId,
      vector: truncateAndNormalize(c.vector, dims),
    })),
    queries: fixture.queries.map(q => ({ id: q.id, vector: truncateAndNormalize(q.vector, dims) })),
    filesInScope: fixture.filesInScope,
    chunksExcluded: fixture.chunksExcluded,
    filesExcluded: fixture.filesExcluded,
    filesUnreachable: fixture.filesUnreachable,
  };
}

/**
 * Chunk char-length distribution and chunks-per-file - the corpus-regime gate.
 *
 * This is a GATE, not a footnote. The whole reason this ticket exists is that `3-small` was chosen
 * on a corpus of short facts, and the argument for it ("the extra capacity is for long/hard
 * documents") is exactly the argument that does not transfer to the FAB corpus's ~2200-char prose
 * passages. A capture whose median chunk is far short of that is not in the regime the question is
 * about, and a model verdict read off it inherits the very bias this ticket exists to remove.
 *
 * The prod reference to compare against: 589 chunks over 49 files (~12 per file), median 2182 chars.
 */
export type CorpusRegime = {
  files: number;
  chunks: number;
  chunksPerFile: number;
  minChars: number;
  medianChars: number;
  p90Chars: number;
  maxChars: number;
};

export function corpusRegime(chunks: readonly { docId: string; charLength: number }[], files?: number): CorpusRegime {
  if (chunks.length === 0) {
    return { files: files ?? 0, chunks: 0, chunksPerFile: 0, minChars: 0, medianChars: 0, p90Chars: 0, maxChars: 0 };
  }
  const lengths = chunks.map(c => c.charLength).sort((a, b) => a - b);
  // Nearest-rank percentile: reports a value that a real chunk actually has, rather than an
  // interpolated length no passage in the corpus is.
  const at = (q: number) => lengths[Math.min(lengths.length - 1, Math.ceil(q * lengths.length) - 1)];
  const fileCount = files ?? new Set(chunks.map(c => c.docId)).size;
  return {
    files: fileCount,
    chunks: chunks.length,
    chunksPerFile: fileCount === 0 ? 0 : chunks.length / fileCount,
    minChars: lengths[0],
    medianChars: at(0.5),
    p90Chars: at(0.9),
    maxChars: lengths[lengths.length - 1],
  };
}

/** The prod corpus this comparison is about: ~12 chunks/file, median passage ~2182 chars. */
export const PROD_REGIME_REFERENCE = { chunksPerFile: 12, medianChars: 2182 };

/**
 * Is this capture in the long-document regime the model question is actually about?
 *
 * Half the prod median is the line. It is a deliberately loose bound - the point is to catch a
 * corpus of short facts or one-line rows masquerading as the FAB corpus, not to insist a second
 * lake match prod to the character.
 */
export function isLongDocumentRegime(regime: CorpusRegime): boolean {
  return regime.medianChars >= PROD_REGIME_REFERENCE.medianChars / 2;
}

export function formatCorpusRegime(regime: CorpusRegime): string {
  return [
    `files                : ${regime.files}`,
    `chunks               : ${regime.chunks} (${regime.chunksPerFile.toFixed(1)} per file)`,
    `chunk chars          : min ${regime.minChars}, median ${regime.medianChars}, p90 ${regime.p90Chars}, max ${regime.maxChars}`,
    `prod reference       : ~${PROD_REGIME_REFERENCE.chunksPerFile} per file, median ${PROD_REGIME_REFERENCE.medianChars} chars`,
    `long-document regime : ${isLongDocumentRegime(regime) ? 'yes' : 'NO - a model verdict from this corpus does not answer the question'}`,
  ].join('\n');
}
