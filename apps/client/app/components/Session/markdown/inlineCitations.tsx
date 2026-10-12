import { ComponentProps, createContext, FC, ReactNode, useContext } from 'react';
import type { ExtraProps } from 'react-markdown';
import type { Parent, Root, RootContent, Text } from 'mdast';
import { Link } from '@mui/joy';
import type { CitableSource } from '@bike4mind/common';
import { useCitableSourceClick } from '../useCitableSourceClick';

// One- or two-digit markers, alone or comma-listed, so `[2016]` is never a citation. Must stay in
// sync with the lake RAG eval's marker regex (b4m-core/services/src/llm/evals/lakeRag/grade.ts).
const CITATION_MARKER = /\[(\d{1,2}(?:\s*,\s*\d{1,2})*)\]/g;
const MARKER_NUMBER = /\d{1,2}/g;

/** `<cite>` because markdown never produces one, so the override cannot catch anything else. */
export const CITATION_MARKER_TAG = 'cite';
const CITATION_INDEX_PROPERTY = 'dataCitationIndex';

// Bracket text inside these is already a link; a marker there must not nest a second one.
const SKIPPED_PARENTS = new Set(['link', 'linkReference']);

const plainText = (value: string): Text => ({ type: 'text', value });

const markerText = (value: string, index: number): Text => ({
  type: 'text',
  value,
  data: { hName: CITATION_MARKER_TAG, hProperties: { [CITATION_INDEX_PROPERTY]: index } },
});

/** A single `[N]` keeps its brackets inside the marker for a bigger target; a list marks each N. */
const markersIn = (marker: string, numbers: string): Text[] => {
  const indices = [...numbers.matchAll(MARKER_NUMBER)];
  if (indices.length === 1) return [markerText(marker, Number(numbers))];

  const pieces: Text[] = [plainText('[')];
  let cursor = 0;
  for (const { 0: digits, index: start } of indices) {
    if (start > cursor) pieces.push(plainText(numbers.slice(cursor, start)));
    pieces.push(markerText(digits, Number(digits)));
    cursor = start + digits.length;
  }
  pieces.push(plainText(']'));
  return pieces;
};

const splitCitationMarkers = (node: Text): Text[] => {
  const pieces: Text[] = [];
  let cursor = 0;
  for (const { 0: marker, 1: numbers, index: start } of node.value.matchAll(CITATION_MARKER)) {
    if (start > cursor) pieces.push(plainText(node.value.slice(cursor, start)));
    pieces.push(...markersIn(marker, numbers));
    cursor = start + marker.length;
  }
  if (cursor === 0) return [node];
  if (cursor < node.value.length) pieces.push(plainText(node.value.slice(cursor)));
  return pieces;
};

const markCitations = (parent: Parent): void => {
  if (SKIPPED_PARENTS.has(parent.type)) return;
  parent.children = parent.children.flatMap((child: RootContent): RootContent[] => {
    if (child.type === 'text') return splitCitationMarkers(child);
    if ('children' in child) markCitations(child);
    return [child];
  });
};

/**
 * Marks every `[N]` in prose as a citation marker for `CitationMarker` to resolve. Only `text`
 * nodes are visited, so code spans and code blocks (which hold a `value`, not text children) are
 * never touched. Whether a marker links is decided at render time, so it can wait for its citable.
 */
export const remarkCitationMarkers = () => (tree: Root) => markCitations(tree);

/** The reply's `promptMeta.citables`, which merge in mid-stream (useStreamingMessageMerge). */
export const ReplyCitablesContext = createContext<readonly CitableSource[]>([]);

/**
 * `[N]` answers to `citables[N-1]` only when that citable was stamped with N: the server stamps
 * just the index-aligned forced-retrieval prefix of an indexed-style session, so knowledge-tool
 * and named-style citables never resolve.
 */
export const resolveCitationMarker = (citables: readonly CitableSource[], index: number): CitableSource | undefined => {
  const source = citables[index - 1];
  return source?.metadata?.citationIndex === index ? source : undefined;
};

/** Whether any citable can answer to a marker, i.e. whether the reply needs the marker pass at all. */
export const hasCitationMarkers = (citables: readonly CitableSource[]): boolean =>
  citables.some(source => typeof source.metadata?.citationIndex === 'number');

const CitationMarkerLink: FC<{ source: CitableSource; index: number; children: ReactNode }> = ({
  source,
  index,
  children,
}) => {
  const { renderAsButton, onClick } = useCitableSourceClick(source);
  if (!renderAsButton && !source.url) return <>{children}</>;

  const shared = {
    // Leads with the visible `[N]` so a voice user can say what they see (WCAG 2.5.3).
    'aria-label': `[${index}] ${source.title}`,
    title: source.title,
    'data-testid': 'citation-marker-link',
    level: 'inherit',
  } as const;

  if (!renderAsButton) {
    // `.b4m-md a` (observatory.css) already draws the reply's link rule; a Joy underline doubles it.
    return (
      <Link {...shared} underline="none" href={source.url} target="_blank" rel="noopener noreferrer">
        {children}
      </Link>
    );
  }
  return (
    <Link
      {...shared}
      component="button"
      type="button"
      underline="hover"
      onClick={onClick}
      sx={{ font: 'inherit', p: 0, border: 0, bgcolor: 'transparent', verticalAlign: 'baseline' }}
    >
      {children}
    </Link>
  );
};

/** The `cite` override for reply markdown: a resolvable marker links, any other stays plain text. */
export const CitationMarker: FC<ComponentProps<'cite'> & ExtraProps> = ({ node, children, ...rest }) => {
  const citables = useContext(ReplyCitablesContext);
  const index = node?.properties?.[CITATION_INDEX_PROPERTY];
  if (typeof index !== 'number') return <cite {...rest}>{children}</cite>;

  const source = resolveCitationMarker(citables, index);
  if (!source) return <>{children}</>;
  return (
    <CitationMarkerLink source={source} index={index}>
      {children}
    </CitationMarkerLink>
  );
};
