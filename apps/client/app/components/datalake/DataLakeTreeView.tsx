import { Fragment, useEffect, useMemo, useState, type ReactNode } from 'react';
import { Box, CircularProgress, Input, List, Skeleton, Typography } from '@mui/joy';
import type { SxProps } from '@mui/joy/styles/types';
import SearchIcon from '@mui/icons-material/Search';
import type { TagNode } from '@client/app/components/Files/Browser/TagView/parseTagNamespace';
import { getNodeAtPath, getNodesAtPath } from '@client/app/components/Files/Browser/TagView/parseTagNamespace';
import { useGetDataLakeArticles, type DataLakeBrowseSource } from '@client/app/hooks/data/dataLakes';
import type { IFabFileDocument } from '@bike4mind/common';

/** Search terms shorter than this are dropped server-side anyway (see fabFileSearchQuery),
 *  so firing the cross-tree query below this length would only add noisy round trips. */
const MIN_SEARCH_LENGTH = 2;
/** Cross-tree article search fires this long after the last keystroke. */
const SEARCH_DEBOUNCE_MS = 300;

/**
 * Synthetic breadcrumb key for the "files with no prefix-matching tag" bucket. TreeView owns
 * the constant; every surface that navigates the bucket (the Viewer, the manager nav) imports
 * it from here so the two can never drift.
 */
export const UNCATEGORIZED_KEY = '__uncategorized__';

/** How the tree lists order their rows. Declared here (the source of truth); treeChrome.ts
 *  re-exports it so a third mode is added in one place, alongside its icon. */
export type TreeSortMode = 'count' | 'alpha';

/** Splits "[Category] Title.ext" into [category, title] so files sharing a bracketed source
 *  prefix sort by the group then the title instead of piling up on the shared leading "[". */
function categoryTitleKey(fileName: string): [string, string] {
  const withoutExt = fileName.replace(/\.[^/.]+$/, '');
  const match = withoutExt.match(/^\[(.*?)\]\s*(.*)$/);
  return match ? [match[1], match[2]] : ['', withoutExt];
}

function compareByCategoryThenTitle(a: IFabFileDocument, b: IFabFileDocument): number {
  const [categoryA, titleA] = categoryTitleKey(a.fileName);
  const [categoryB, titleB] = categoryTitleKey(b.fileName);
  return categoryA.localeCompare(categoryB) || titleA.localeCompare(titleB);
}

/**
 * Everything visual about a tree surface, injected by the shell that owns the look:
 * the page tree derives its chrome from surfaceTokens, the chat tree from treeChrome,
 * the discover viewer keeps its neutral look. TreeView itself owns only logic and
 * structure - if a knob here starts encoding BEHAVIOR, it belongs in TreeView instead.
 */
export type DataLakeTreeChrome = {
  /** Outer column: width, borders, background - the surface's visual identity. */
  containerSx: SxProps;
  /** Search + sort toolbar wrapper. */
  toolbarSx: SxProps;
  searchPlaceholder: string;
  searchSx: SxProps;
  /** Sort toggle; TreeView owns the mode state, the chrome owns the button. Must carry
   *  data-testid="datalake-sort-toggle" and data-sort={sortBy} for the shared tests. */
  renderSortButton: (sortBy: TreeSortMode, toggle: () => void) => ReactNode;
  /** Back row (chrome carries data-testid="datalake-back"). */
  renderBackRow: (label: string, onBack: () => void) => ReactNode;
  scrollSx: SxProps;
  nodeListSx: SxProps;
  fileListSx: SxProps;
  /** Must NOT set a React `key` - TreeView wraps each row in a keyed Fragment and owns list identity. */
  renderNodeRow: (node: TagNode, depth: number, onOpen: () => void) => ReactNode;
  /** Must NOT set a React `key` - TreeView wraps each row in a keyed Fragment and owns list identity. */
  renderFileRow: (file: IFabFileDocument, selected: boolean, onSelect: () => void) => ReactNode;
  /** Human label for a raw tag segment at a depth (taxonomy-aware per surface). */
  humanize: (segment: string, depth: number) => string;
  /** Back-crumb label when popping out of a first-level branch. */
  allCategoriesLabel: string;
  emptyFilesLabel: string;
  errorLabel: string;
} & (
  | {
      /** The back row renders as a sibling before the scroll pane. */
      backRowPlacement: 'above';
      stickyBackSx?: never;
    }
  | {
      /** The back row renders INSIDE the scroll pane, pinned by this sx - the union makes the
       *  pairing unrepresentable to forget (a sticky placement with no sx silently unpins). */
      backRowPlacement: 'sticky';
      stickyBackSx: SxProps;
    }
);

