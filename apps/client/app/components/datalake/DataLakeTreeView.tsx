import { useMemo, useState, type ReactNode } from 'react';
import { Box, Input, List, Skeleton, Typography } from '@mui/joy';
import type { SxProps } from '@mui/joy/styles/types';
import SearchIcon from '@mui/icons-material/Search';
import type { TagNode } from '@client/app/components/Files/Browser/TagView/parseTagNamespace';
import { getNodesAtPath } from '@client/app/components/Files/Browser/TagView/parseTagNamespace';
import type { TreeSortMode } from './treeChrome';
import type { IFabFileDocument } from '@bike4mind/common';

/**
 * Synthetic breadcrumb key for the Viewer's "files with no prefix-matching tag" bucket.
 * Kept identical to the manager's constant so both surfaces mean the same bucket.
 */
export const UNCATEGORIZED_KEY = '__uncategorized__';

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
}: DataLakeTreeViewProps) {
  const [searchQuery, setSearchQuery] = useState('');
  const [sortBy, setSortBy] = useState<TreeSortMode>('count');

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
  const isUncategorized = !!uncategorized && breadcrumb.length === 1 && breadcrumb[0] === UNCATEGORIZED_KEY;

  // At a leaf node (no children), files are filtered locally by the leaf tag.
  const leafTag = !isUncategorized && breadcrumb.length > 0 && currentNodes.length === 0 ? breadcrumb.join(':') : null;
  const showFiles = isUncategorized || !!leafTag;
  const files = useMemo(() => {
    if (isUncategorized) return uncategorized!.files;
    if (!leafTag) return [];
    return [...articles]
      .filter(f => (f.tags ?? []).some(t => t.name === leafTag))
      .sort((a, b) => a.fileName.localeCompare(b.fileName));
  }, [isUncategorized, uncategorized, leafTag, articles]);

  const showBucketRow = !!uncategorized && breadcrumb.length === 0 && !searchQuery && uncategorized.files.length > 0;
  // The bucket standing in for an empty root is still content - don't show "No categories" under it.
  const showNodeEmpty = filteredNodes.length === 0 && !showBucketRow;

  const backLabel =
    breadcrumb.length === 1
      ? chrome.allCategoriesLabel
      : chrome.humanize(breadcrumb[breadcrumb.length - 2], breadcrumb.length - 2);
  const backRow =
    breadcrumb.length > 0 ? chrome.renderBackRow(backLabel, () => onNavigate(breadcrumb.slice(0, -1))) : null;

  return (
    <Box data-testid="datalake-tree" sx={chrome.containerSx}>
      {header}

      {/* Search bar + sort toggle */}
      <Box sx={chrome.toolbarSx}>
        <Input
          size="sm"
          placeholder={chrome.searchPlaceholder}
          startDecorator={<SearchIcon sx={{ fontSize: 18 }} />}
          value={searchQuery}
          onChange={e => setSearchQuery(e.target.value)}
          data-testid="datalake-search"
          sx={chrome.searchSx}
        />
        {chrome.renderSortButton(sortBy, () => setSortBy(prev => (prev === 'count' ? 'alpha' : 'count')))}
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
              files.map(f => chrome.renderFileRow(f, selectedFileId === f.id, () => onSelectFile(f)))
            )}
          </List>
        ) : (
          /* Folder tree */
          <List size="sm" sx={chrome.nodeListSx}>
            {filteredNodes.map(node =>
              chrome.renderNodeRow(node, breadcrumb.length, () => onNavigate([...breadcrumb, node.segment]))
            )}
            {showBucketRow &&
              uncategorized!.renderRow(uncategorized!.files.length, () => onNavigate([UNCATEGORIZED_KEY]))}
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
