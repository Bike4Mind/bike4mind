/**
 * Sample chunk text from a corpus for AUTHORING POSITIVES, blind to what any floor served.
 *
 * WHY THIS EXISTS, AND WHY NOT THE SCREEN'S DOCUMENT. A sweep over negatives can only observe false
 * positives, so the floor it fits carries a lower bound and no upper one: at the point a floor serves
 * a negative nothing it may also be serving a real question nothing, and negatives cannot tell the
 * two apart. Closing that needs positives whose supporting set is exact rather than guessed. The
 * tempting shortcut is to author from the chunks the screen already read back - they are on disk, and
 * they are precisely the chunks that scored top against 89 arbitrary questions. Authoring questions
 * from generically attractive text and then measuring recall over it flatters the floor by
 * construction, which is the one result this cannot afford.
 *
 * So the population is the whole captured corpus and the selection never looks at a score.
 *
 * STRATIFIED BY FILE, NOT UNIFORM OVER CHUNKS. Uniform over chunks is uniform over corpus MASS, so a
 * 500-chunk file takes a sixth of a 40-chunk sample and the authored questions end up describing that
 * file instead of the corpus. Files are ranked, chunks are ranked within each file, and the walk takes
 * one chunk from every file before a second from any - so a `count` above the file count stays spread
 * rather than piling onto whichever file sorted first.
 *
 * DETERMINISTIC WITHOUT AN RNG. Rank is `sha256(<seed>:<id>)`, so a file's or chunk's position depends
 * on the seed and its own id and on nothing else in the corpus. The same seed re-draws the same sample
 * after the corpus has grown, which is what makes a second measurement comparable to the first, and a
 * different seed draws an independent one. `Math.random()` would give neither.
 */

import { createHash } from 'node:crypto';

/** The three fields a capture fixture carries per chunk. Text is read back separately, by id. */
export type SampleableChunk = { chunkId: string; docId: string; charLength: number };

export type ChunkSampleRequest = {
  chunks: readonly SampleableChunk[];
  count: number;
  /** Any string. Recorded in the rendered document so a sample can be re-drawn from the doc alone. */
  seed: string;
  /**
   * Chunk ids to hold out - the served set of a screen already done, so the same text is not both
   * the negatives evidence and the positives ground truth. At corpus scale this is a rounding error
   * (382 of 21,327 on the lake this was built for) and it withholds the corpus's most attractive
   * chunks, so it biases the resulting recall figure DOWN. That is the safe direction for a floor.
   */
  excludeChunkIds?: readonly string[];
  /**
   * Drop chunks shorter than this many code points. Default 0, deliberately: a length filter narrows
   * the corpus a floor is then measured over, and short chunks are exactly the ones the char budget
   * and the floor treat differently. Any nonzero value is a stated narrowing, not housekeeping.
   */
  minChars?: number;
};

export type ChunkSample = {
  picked: SampleableChunk[];
  seed: string;
  /** Distinct files in the corpus before any holding-out, so the stratification can be sanity-checked. */
  filesInCorpus: number;
  filesSampled: number;
  /** Requested but unavailable, i.e. the corpus ran out of eligible chunks. */
  shortfall: number;
  excludedByHoldout: number;
  excludedByMinChars: number;
};

/** Stable rank for one id under one seed. Hex, so a lexicographic sort is the numeric one. */
const rank = (seed: string, id: string): string =>
  createHash('sha256').update(`${seed}:${id}`, 'utf8').digest('hex').slice(0, 16);

/**
 * Pick `count` chunks, stratified by file and deterministic under `seed`.
 *
 * Holds out and length-filters BEFORE stratifying, so a file whose every chunk is ineligible drops
 * out of the file ranking entirely rather than consuming a slot and contributing nothing.
 */
export function selectChunkSample(request: ChunkSampleRequest): ChunkSample {
  const { chunks, count, seed } = request;
  if (!Number.isInteger(count) || count < 1) {
    throw new Error(`Sample count must be a positive integer, got "${count}".`);
  }
  const minChars = request.minChars ?? 0;
  const holdout = new Set(request.excludeChunkIds ?? []);

  const filesInCorpus = new Set(chunks.map(c => c.docId)).size;
  let excludedByHoldout = 0;
  let excludedByMinChars = 0;
  const eligible: SampleableChunk[] = [];
  for (const chunk of chunks) {
    if (holdout.has(chunk.chunkId)) {
      excludedByHoldout++;
      continue;
    }
    if (chunk.charLength < minChars) {
      excludedByMinChars++;
      continue;
    }
    eligible.push(chunk);
  }

  const byFile = new Map<string, SampleableChunk[]>();
  for (const chunk of eligible) {
    const existing = byFile.get(chunk.docId);
    if (existing) existing.push(chunk);
    else byFile.set(chunk.docId, [chunk]);
  }
  for (const fileChunks of byFile.values()) {
    fileChunks.sort((a, b) => rank(seed, a.chunkId).localeCompare(rank(seed, b.chunkId)));
  }
  const files = [...byFile.keys()].sort((a, b) => rank(seed, a).localeCompare(rank(seed, b)));

  // Round-robin rather than file-at-a-time: `count` above the file count then spreads a second chunk
  // across the whole corpus instead of taking two from the first file and one from nothing else.
  const picked: SampleableChunk[] = [];
  const sampledFiles = new Set<string>();
  for (let depth = 0; picked.length < count; depth++) {
    const before = picked.length;
    for (const file of files) {
      if (picked.length >= count) break;
      const chunk = byFile.get(file)?.[depth];
      if (!chunk) continue;
      picked.push(chunk);
      sampledFiles.add(file);
    }
    if (picked.length === before) break; // every file exhausted
  }

  return {
    picked,
    seed,
    filesInCorpus,
    filesSampled: sampledFiles.size,
    shortfall: count - picked.length,
    excludedByHoldout,
    excludedByMinChars,
  };
}