export interface DataLakeTreeViewProps {
  tree: TagNode[];
  /** All articles in scope, used to resolve leaf-tag files locally without extra API calls. */
  articles: IFabFileDocument[];
  breadcrumb: string[];
  onNavigate: (breadcrumb: string[]) => void;
  /** Which browse backend to search - see useGetDataLakeArticles. Drives the cross-tree article
   *  search below (#1693); the tag tree / leaf files themselves still come from `tree`/`articles`.
   *  Omit to disable cross-tree search (e.g. a single-lake browser where "across the tree" would
   *  incorrectly reach every accessible lake) - local search within the loaded scope still works. */
  source?: DataLakeBrowseSource;
  /** File ids to render highlighted - "attached to the prompt" in chat mode, or the single
   *  file open in the reader in page mode. Not just the most recently clicked file, so an
   *  earlier pick stays highlighted after a later one is added. */
  selectedFileIds: ReadonlySet<string>;
  onSelectFile: (file: IFabFileDocument) => void;
  isLoading: boolean;
  isError?: boolean;
  chrome: DataLakeTreeChrome;
  /**
   * Optional root bucket for files that carry no prefix-matching tag (the Viewer), so every
   * file stays reachable. TreeView owns the visibility rules (root only, hidden while
   * searching) and the synthetic-breadcrumb interception; the chrome renders the row.
   */
  uncategorized?: {
    files: IFabFileDocument[];
    renderRow: (count: number, onOpen: () => void) => ReactNode;
  };
  /** Slots above the toolbar / below the scroll pane (the chat tree's header and footer). */
  header?: ReactNode;
  footer?: ReactNode;
  /** Controlled search query; falls back to internal state when omitted. */
  search?: string;
  /**
   * Called on every search change regardless of control mode. When `search` is omitted
   * (uncontrolled), internal state still updates too, so a host that only wants to observe
   * changes can pass this alone without breaking typing.
   */
  onSearchChange?: (q: string) => void;
  /** Controlled sort mode; falls back to internal state when omitted. */
  sort?: TreeSortMode;
  /**
   * Called on every sort change regardless of control mode. When `sort` is omitted
   * (uncontrolled), internal state still updates too, so a host that only wants to observe
   * changes can pass this alone without breaking the toggle.
   */
  onSortChange?: (s: TreeSortMode) => void;
  /** Skips the search/sort toolbar entirely (a host that supplies its own). */
  hideToolbar?: boolean;
  /**
   * Depth at which the seeded `breadcrumb` root is treated as depth 0 for leaf/bucket gating,
   * so a host (e.g. the manager, seeded at a lake's own root) can nest TreeView below its own
   * navigation without the seeded root itself being mistaken for a leaf. The seeded root's
   * back SEMANTICS stay the host's concern: its chrome's renderBackRow may ignore TreeView's
   * label/onBack and bind its own (ManagerNav's exits the lake at the seeded root); TreeView
   * still owns placement and only requires `breadcrumb.length > 0` (or `alwaysShowBackRow`).
   */
  leafMinDepth?: number;
  /**
   * Render the back row even at an empty breadcrumb - for hosts whose back affordance doubles
   * as an exit control (the chrome's renderBackRow typically supplies its own label/handler then).
   */
  alwaysShowBackRow?: boolean;
  /** Renamed test ids for hosts embedding more than one TreeView instance. */
  testIds?: { container?: string; error?: string };
}

