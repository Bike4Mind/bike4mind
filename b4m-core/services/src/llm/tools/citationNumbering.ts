import { areCitablesNumbered, type CitableSource } from '@bike4mind/common';

/**
 * One [N] numbering per turn: in an indexed-citation session, `[N]` in the reply means
 * `promptMeta.citables[N - 1]`, so every citable carries `metadata.citationIndex === position + 1`.
 * Forced retrieval stamps its own prefix (ChatCompletionFeatures); tools extend the same sequence
 * through ToolContext.numberCitables and write those numbers into their output.
 */

/** The identity the citables merge dedupes on (see applyQuestStatusChanges). */
export const citableKey = (citable: Pick<CitableSource, 'id' | 'url' | 'title'>): string | undefined =>
  citable.id || citable.url || citable.title || undefined;

/**
 * Stamp `incoming` with the positions the citables merge will give them after `existing`: a
 * citable already present (or repeated within `incoming`) keeps its first position, and a new one
 * is appended. Returns one stamped copy per input, in input order, so a tool can label each of its
 * results with the number the reader will click.
 *
 * Returns undefined when the turn cannot be numbered: `existing` is no longer numbered (a tool that
 * labels its own results locally already merged), or an incoming citable has no identity and would
 * be dropped by the merge. The caller then keeps its own local labels.
 */
export function assignCitationIndices(
  existing: readonly CitableSource[],
  incoming: readonly CitableSource[]
): CitableSource[] | undefined {
  if (!areCitablesNumbered(existing)) return undefined;
  const positionByKey = new Map<string, number>();
  existing.forEach((citable, position) => {
    const key = citableKey(citable);
    if (key !== undefined && !positionByKey.has(key)) positionByKey.set(key, position);
  });
  let nextPosition = existing.length;
  const stamped: CitableSource[] = [];
  for (const citable of incoming) {
    const key = citableKey(citable);
    if (key === undefined) return undefined;
    let position = positionByKey.get(key);
    if (position === undefined) {
      position = nextPosition++;
      positionByKey.set(key, position);
    }
    stamped.push({ ...citable, metadata: { ...citable.metadata, citationIndex: position + 1 } });
  }
  return stamped;
}

/**
 * Whether a merge that added `incoming` keeps the turn's numbering. True only when every incoming
 * citable arrived stamped (it went through assignCitationIndices, so its producer labelled its
 * output with that number) and the merged list is still numbered by position. A producer that
 * labels its results locally (1., 2.) sends unstamped citables, and then an [N] is ambiguous.
 */
export const mergeKeepsCitationNumbering = (
  incoming: readonly CitableSource[],
  merged: readonly CitableSource[]
): boolean => incoming.every(citable => citable.metadata?.citationIndex !== undefined) && areCitablesNumbered(merged);

/** Drop every citationIndex stamp, which turns the client's inline [N] links off for the turn. */
export const stripCitationIndices = (citables: readonly CitableSource[]): CitableSource[] =>
  citables.map(citable => {
    if (citable.metadata?.citationIndex === undefined) return citable;
    const { citationIndex: _stamp, ...metadata } = citable.metadata;
    return { ...citable, metadata };
  });

/**
 * Shown to the model under tool results that carry the turn's shared numbers, so it cites them the
 * way forced retrieval's header asks it to cite the documents numbered before them.
 */
export const INDEXED_TOOL_CITATION_RULE =
  'Cite each of these sources ONLY by the bracketed number it is labelled with, placed immediately after the ' +
  'claim it supports. These numbers continue the sources already numbered this turn.';

/** Each stamped citable's number, keyed by citable id, for labelling results that point at it. */
export const citationNumbersById = (citables: readonly CitableSource[]): Map<string, number> =>
  new Map(
    citables.flatMap(citable =>
      citable.metadata?.citationIndex === undefined ? [] : [[citable.id, citable.metadata.citationIndex] as const]
    )
  );
