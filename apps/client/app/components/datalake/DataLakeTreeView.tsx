import { Fragment, useMemo, useState, type ReactNode } from 'react';
import { Box, Input, List, Skeleton, Typography } from '@mui/joy';
import type { SxProps } from '@mui/joy/styles/types';
import SearchIcon from '@mui/icons-material/Search';
import type { TagNode } from '@client/app/components/Files/Browser/TagView/parseTagNamespace';
import { getNodesAtPath } from '@client/app/components/Files/Browser/TagView/parseTagNamespace';
import type { IFabFileDocument } from '@bike4mind/common';

/**
 * Synthetic breadcrumb key for the Viewer's "files with no prefix-matching tag" bucket.
 * Kept identical to the manager's constant so both surfaces mean the same bucket.
 */
export const UNCATEGORIZED_KEY = '__uncategorized__';

/** How the tree lists order their rows. Declared here (the source of truth); treeChrome.ts
 *  re-exports it so a third mode is added in one place, alongside its icon. */
export type TreeSortMode = 'count' | 'alpha';

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
  /** Where the back row lives: 'above' renders it as a sibling before the scroll pane;
   *  'sticky' renders it INSIDE the scroll pane wrapped in `stickyBackSx` (required then). */
  backRowPlacement: 'above' | 'sticky';
  stickyBackSx?: SxProps;
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
}

export interface DataLakeTreeViewProps {
  tree: TagNode[];
  /** All articles in scope, used to resolve leaf-tag files locally without extra API calls. */
  articles: IFabFileDocument[];
  breadcrumb: string[];
  onNavigate: (breadcrumb: string[]) => void;
  selectedFileId: string | null;
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
   * navigation without the seeded root itself being mistaken for a leaf. The seeded root's own
   * back row is the HOST's concern (e.g. ManagerNav renders its own back row above TreeView);
   * TreeView's back row still only requires `breadcrumb.length > 0` (or `alwaysShowBackRow`).
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
  selectedFileId,
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

  const currentNodes = useMemo(() => getNodesAtPath(tree, breadcrumb), [tree, breadcrumb]);

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

  // The synthetic bucket intercepts before leaf-tag resolution: its key is not a real tag.
  // The bucket always lands exactly one level below the seeded root, so this is an equality
  // check, not a floor - a deeper breadcrumb can't coincidentally end in the synthetic key.
  const isUncategorized =
    !!uncategorized &&
    breadcrumb.length === leafMinDepth + 1 &&
    breadcrumb[breadcrumb.length - 1] === UNCATEGORIZED_KEY;

  // At a leaf node (no children) below the seeded root, files are filtered locally by the leaf tag.
  const leafTag =
    !isUncategorized && breadcrumb.length > leafMinDepth && currentNodes.length === 0 ? breadcrumb.join(':') : null;
  const showFiles = isUncategorized || !!leafTag;
  const bucketFiles = uncategorized?.files;
  const files = useMemo(() => {
    if (isUncategorized) return bucketFiles!;
    if (!leafTag) return [];
    return [...articles]
      .filter(f => (f.tags ?? []).some(t => t.name === leafTag))
      .sort((a, b) => a.fileName.localeCompare(b.fileName));
  }, [isUncategorized, bucketFiles, leafTag, articles]);

  const showBucketRow = !!uncategorized && breadcrumb.length <= leafMinDepth && !searchQuery && bucketFiles!.length > 0;
  // The bucket standing in for an empty root is still content - don't show "No categories" under it.
  const showNodeEmpty = filteredNodes.length === 0 && !showBucketRow;

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
            value={searchQuery}
            onChange={e => setSearch(e.target.value)}
            data-testid="datalake-search"
            sx={chrome.searchSx}
          />
          {chrome.renderSortButton(sortBy, () => setSort(sortBy === 'count' ? 'alpha' : 'count'))}
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
                  {chrome.renderFileRow(f, selectedFileId === f.id, () => onSelectFile(f))}
                </Fragment>
              ))
            )}
          </List>
        ) : (
          /* Folder tree */
          <List size="sm" sx={chrome.nodeListSx}>
            {filteredNodes.map(node => (
              <Fragment key={node.segment}>
                {chrome.renderNodeRow(node, breadcrumb.length, () => onNavigate([...breadcrumb, node.segment]))}
              </Fragment>
            ))}
            {showBucketRow && (
              <Fragment key={UNCATEGORIZED_KEY}>
                {uncategorized!.renderRow(uncategorized!.files.length, () =>
                  onNavigate([...breadcrumb, UNCATEGORIZED_KEY])
                )}
              </Fragment>
            )}
            {showNodeEmpty && (
              <Box sx={{ p: 2, textAlign: 'center' }}>
                <Typography level="body-xs" sx={{ color: 'text.tertiary' }}>
                  {searchQuery ? 'No matches' : 'No categories'}
                </Typography>
              </Box>
            )}
          </List>
        )}
      </Box>

      {footer}
    </Box>
  );
}
