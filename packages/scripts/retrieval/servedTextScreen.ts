/**
 * The screening half of `--emit-served`: pair each question with the TEXT of what a floor served it.
 *
 * WHY THIS EXISTS. A floor sweep can say a negative question was served six chunks; it cannot say
 * whether those six actually answered it, and that difference decides whether the question was a
 * true negative at all. A capture fixture carries chunk ids, vectors and lengths - no text, and for
 * a production lake no file names either - so the judgement needs the text read back. Reading it
 * from FILE NAMES instead is a known way to get the opposite answer, which is why this pairs
 * question text with chunk text and offers nothing else to judge from.
 *
 * Pure: parsing, selection and formatting only. `fetch-served-text.ts` is the driver that does the
 * one read this needs.
 */

import { z } from 'zod';

/** One floor point's served sets, as `forced-floor-sweep.ts --emit-served` writes them. */
export const ServedFloorSchema = z.object({
  /** `formatFloorConfig`'s label - all three floors named, so two points cannot collide. */
  floor: z.string().min(1),
  distinctServedChunkIds: z.array(z.string()),
  queries: z.array(
    z.object({
      id: z.string().min(1),
      /** 0 marks a deliberate NEGATIVE: the question the corpus is not supposed to answer. */
      supportingCount: z.number().int().nonnegative(),
      accepted: z.number().int().nonnegative(),
      topScore: z.number(),
      servedChunkIds: z.array(z.string()),
    })
  ),
});

export const ServedEmissionSchema = z.object({
  model: z.string().min(1),
  dims: z.number().int().positive(),
  corpus: z.string().min(1),
  charBudget: z.number().int().positive(),
  floors: z.array(ServedFloorSchema).min(1),
});

export type ServedFloor = z.infer<typeof ServedFloorSchema>;
export type ServedEmission = z.infer<typeof ServedEmissionSchema>;

export function loadServedEmission(raw: unknown, source: string): ServedEmission {
  const result = ServedEmissionSchema.safeParse(raw);
  if (!result.success) {
    throw new Error(
      `Served-ids file "${source}" is not a --emit-served emission: ` +
        result.error.issues.map(i => `${i.path.join('.')} ${i.message}`).join('; ')
    );
  }
  return result.data;
}

/**
 * Pick the floor point to screen.
 *
 * `wanted` matches a floor label as a substring, so `absolute=49%` selects without retyping the
 * whole label. An AMBIGUOUS or absent selector throws rather than defaulting to the first point: a
 * screen names its floor in the heading, and silently screening the wrong one produces a document
 * that reads as the right one. A single-point emission needs no selector - there is nothing to pick.
 */
export function selectServedFloor(emission: ServedEmission, wanted?: string): ServedFloor {
  const labels = emission.floors.map(f => f.floor);
  if (wanted === undefined) {
    if (emission.floors.length === 1) return emission.floors[0];
    throw new Error(
      `This emission holds ${labels.length} floor points; pass --floor to pick one of: ${labels.join(' | ')}`
    );
  }
  const matches = emission.floors.filter(f => f.floor === wanted || f.floor.includes(wanted));
  if (matches.length === 1) return matches[0];
  if (matches.length === 0) throw new Error(`No floor point matching "${wanted}". Available: ${labels.join(' | ')}`);
  throw new Error(`"${wanted}" matches ${matches.length} floor points: ${matches.map(m => m.floor).join(' | ')}`);
}

/** A chunk's text as read back from the corpus. `fabFileId` is context, never the thing judged. */
export type ServedChunkText = { id: string; fabFileId: string; text: string };

const truncate = (text: string, maxChars: number): string =>
  text.length <= maxChars ? text : `${text.slice(0, maxChars)}\n\n[truncated at ${maxChars} chars]`;

/** Blockquote a chunk so a multi-paragraph passage stays visually one served unit. */
const quote = (text: string): string =>
  text
    .split('\n')
    .map(line => `> ${line}`)
    .join('\n');

/**
 * Render the screen as Markdown: one section per question, each served chunk's text under it.
 *
 * Questions with an EMPTY served set are kept and marked. They are the ones the floor already
 * refuses, and a screen that dropped them would read as though every question in the set got
 * something - which is the measurement being checked.
 */
export function formatServedScreen(args: {
  emission: ServedEmission;
  floor: ServedFloor;
  texts: ReadonlyMap<string, ServedChunkText>;
  /** Question id -> question text. An id absent here renders as unknown rather than blank. */
  questions: ReadonlyMap<string, string>;
  maxChars?: number;
}): string {
  const { emission, floor, texts, questions } = args;
  const maxChars = args.maxChars ?? 1500;
  const missing = floor.distinctServedChunkIds.filter(id => !texts.has(id));
  const negatives = floor.queries.filter(q => q.supportingCount === 0);
  const served = floor.queries.filter(q => q.servedChunkIds.length > 0);

  const lines: string[] = [
    `# Served-chunk screen: ${emission.corpus}`,
    '',
    `${emission.model}@${emission.dims}, floor \`${floor.floor}\`, char budget ${emission.charBudget}`,
    '',
    `${floor.queries.length} questions (${negatives.length} negative candidates), ` +
      `${served.length} served something, ${floor.distinctServedChunkIds.length} distinct chunks.`,
    '',
    'For each question below, decide from the TEXT whether this corpus genuinely answers it. A',
    'question the corpus does answer is not a negative, and counting it as one inflates the',
    'false-positive rate the floor is being graded on. Judge the passages, not the file ids.',
  ];

  if (missing.length > 0) {
    lines.push(
      '',
      `NOTE: ${missing.length} of ${floor.distinctServedChunkIds.length} served chunk ids are no longer ` +
        'in the corpus and render as missing below. Re-vectorization replaces chunk rows, so a ' +
        'capture and a later read can legitimately disagree; a large share here means the screen is ' +
        'being done against a corpus that has moved and the capture should be repeated.'
    );
  }

  for (const query of floor.queries) {
    lines.push(
      '',
      '---',
      '',
      `## ${query.id} - ${query.supportingCount === 0 ? 'NEGATIVE candidate' : `${query.supportingCount} supporting doc(s)`}`,
      '',
      `**Question:** ${questions.get(query.id) ?? '(not in the questions file)'}`,
      '',
      `accepted ${query.accepted}, served ${query.servedChunkIds.length}, top score ${query.topScore.toFixed(4)}`
    );
    if (query.servedChunkIds.length === 0) {
      lines.push('', 'Served NOTHING - the floors emptied this turn.');
      continue;
    }
    query.servedChunkIds.forEach((chunkId, index) => {
      const chunk = texts.get(chunkId);
      lines.push(
        '',
        `### served ${index + 1}/${query.servedChunkIds.length} - chunk ${chunkId}` +
          (chunk ? ` (file ${chunk.fabFileId})` : ''),
        ''
      );
      lines.push(chunk ? quote(truncate(chunk.text, maxChars)) : '> (missing from the corpus at read time)');
    });
  }
  return `${lines.join('\n')}\n`;
}