export default function DataLakeTreeView({
  tree,
  articles,
  breadcrumb,
  onNavigate,
  source,
  selectedFileIds,
  onSelectFile,
  isLoading,
  isError,
  chrome,
  uncategorized,
  header,
  footer,
  search,
  onSearchChange,
  sort,
  onSortChange,
  hideToolbar,
  leafMinDepth = 0,
  alwaysShowBackRow,
  testIds,
}: DataLakeTreeViewProps) {
  const [internalSearch, setInternalSearch] = useState('');
  const [internalSort, setInternalSort] = useState<TreeSortMode>('count');
  const searchQuery = search ?? internalSearch;
  const sortBy = sort ?? internalSort;
  const setSearch = (q: string) => {
    if (search === undefined) setInternalSearch(q);
    onSearchChange?.(q);
  };
  const setSort = (s: TreeSortMode) => {
    if (sort === undefined) setInternalSort(s);
    onSortChange?.(s);
  };
  const containerTestId = testIds?.container ?? 'datalake-tree';
  const errorTestId = testIds?.error ?? 'datalake-error';

  // Debounced so cross-tree article search (below) doesn't fire on every keystroke; folder
  // filtering stays on the raw query since it's already-loaded local data.
  const [debouncedSearch, setDebouncedSearch] = useState('');
  useEffect(() => {
    const trimmed = searchQuery.trim();
    if (!trimmed) return;
    const handle = setTimeout(() => setDebouncedSearch(trimmed), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(handle);
  }, [searchQuery]);
  // Dropping below MIN_SEARCH_LENGTH (including clearing entirely) reflects immediately rather
  // than through the debounce above - otherwise a stale "Articles" section from a longer prior
  // query would linger for up to SEARCH_DEBOUNCE_MS after what's currently typed no longer
  // qualifies for a search at all.
  const effectiveSearch = searchQuery.trim().length >= MIN_SEARCH_LENGTH ? debouncedSearch : '';

  const currentNodes = useMemo(() => getNodesAtPath(tree, breadcrumb), [tree, breadcrumb]);
  const currentNode = useMemo(() => getNodeAtPath(tree, breadcrumb), [tree, breadcrumb]);

  const filteredNodes = useMemo(() => {
    let nodes = currentNodes;
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase();
      nodes = nodes.filter(node => node.segment.toLowerCase().includes(q));
    }
    return [...nodes].sort((a, b) =>
      sortBy === 'count' ? b.fileCount - a.fileCount : a.segment.localeCompare(b.segment)
    );
  }, [currentNodes, searchQuery, sortBy]);

  // The synthetic bucket intercepts before leaf-tag resolution: its key is not a real tag. It
  // lives one level below the seeded root, and the depth bound is a ceiling rather than an
  // equality so a host that renders a breadcrumb SHORTER than leafMinDepth (the manager's
  // deep-link opens a lake at an empty path) still reaches its bucket.
  const isUncategorized =
    !!uncategorized &&
    breadcrumb.length <= leafMinDepth + 1 &&
    breadcrumb[breadcrumb.length - 1] === UNCATEGORIZED_KEY;

  // At a leaf node (no children) below the seeded root, files are filtered locally by the leaf tag.
  const leafTag =
    !isUncategorized && breadcrumb.length > leafMinDepth && currentNodes.length === 0 ? breadcrumb.join(':') : null;
  const showFiles = isUncategorized || !!leafTag;
  const bucketFiles = uncategorized?.files;
  const files = useMemo(() => {
    const scoped = isUncategorized
      ? bucketFiles!
      : leafTag
        ? articles.filter(f => (f.tags ?? []).some(t => t.name === leafTag))
        : [];
    const q = searchQuery.trim().toLowerCase();
    const matched = q ? scoped.filter(f => f.fileName.toLowerCase().includes(q)) : scoped;
    return [...matched].sort(compareByCategoryThenTitle);
  }, [isUncategorized, bucketFiles, leafTag, articles, searchQuery]);

  // Cross-tree article search (#1693): while browsing folders, a query also reaches article
  // titles/tags/notes across EVERY lake/tag the caller can access - not scoped to the current
  // breadcrumb or folder, since the server search takes no tags/path filter. Intentional: the
  // Explorer already merges multiple lakes into one tag tree, so this matches that merged scope.
  // Skipped at a leaf/bucket since `files` above already searches the (already-loaded) scope.
  const treeSearchActive = !showFiles && !!source && effectiveSearch.length >= MIN_SEARCH_LENGTH;
  const { data: treeSearchResult, isLoading: treeSearchLoading } = useGetDataLakeArticles(
    treeSearchActive ? { search: effectiveSearch, limit: 20 } : null,
    source
  );
  const treeSearchArticles = treeSearchActive ? (treeSearchResult?.data ?? []) : [];

  // A branch node (has children) can ALSO carry files tagged with its own exact path, not just
  // a deeper child tag. Render those as file rows mixed into the folder list below, so the view
  // reads like a normal file browser (folders + files together) instead of hiding them behind a
  // folder that only ever contains itself.
  const ownTag = !isUncategorized && !leafTag && breadcrumb.length > leafMinDepth ? breadcrumb.join(':') : null;
  const ownFiles = useMemo(() => {
    if (!ownTag || !currentNode?.ownFileCount) return [];
    return articles.filter(f => (f.tags ?? []).some(t => t.name === ownTag)).sort(compareByCategoryThenTitle);
  }, [ownTag, currentNode, articles]);
  // Hidden while searching, matching the uncategorized bucket: search filters folder segments,
  // not files, so a folder's own files are not "search results" either.
  const showOwnFiles = !searchQuery && ownFiles.length > 0;

  // A ceiling, matching isUncategorized above: the bucket belongs at the seeded root, and a
  // breadcrumb shallower than leafMinDepth is still that root as far as the host is concerned.
  const showBucketRow =
    !!uncategorized && breadcrumb.length <= leafMinDepth && !searchQuery && bucketFiles!.length > 0;
  // The bucket / own-files rows standing in for an empty node list are still content, and a
  // pending/matched article search might still fill the pane - none of that should flash
  // "No categories"/"No matches" while it's about to be superseded.
  const showNodeEmpty =
    filteredNodes.length === 0 &&
    !showBucketRow &&
    !showOwnFiles &&
    !(treeSearchActive && (treeSearchLoading || treeSearchArticles.length > 0));

  // The seeded-root back row (if any) is normally the host's concern (e.g. ManagerNav renders
  // its own); TreeView's own back row cares whether it has somewhere to go back to, OR whether
  // the host opted into `alwaysShowBackRow` because its back affordance doubles as an exit
  // control (a degenerate seeded root can otherwise silently remove the only way out).
  const backRow =
    breadcrumb.length > 0 || alwaysShowBackRow
      ? chrome.renderBackRow(
          breadcrumb.length <= 1
            ? chrome.allCategoriesLabel
            : chrome.humanize(breadcrumb[breadcrumb.length - 2], breadcrumb.length - 2),
          () => onNavigate(breadcrumb.slice(0, -1))
        )
      : null;

  return (
    <Box data-testid={containerTestId} sx={chrome.containerSx}>
      {header}

      {/* Search bar + sort toggle */}
      {!hideToolbar && (
        <Box sx={chrome.toolbarSx}>
          <Input
            size="sm"
            placeholder={chrome.searchPlaceholder}
            startDecorator={<SearchIcon sx={{ fontSize: 18 }} />}
            endDecorator={treeSearchActive && treeSearchLoading ? <CircularProgress size="sm" /> : undefined}
            value={searchQuery}
            onChange={e => setSearch(e.target.value)}
            data-testid="datalake-search"
            sx={chrome.searchSx}
          />
          {/* The toggle only ever reorders the folder list below - a pure file view (leaf or the
              uncategorized bucket) always sorts by category then title, so showing an interactive
              control that visibly does nothing there would read as broken. */}
          {!showFiles && chrome.renderSortButton(sortBy, () => setSort(sortBy === 'count' ? 'alpha' : 'count'))}
        </Box>
      )}

      {/* Back row above the scroll pane unless the chrome pins it inside (chat tree). */}
      {chrome.backRowPlacement === 'above' && backRow}

      <Box sx={chrome.scrollSx}>
        {chrome.backRowPlacement === 'sticky' && backRow && <Box sx={chrome.stickyBackSx}>{backRow}</Box>}
        {isError ? (
          <Box sx={{ p: 2, textAlign: 'center' }} data-testid={errorTestId}>
            <Typography level="body-xs" sx={{ color: 'danger.400' }}>
              {chrome.errorLabel}
            </Typography>
          </Box>
        ) : isLoading ? (
          <Box sx={{ p: 1.5, display: 'flex', flexDirection: 'column', gap: 1 }}>
            {[1, 2, 3, 4].map(i => (
              <Skeleton key={i} variant="rectangular" height={32} sx={{ borderRadius: 'sm' }} />
            ))}
          </Box>
        ) : showFiles ? (
          /* File list at a leaf (or the uncategorized bucket) */
          <List size="sm" sx={chrome.fileListSx}>
            {files.length === 0 ? (
              <Box sx={{ p: 2, textAlign: 'center' }}>
                <Typography level="body-xs" sx={{ color: 'text.tertiary' }}>
                  {chrome.emptyFilesLabel}
                </Typography>
              </Box>
            ) : (
              files.map(f => (
                <Fragment key={f.id}>
                  {chrome.renderFileRow(f, selectedFileIds.has(f.id), () => onSelectFile(f))}
                </Fragment>
              ))
            )}
          </List>
        ) : (
          /* Folder tree, own-tagged files mixed in, plus (while searching) articles matched
             anywhere in scope below it. */
          <>
            <List size="sm" sx={chrome.nodeListSx}>
              {filteredNodes.map(node => (
                <Fragment key={node.segment}>
                  {chrome.renderNodeRow(node, breadcrumb.length, () => onNavigate([...breadcrumb, node.segment]))}
                </Fragment>
              ))}
              {/* Single conditional child, not a .map element - a key here would be inert. */}
              {showBucketRow &&
                uncategorized!.renderRow(uncategorized!.files.length, () =>
                  onNavigate([...breadcrumb, UNCATEGORIZED_KEY])
                )}
              {showOwnFiles &&
                ownFiles.map(f => (
                  <Fragment key={f.id}>
                    {chrome.renderFileRow(f, selectedFileIds.has(f.id), () => onSelectFile(f))}
                  </Fragment>
                ))}
              {showNodeEmpty && (
                <Box sx={{ p: 2, textAlign: 'center' }}>
                  <Typography level="body-xs" sx={{ color: 'text.tertiary' }}>
                    {searchQuery ? 'No matches' : 'No categories'}
                  </Typography>
                </Box>
              )}
            </List>
            {treeSearchActive && treeSearchArticles.length > 0 && (
              <>
                <Typography
                  level="body-xs"
                  sx={{ px: 1.5, pt: filteredNodes.length > 0 ? 1 : 0, pb: 0.5, color: 'text.tertiary' }}
                >
                  Articles
                </Typography>
                <List size="sm" sx={chrome.fileListSx} data-testid="datalake-search-articles">
                  {treeSearchArticles.map(f => (
                    <Fragment key={f.id}>
                      {chrome.renderFileRow(f, selectedFileIds.has(f.id), () => onSelectFile(f))}
                    </Fragment>
                  ))}
                </List>
              </>
            )}
          </>
        )}
      </Box>

      {footer}
    </Box>
  );
}
