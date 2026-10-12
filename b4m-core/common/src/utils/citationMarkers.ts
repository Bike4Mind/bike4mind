// One- or two-digit numbers, alone or comma-listed, so a bracketed year or count (`[2016]`,
// `[146]`) is never read as a citation.
const CITATION_MARKER = /\[(\d{1,2}(?:\s*,\s*\d{1,2})*)\]/g;
const MARKER_NUMBER = /\d{1,2}/g;

export type CitationMarkerNumber = {
  /** The cited source's 1-based index: `[N]` answers to `citables[N-1]` on an indexed session. */
  value: number;
  /** The number exactly as written, e.g. `01`. */
  digits: string;
  /** Offset of `digits` inside the marker's `text`. */
  offset: number;
};

export type CitationMarkerMatch = {
  /** The whole marker as written, e.g. `[1, 3]`. */
  text: string;
  /** Offset of the marker in the scanned string. */
  start: number;
  numbers: CitationMarkerNumber[];
};

/**
 * Every indexed-style citation marker in `text`. The one definition of what counts as a marker,
 * shared by the reply renderer that links them and the lake RAG eval that grades them, so the UI
 * never links a marker the eval would not count, or the reverse.
 */
export const findCitationMarkers = (text: string): CitationMarkerMatch[] =>
  [...text.matchAll(CITATION_MARKER)].map(({ 0: marker, index: start }) => ({
    text: marker,
    start,
    numbers: [...marker.matchAll(MARKER_NUMBER)].map(({ 0: digits, index: offset }) => ({
      value: Number(digits),
      digits,
      offset,
    })),
  }));
