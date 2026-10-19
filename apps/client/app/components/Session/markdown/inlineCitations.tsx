import { ComponentProps, createContext, FC, ReactNode, useContext } from 'react';
import type { ExtraProps } from 'react-markdown';
import type { Parent, Root, RootContent, Text } from 'mdast';
import { Link } from '@mui/joy';
import remarkParse from 'remark-parse';
import { unified } from 'unified';
import { findCitationMarkers, type CitableSource, type CitationMarkerMatch } from '@bike4mind/common';
import { useCitableSourceClick } from '../useCitableSourceClick';

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
const markersIn = ({ text, numbers }: CitationMarkerMatch): Text[] => {
  if (numbers.length === 1) return [markerText(text, numbers[0].value)];

  const pieces: Text[] = [];
  let cursor = 0;
  for (const { value, digits, offset } of numbers) {
    pieces.push(plainText(text.slice(cursor, offset)));
    pieces.push(markerText(digits, value));
    cursor = offset + digits.length;
  }
  pieces.push(plainText(text.slice(cursor)));
  return pieces;
};

const splitCitationMarkers = (node: Text): Text[] => {
  const markers = findCitationMarkers(node.value);
  if (markers.length === 0) return [node];

  const pieces: Text[] = [];
  let cursor = 0;
  for (const marker of markers) {
    if (marker.start > cursor) pieces.push(plainText(node.value.slice(cursor, marker.start)));
    pieces.push(...markersIn(marker));
    cursor = marker.start + marker.text.length;
  }
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

// Code is never prose, and raw HTML is not shown as text; must stay in step with what
// remarkCitationMarkers visits (text nodes only).
const NON_PROSE = new Set(['code', 'inlineCode', 'html']);

/**
 * The text a reader sees in reply markdown: every text node, including link text, plus each link's
 * URL (a reference-style link's URL lives on its definition), with code spans, code blocks and raw
 * HTML left out. What the Sources list scans to decide
 * which sources a reply cites (CitableSources), so a file name or `[1]` inside code is not a citation.
 */
export const replyProse = (markdown: string): string => {
  const parts: string[] = [];
  const visit = (node: Root | RootContent): void => {
    if (NON_PROSE.has(node.type)) return;
    if (node.type === 'text') parts.push(node.value);
    if (node.type === 'link' || node.type === 'definition') parts.push(node.url);
    if ('children' in node) node.children.forEach(visit);
  };
  visit(unified().use(remarkParse).parse(markdown));
  return parts.join(' ');
};

/** The reply's `promptMeta.citables`, which merge in mid-stream (useStreamingMessageMerge). */
export const ReplyCitablesContext = createContext<readonly CitableSource[]>([]);

/**
 * Whether this reply's `[N]` markers can be trusted to mean `citables[N-1]`: every citable must
 * carry the stamp of its own position. Retrieval and registered tools share a turn-wide
 * numbering scheme; legacy or mixed output without those stamps remains plain text.
 */
export const citationMarkersLinkable = (citables: readonly CitableSource[]): boolean =>
  citables.length > 0 && citables.every((source, position) => source.metadata?.citationIndex === position + 1);

/** Linking waits for the finished reply: a tool citable merging mid-stream would pull the links back out. */
export const shouldLinkCitationMarkers = (citables: readonly CitableSource[], completed: boolean): boolean =>
  completed && citationMarkersLinkable(citables);

export const resolveCitationMarker = (citables: readonly CitableSource[], index: number): CitableSource | undefined =>
  citationMarkersLinkable(citables) ? citables[index - 1] : undefined;

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
      underline="always"
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
