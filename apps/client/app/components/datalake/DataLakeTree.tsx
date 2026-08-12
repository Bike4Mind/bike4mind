import { Chip, IconButton, ListItem, ListItemButton, ListItemContent, Tooltip, Typography, useTheme } from '@mui/joy';
import { alpha } from '@mui/system';
import SortByAlphaIcon from '@mui/icons-material/SortByAlpha';
import ArrowBackIcon from '@mui/icons-material/ArrowBack';
import type { TagNode } from '@client/app/components/Files/Browser/TagView/parseTagNamespace';
import DataLakeTreeView, { type DataLakeTreeChrome } from './DataLakeTreeView';
import { inkFor } from '@client/app/components/datalake/surfaceChrome';
import type { Hue } from '@client/app/components/datalake/surfaceChrome';
import { humanizeSegment, useDataLakeSurface } from '@client/app/components/datalake/surfaceTokens';
import type { DataLakeSurfaceTheme } from '@client/app/components/datalake/surfaceTokens';
import type { DataLakeBrowseSource } from '@client/app/hooks/data/dataLakes';
import type { IFabFileDocument } from '@bike4mind/common';

/** Branch ink comes from the top-level prefix, so a whole subtree reads as one color. */
const hueForBranch = (segment: string, breadcrumb: string[], theme: DataLakeSurfaceTheme): Hue =>
  theme.branchHues[breadcrumb[0] ?? segment] ?? theme.branchDefault;

interface DataLakeTreeProps {
  tree: TagNode[];
  /** All data-lake articles, used to filter at leaf nodes without additional API calls. */
  articles: IFabFileDocument[];
  breadcrumb: string[];
  onNavigate: (breadcrumb: string[]) => void;
  /** Threaded to DataLakeTreeView's cross-tree article search. */
  source?: DataLakeBrowseSource;
  selectedFileIds: ReadonlySet<string>;
  onSelectFile: (file: IFabFileDocument) => void;
  isLoading: boolean;
  isError?: boolean;
}

/**
 * The standalone /data-lakes page tree: brand-agnostic, themed entirely through the
 * DataLakeSurface tokens. All tree logic lives in DataLakeTreeView; this shell only
 * declares the page chrome.
 */
export default function DataLakeTree(props: DataLakeTreeProps) {
  const muiTheme = useTheme();
  const isDark = muiTheme.palette.mode === 'dark';
  const { theme, copy, icons, taxonomy } = useDataLakeSurface();
  const { article: ArticleGlyph, branch: BranchGlyph, leafBranch: LeafBranchGlyph } = icons;

  const chrome: DataLakeTreeChrome = {
    containerSx: {
      width: 280,
      minWidth: 280,
      borderRight: '1px solid',
      borderColor: 'divider',
      display: 'flex',
      flexDirection: 'column',
      overflow: 'hidden',
    },
    toolbarSx: { p: 1.5, pb: 1, display: 'flex', gap: 0.5, alignItems: 'center' },
    searchPlaceholder: 'Filter...',
    searchSx: { fontSize: '13px', flex: 1 },
    renderSortButton: (sortBy, toggle) => (
      <Tooltip title={sortBy === 'count' ? 'Sort: by count (click for A-Z)' : 'Sort: A-Z (click for count)'} size="sm">
        <IconButton
          size="sm"
          variant={sortBy === 'alpha' ? 'soft' : 'plain'}
          color="neutral"
          onClick={toggle}
          data-testid="datalake-sort-toggle"
          data-sort={sortBy}
          sx={{ flexShrink: 0 }}
        >
          <SortByAlphaIcon sx={{ fontSize: 18 }} />
        </IconButton>
      </Tooltip>
    ),
    renderBackRow: (label, onBack) => (
      <ListItemButton onClick={onBack} sx={{ px: 1.5, py: 0.75, gap: 1, minHeight: 36 }} data-testid="datalake-back">
        <ArrowBackIcon sx={{ fontSize: 16, color: 'text.tertiary' }} />
        <Typography level="body-xs" sx={{ color: 'text.tertiary' }}>
          {label}
        </Typography>
      </ListItemButton>
    ),
    scrollSx: { flex: 1, overflow: 'auto' },
    nodeListSx: { '--ListItem-paddingX': '12px', '--ListItem-paddingY': '4px' },
    fileListSx: { '--ListItem-paddingX': '12px', '--ListItem-paddingY': '6px' },
    renderNodeRow: (node, depth, onOpen) => {
      const branchInk = inkFor(hueForBranch(node.segment, props.breadcrumb, theme), isDark);
      return (
        <ListItem key={node.segment}>
          <ListItemButton
            onClick={onOpen}
            sx={{
              borderRadius: 'sm',
              gap: 1,
              '&:hover': { backgroundColor: alpha(branchInk, isDark ? 0.08 : 0.06) },
            }}
            data-testid={`datalake-node-${node.segment}`}
          >
            {node.children.length > 0 ? (
              <BranchGlyph sx={{ fontSize: 18, color: branchInk }} />
            ) : (
              <LeafBranchGlyph sx={{ fontSize: 18, color: alpha(branchInk, 0.7) }} />
            )}
            <ListItemContent>
              <Typography level="body-sm" sx={{ fontWeight: 'md' }}>
                {humanizeSegment(node.segment, depth, taxonomy)}
              </Typography>
            </ListItemContent>
            <Chip
              size="sm"
              variant="outlined"
              sx={{
                minHeight: 20,
                fontSize: '11px',
                fontFamily: 'monospace',
                color: alpha(branchInk, 0.9),
                borderColor: alpha(branchInk, 0.35),
              }}
            >
              {node.fileCount}
            </Chip>
          </ListItemButton>
        </ListItem>
      );
    },
    renderFileRow: (file, selected, onSelect) => {
      const displayName = file.fileName.replace(/\.[^/.]+$/, '');
      return (
        <ListItem key={file.id}>
          <ListItemButton
            selected={selected}
            onClick={onSelect}
            sx={{ borderRadius: 'sm', gap: 1 }}
            data-testid={`datalake-file-${file.id}`}
          >
            <ArticleGlyph
              sx={{
                fontSize: 16,
                color: selected ? inkFor(theme.accent, isDark) : 'text.tertiary',
                flexShrink: 0,
              }}
            />
            <ListItemContent>
              <Tooltip title={displayName} size="sm" enterDelay={500}>
                <Typography level="body-xs" noWrap sx={{ fontWeight: selected ? 'lg' : undefined }}>
                  {displayName}
                </Typography>
              </Tooltip>
            </ListItemContent>
          </ListItemButton>
        </ListItem>
      );
    },
    humanize: (segment, depth) => humanizeSegment(segment, depth, taxonomy),
    allCategoriesLabel: copy.allCategoriesLabel,
    emptyFilesLabel: 'No articles found',
    errorLabel: 'Failed to load articles',
  };

  return <DataLakeTreeView {...props} chrome={chrome} />;
}
