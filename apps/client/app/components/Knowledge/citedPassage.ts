/**
 * Locating the passage a lake citation points at, inside the document the reader lands on (#3038).
 *
 * The passage text a citation carries is not a byte-for-byte slice of the document: the serve path
 * trims it, clips it at a character budget with a trailing ellipsis, and defangs it by inserting a
 * leading space on any line that opens with a prompt marker (defangRetrievedContent). Every one of
 * those edits is whitespace or a known suffix, so a whitespace-normalized search recovers the match
 * - and an exact `indexOf` would miss on most real passages.
 */

import type { CitableSource } from '@bike4mind/common';
import type { CitedPassage } from '@client/app/hooks/useSessionLayout';

/** The clip marker `servedPassageText` appends; never present in the document itself. */
const CLIP_MARKER = '\u2026';

type NormalizedText = {
  /** Whitespace-collapsed text, suitable for `indexOf` against another normalization of it. */
  text: string;
  /** `offsets[i]` is the index in the ORIGINAL string of `text[i]`. Same length as `text`. */
  offsets: number[];
};

/**
 * Collapse every run of whitespace to a single space and drop leading/trailing runs, keeping a
 * per-character map back to the source. The map is what lets a normalized hit become a source
 * range; without it the search would only answer "is it in there", not "where".
 */
function normalizeWithOffsets(value: string): NormalizedText {
  const chars: string[] = [];
  const offsets: number[] = [];
  let pendingSpace = false;
  for (let i = 0; i < value.length; i++) {
    const ch = value[i];
    if (/\s/.test(ch)) {
      // Only a run that has something after it becomes a space, so a trailing run adds nothing.
      pendingSpace = chars.length > 0;
      continue;
    }
    if (pendingSpace) {
      chars.push(' ');
      offsets.push(i);
      pendingSpace = false;
    }
    chars.push(ch);
    offsets.push(i);
  }
  return { text: chars.join(''), offsets };
}

/** Half-open `[start, end)` range into the document source. */
export type PassageRange = { start: number; end: number };

/**
 * Where `passage` sits in `source`, or null when it cannot be found.
 *
 * Returns null rather than a best guess: an approximate range would scroll the reader to the wrong
 * paragraph and assert - with a highlight - that it is the cited one, which is worse than showing
 * the document unmarked. Callers are expected to fall back to rendering the passage separately.
 */
export function locateCitedPassage(source: string, passage: string): PassageRange | null {
  const withoutClipMarker = passage.endsWith(CLIP_MARKER) ? passage.slice(0, -CLIP_MARKER.length) : passage;
  const needle = normalizeWithOffsets(withoutClipMarker);
  if (needle.text.length === 0) return null;

  const haystack = normalizeWithOffsets(source);
  const hit = haystack.text.indexOf(needle.text);
  if (hit === -1) return null;

  const lastChar = hit + needle.text.length - 1;
  // `+ 1` makes the range half-open: offsets index the LAST character, and a caller comparing
  // against an exclusive block end would otherwise drop a block ending exactly on the passage.
  return { start: haystack.offsets[hit], end: haystack.offsets[lastChar] + 1 };
}

/**
 * Whether a rendered block's source range overlaps the cited passage, i.e. whether it should be
 * marked. Both ranges are half-open, so blocks that merely abut the passage are excluded - marking
 * the paragraph after the passage would widen the claim the highlight makes.
 */
export function blockIntersectsPassage(
  block: { start?: number; end?: number } | undefined,
  passage: PassageRange
): boolean {
  if (block?.start === undefined || block?.end === undefined) return false;
  return block.start < passage.end && block.end > passage.start;
}

/**
 * The passage anchor a citation chip carries, or null when it has none (#3038).
 *
 * Both fields are required: `chunkId` without the text cannot be resolved to a location (nothing
 * reads a chunk back by id), and the text without an id has nothing for the curator surfaces to
 * key on. The file-level retrieval arms - keyword search and whole-document retrieve - deliberately
 * set neither, so a chip from those lands the reader on the whole document as before.
 */
export function citedPassageOf(source: CitableSource): CitedPassage | null {
  const { chunkId, fullContext } = source.metadata ?? {};
  if (typeof chunkId !== 'string' || chunkId.length === 0) return null;
  if (typeof fullContext !== 'string' || fullContext.trim().length === 0) return null;
  return { fileId: source.id, chunkId, passage: fullContext };
}