const truncate = (text: string, maxChars: number): string =>
  text.length <= maxChars ? text : `${text.slice(0, maxChars)}\n\n[truncated at ${maxChars} chars]`;

/** Blockquote so a multi-paragraph passage reads as one unit, as in the served-text screen. */
const quote = (text: string): string =>
  text
    .split('\n')
    .map(line => `> ${line}`)
    .join('\n');

/**
 * Render the sample as an authoring worksheet: one section per chunk, its text, and a prefilled
 * question record to complete.
 *
 * The record is prefilled with the file id because `supporting` is scored at DOCUMENT level
 * (`metrics.ts` intersects accepted doc ids with it), and on a real lake that id is a bare ObjectId
 * nobody should be retyping from a heading.
 */
export function formatChunkSampleDoc(args: {
  sample: ChunkSample;
  model: string;
  dims: number;
  corpus: string;
  /** Chunk id -> text, as read back from the corpus. A missing id is marked, never rendered blank. */
  texts: ReadonlyMap<string, string>;
  count: number;
  minChars?: number;
  maxChars?: number;
  idPrefix?: string;
}): string {
  const { sample, model, dims, corpus, texts, count } = args;
  const maxChars = args.maxChars ?? 4000;
  const idPrefix = args.idPrefix ?? 'p';
  const missing = sample.picked.filter(c => !texts.has(c.chunkId));

  const lines: string[] = [
    `# Positives worksheet: ${corpus}`,
    '',
    `${model}@${dims}, ${sample.picked.length} of ${count} requested chunks, ` +
      `drawn from ${sample.filesSampled} of ${sample.filesInCorpus} files, seed \`${sample.seed}\``,
    '',
    `Held out: ${sample.excludedByHoldout} chunk(s) already screened as negatives evidence` +
      (args.minChars ? `; ${sample.excludedByMinChars} below ${args.minChars} chars` : ''),
    '',
    'HOW TO AUTHOR FROM THIS. For each passage, write the question a reader who needed exactly this',
    'material would ask - specific enough that the rest of the corpus would not answer it, and worded',
    'as a person asks rather than as the passage is written. Fill the `question` field in the record',
    'under each passage; `supporting` is already the file this chunk belongs to.',
    '',
    'MARK A PASSAGE UNUSABLE RATHER THAN SKIPPING IT. A bibliography, a table of contents, licence',
    'boilerplate or a fragment mid-sentence cannot ground a question, and the SHARE of the sample that',
    'is unusable is itself a measurement - those chunks sit in the candidate pool and can be served to',
    'anything. Delete the record (the question file rejects an empty question) and write down which ids',
    'were dropped and why, so the skip is a recorded number rather than a silent narrowing.',
    '',
    'TWO PROPERTIES OF THIS GROUND TRUTH, so neither reads as a defect later. `supporting` names one',
    'file, and scoring is at file level, so retrieval counts as a hit when ANY chunk of that file is',
    'accepted - not only the passage the question came from. And the set is a LOWER bound: another',
    'file may genuinely answer the question too, which costs precision and cannot cost recall. Recall',
    'is the half a floor decision needs, and it is unaffected.',
  ];

  if (missing.length > 0) {
    lines.push(
      '',
      `NOTE: ${missing.length} of ${sample.picked.length} sampled chunk ids are no longer in the corpus ` +
        'and render as missing below. Re-vectorization replaces chunk rows, so a capture and a later ' +
        'read can legitimately disagree; a large share here means the fixture describes a corpus that ' +
        'has moved and the capture should be repeated before anything is authored from it.'
    );
  }

  sample.picked.forEach((chunk, index) => {
    const id = `${idPrefix}${String(index + 1).padStart(2, '0')}`;
    const text = texts.get(chunk.chunkId);
    lines.push(
      '',
      '---',
      '',
      `## ${id} - chunk ${chunk.chunkId} (file ${chunk.docId})`,
      '',
      `${chunk.charLength} chars`,
      '',
      text === undefined ? '> (missing from the corpus at read time)' : quote(truncate(text, maxChars)),
      '',
      '```json',
      `{ "id": "${id}", "question": "", "supporting": ["${chunk.docId}"] }`,
      '```'
    );
  });
  return `${lines.join('\n')}\n`;
}
