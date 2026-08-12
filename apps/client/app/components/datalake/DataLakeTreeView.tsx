import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Box, CircularProgress, Input, List, Skeleton, Typography } from '@mui/joy';
import type { SxProps } from '@mui/joy/styles/types';
import SearchIcon from '@mui/icons-material/Search';
import type { TagNode } from '@client/app/components/Files/Browser/TagView/parseTagNamespace';
import { getNodeAtPath, getNodesAtPath } from '@client/app/components/Files/Browser/TagView/parseTagNamespace';
import type { TreeSortMode } from './treeChrome';
import { useGetDataLakeArticles, type DataLakeBrowseSource } from '@client/app/hooks/data/dataLakes';
import type { IFabFileDocument } from '@bike4mind/common';

/** Search terms shorter than this are dropped server-side anyway (see fabFileSearchQuery),
 *  so firing the cross-tree query below this length would only add noisy round trips. */
const MIN_SEARCH_LENGTH = 2;
/** Cross-tree article search fires this long after the last keystroke. */
const SEARCH_DEBOUNCE_MS = 300;

/**
 * Synthetic breadcrumb key for the Viewer's "files with no prefix-matching tag" bucket.
 * Kept identical to the manager's constant so both surfaces mean the same bucket.
 */
export const UNCATEGORIZED_KEY = '__uncategorized__';

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
export interface DataLakeTreeChrome {
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
  /** When set, the back row renders INSIDE the scroll pane wrapped in this sx (the chat
   *  tree's pinned back row); when absent it renders as a sibling above the scroll pane. */
  stickyBackSx?: SxProps;
  scrollSx: SxProps;
  nodeListSx: SxProps;
  fileListSx: SxProps;
  renderNodeRow: (node: TagNode, depth: number, onOpen: () => void) => ReactNode;
  renderFileRow: (file: IFabFileDocument, selected: boolean, onSelect: () => void) => ReactNode;
  /** Human label for a raw tag segment at a depth (taxonomy-aware per surface). */
  humanize: (segment: string, depth: number) => string;
  /** Back-crumb label when popping out of a first-level branch. */
  allCategoriesLabel: string;
  emptyFilesLabel: string;
  errorLabel: string;
}

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
}: DataLakeTreeViewProps) {
  const [searchQuery, setSearchQuery] = useState('');
  const [sortBy, setSortBy] = useState<TreeSortMode>('count');

  // Debounced so cross-tree article search (below) doesn't fire on every keystroke; folder
  // filtering stays on the raw query since it's already-loaded local data.
  const [debouncedSearch, setDebouncedSearch] = useState('');
  useEffect(() => {
    const trimmed = searchQuery.trim();
    if (!trimmed) return;
    const handle = setTimeout(() => setDebouncedSearch(trimmed), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(handle);
  }, [searchQuery]);
  // Clearing the box reflects immediately rather than through the debounce above - otherwise
  // the stale "Articles" section would linger for up to SEARCH_DEBOUNCE_MS after the folder
  // tree has already reappeared underneath it.
  const effectiveSearch = searchQuery.trim() ? debouncedSearch : '';

  // The synthetic bucket intercepts before leaf-tag resolution: its key is not a real tag.
  const isUncategorized = !!uncategorized && breadcrumb.length === 1 && breadcrumb[0] === UNCATEGORIZED_KEY;

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

  // At a leaf node (no children), files are filtered locally by the leaf tag.
  const leafTag = !isUncategorized && breadcrumb.length > 0 && currentNodes.length === 0 ? breadcrumb.join(':') : null;
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
  // titles/tags/notes anywhere in scope via the server - not just this level's segment names.
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
  const ownTag = !isUncategorized && !leafTag && breadcrumb.length > 0 ? breadcrumb.join(':') : null;
  const ownFiles = useMemo(() => {
    if (!ownTag || !currentNode?.ownFileCount) return [];
    return articles.filter(f => (f.tags ?? []).some(t => t.name === ownTag)).sort(compareByCategoryThenTitle);
  }, [ownTag, currentNode, articles]);
  // Hidden while searching, matching the uncategorized bucket: search filters folder segments,
  // not files, so a folder's own files are not "search results" either.
  const showOwnFiles = !searchQuery && ownFiles.length > 0;

  const showBucketRow = !!uncategorized && breadcrumb.length === 0 && !searchQuery && uncategorized.files.length > 0;
  // The bucket / own-files rows standing in for an empty node list are still content, and a
  // pending/matched article search might still fill the pane - none of that should flash
  // "No categories"/"No matches" while it's about to be superseded.
  const showNodeEmpty =
    filteredNodes.length === 0 &&
    !showBucketRow &&
    !showOwnFiles &&
    !(treeSearchActive && (treeSearchLoading || treeSearchArticles.length > 0));

  const backRow =
    breadcrumb.length > 0
      ? chrome.renderBackRow(
          breadcrumb.length === 1
            ? chrome.allCategoriesLabel
            : chrome.humanize(breadcrumb[breadcrumb.length - 2], breadcrumb.length - 2),
          () => onNavigate(breadcrumb.slice(0, -1))
        )
      : null;

  return (
    <Box data-testid="datalake-tree" sx={chrome.containerSx}>
      {header}

      {/* Search bar + sort toggle */}
      <Box sx={chrome.toolbarSx}>
        <Input
          size="sm"
          placeholder={chrome.searchPlaceholder}
          startDecorator={<SearchIcon sx={{ fontSize: 18 }} />}
          endDecorator={treeSearchActive && treeSearchLoading ? <CircularProgress size="sm" /> : undefined}
          value={searchQuery}
          onChange={e => setSearchQuery(e.target.value)}
          data-testid="datalake-search"
          sx={chrome.searchSx}
        />
        {/* The toggle only ever reorders the folder list below - a pure file view (leaf or the
            uncategorized bucket) always sorts by category then title, so showing an interactive
            control that visibly does nothing there would read as broken. */}
        {!showFiles && chrome.renderSortButton(sortBy, () => setSortBy(prev => (prev === 'count' ? 'alpha' : 'count')))}
      </Box>

      {/* Back row above the scroll pane unless the chrome pins it inside (chat tree). */}
      {!chrome.stickyBackSx && backRow}

      <Box sx={chrome.scrollSx}>
        {chrome.stickyBackSx && backRow && <Box sx={chrome.stickyBackSx}>{backRow}</Box>}
        {isError ? (
          <Box sx={{ p: 2, textAlign: 'center' }} data-testid="datalake-error">
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
              files.map(f => chrome.renderFileRow(f, selectedFileIds.has(f.id), () => onSelectFile(f)))
            )}
          </List>
        ) : (
          /* Folder tree, own-tagged files mixed in, plus (while searching) articles matched
             anywhere in scope below it. */
          <>
            <List size="sm" sx={chrome.nodeListSx}>
              {filteredNodes.map(node =>
                chrome.renderNodeRow(node, breadcrumb.length, () => onNavigate([...breadcrumb, node.segment]))
              )}
              {showBucketRow &&
                uncategorized!.renderRow(uncategorized!.files.length, () => onNavigate([UNCATEGORIZED_KEY]))}
              {showOwnFiles &&
                ownFiles.map(f => chrome.renderFileRow(f, selectedFileIds.has(f.id), () => onSelectFile(f)))}
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
                  {treeSearchArticles.map(f =>
                    chrome.renderFileRow(f, selectedFileIds.has(f.id), () => onSelectFile(f))
                  )}
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
