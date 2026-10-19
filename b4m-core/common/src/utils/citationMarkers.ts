// One- or two-digit numbers, alone or comma-listed, so a bracketed year or count (`[2016]`,
// `[146]`) is never read as a citation. Spaces and tabs only between numbers: the reply renderer
// splits text at a line break, so a list spanning one could not be linked there.
const CITATION_MARKER = /\[(\d{1,2}(?:[ \t]*,[ \t]*\d{1,2})*)\]/g;
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

/**
 * Whether `text` names the source `name` the way a named-style reply cites one: `galilean-moons.md`
 * matches "galilean-moons.md", "galilean-moons" or "Galilean Moons". Shared by the lake RAG eval
 * that grades a named citation and the Sources list that puts cited sources first, so the two
 * agree on what counts as citing a source by name. A name with no words matches nothing.
 */
export const sourceNamedIn = (text: string, name: string): boolean => {
  // Typed as a string, but citables are read back from stored documents; a malformed one must not
  // throw while rendering a reply.
  if (typeof name !== 'string') return false;
  const words = name
    .replace(/\.[a-z0-9]+$/i, '')
    .split(/[\s_-]+/)
    .filter(Boolean)
    .map(word => word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  if (words.length === 0) return false;
  // Lookarounds, not `\b`: a name that starts or ends in punctuation, e.g. `notes (v2).md`, has no
  // word boundary there.
  return new RegExp(`(?<!\\w)${words.join('[\\s_-]+')}(?!\\w)`, 'i').test(text);
};
