import { useState, useMemo } from 'react';
import {
  Box,
  Chip,
  IconButton,
  Input,
  List,
  ListItem,
  ListItemButton,
  ListItemContent,
  Skeleton,
  Tooltip,
  Typography,
  useTheme,
} from '@mui/joy';
import SearchIcon from '@mui/icons-material/Search';
import SwapVertIcon from '@mui/icons-material/SwapVert';
import FolderOutlinedIcon from '@mui/icons-material/FolderOutlined';
import ArticleOutlinedIcon from '@mui/icons-material/ArticleOutlined';
import ArrowBackIcon from '@mui/icons-material/ArrowBack';
import AddIcon from '@mui/icons-material/Add';
import SettingsOutlinedIcon from '@mui/icons-material/SettingsOutlined';
import type { TagNode } from '@client/app/components/Files/Browser/TagView/parseTagNamespace';
import { getNodesAtPath } from '@client/app/components/Files/Browser/TagView/parseTagNamespace';
import { HUES, inkFor } from '@client/app/components/datalake/deckChrome';
import type { Hue } from '@client/app/components/datalake/deckChrome';
import type { IFabFileDocument } from '@bike4mind/common';
import { gray } from '@client/app/utils/themes/colors';

const PREFIX_LABELS: Record<string, string> = {
  opti: 'Optimization Knowledge',
};

/** Hue-code branches by their top-level prefix so different root namespaces read apart at a
 *  glance. Only `opti` gets a distinct hue today; every other branch falls back to amber. */
const PREFIX_HUES: Record<string, Hue> = {
  opti: HUES.emerald,
};

const hueForBranch = (segment: string, breadcrumb: string[]): Hue =>
  PREFIX_HUES[breadcrumb[0] ?? segment] ?? HUES.amber;

const CATEGORY_LABELS: Record<string, string> = {
  offering: 'Offering Lines',
  type: 'Content Type',
  vertical: 'Customer Verticals',
  competitor: 'Competitors',
  stage: 'Sales Stage',
  content: 'Content Type',
  family: 'Pattern Families',
  solver: 'Solvers',
  level: 'Difficulty Level',
  industry: 'Industries',
};

function humanizeSegment(segment: string, depth: number): string {
  if (depth === 0 && PREFIX_LABELS[segment]) return PREFIX_LABELS[segment];
  if (depth === 1 && CATEGORY_LABELS[segment]) return CATEGORY_LABELS[segment];
  return segment.charAt(0).toUpperCase() + segment.slice(1).replace(/-/g, ' ');
}

interface DataLakeTreeProps {
  tree: TagNode[];
  /** All data-lake articles, used to filter at leaf nodes without additional API calls. */
  articles: IFabFileDocument[];
  breadcrumb: string[];
  onNavigate: (breadcrumb: string[]) => void;
  selectedFileId: string | null;
  onSelectFile: (file: IFabFileDocument) => void;
  isLoading: boolean;
  isError?: boolean;
  /** Header title (the lake root label, e.g. "Data Lakes"). */
  title?: string;
  /** Gear button - opens the Manage Lakes panel (same as the legacy Manage Lakes button). */
  onManage?: () => void;
  /** Blue + button - opens the Create Lake wizard. */
  onCreateLake?: () => void;
}

export default function DataLakeTree({
  tree,
  articles,
  breadcrumb,
  onNavigate,
  selectedFileId,
  onSelectFile,
  isLoading,
  isError,
  title,
  onManage,
  onCreateLake,
}: DataLakeTreeProps) {
  const theme = useTheme();
  const isDark = theme.palette.mode === 'dark';
  const [searchQuery, setSearchQuery] = useState('');
  const [sortBy, setSortBy] = useState<'count' | 'alpha'>('count');

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

  // At a leaf node (no children), filter articles locally by the leaf tag
  const leafTag = breadcrumb.length > 0 && currentNodes.length === 0 ? breadcrumb.join(':') : null;
  const showFiles = !!leafTag;
  const files = useMemo(() => {
    if (!leafTag) return [];
    return [...articles]
      .filter(f => (f.tags ?? []).some(t => t.name === leafTag))
      .sort((a, b) => a.fileName.localeCompare(b.fileName));
  }, [leafTag, articles]);

  return (
    <Box
      className="datalake-tree"
      data-testid="datalake-tree"
      sx={{
        width: 260,
        minWidth: 260,
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
        // Styled to match the main app sidenav (see layouts/Notebook/Sidenav/index.tsx).
        backgroundColor: 'background.surface2',
        border: '1px solid',
        borderColor: isDark ? gray[800] : gray[200],
        borderRadius: '10px',
      }}
    >
      {/* Header: title + Manage Lakes (gear) + Create Lake (blue +). */}
      <Box
        className="datalake-tree-header"
        sx={{
          height: '48px',
          boxSizing: 'border-box',
          p: '12px',
          display: 'flex',
          alignItems: 'center',
          gap: '10px',
          borderBottom: '1px solid',
          borderColor: isDark ? gray[800] : gray[200],
        }}
      >
        <Typography noWrap sx={{ flex: 1, fontSize: '14px', fontWeight: 300, color: gray[200] }}>
          {title}
        </Typography>
        {onManage && (
          <Tooltip title="Manage lakes" size="sm">
            <IconButton
              variant="outlined"
              color="neutral"
              onClick={onManage}
              aria-label="Manage lakes"
              data-testid="datalake-manage-btn"
              sx={{ '--IconButton-size': '32px', borderRadius: '6px' }}
            >
              <SettingsOutlinedIcon sx={{ fontSize: 16 }} />
            </IconButton>
          </Tooltip>
        )}
        {onCreateLake && (
          <Tooltip title="Create lake" size="sm">
            <IconButton
              variant="solid"
              color="primary"
              onClick={onCreateLake}
              aria-label="Create lake"
              data-testid="datalake-create-btn"
              sx={{ '--IconButton-size': '32px', borderRadius: '6px' }}
            >
              <AddIcon sx={{ fontSize: 18 }} />
            </IconButton>
          </Tooltip>
        )}
      </Box>

      {/* Search bar + sort toggle */}
      <Box
        className="datalake-tree-toolbar"
        sx={{ mt: '12px', mb: '20px', px: '12px', display: 'flex', gap: '10px', alignItems: 'center' }}
      >
        <Input
          size="sm"
          placeholder="Search"
          startDecorator={<SearchIcon sx={{ fontSize: 18 }} />}
          value={searchQuery}
          onChange={e => setSearchQuery(e.target.value)}
          data-testid="datalake-search"
          sx={{ flex: 1, '--Input-minHeight': '32px', color: 'text.primary', boxShadow: 'none' }}
        />
        <Tooltip
          title={sortBy === 'count' ? 'Sort: by count (click for A-Z)' : 'Sort: A-Z (click for count)'}
          size="sm"
        >
          <IconButton
            variant="outlined"
            color="neutral"
            onClick={() => setSortBy(prev => (prev === 'count' ? 'alpha' : 'count'))}
            data-testid="datalake-sort-toggle"
            data-sort={sortBy}
            sx={{ flexShrink: 0, '--IconButton-size': '32px', borderRadius: '6px' }}
          >
            <SwapVertIcon sx={{ fontSize: 18 }} />
          </IconButton>
        </Tooltip>
      </Box>

      {/* Tree / file list */}
      <Box className="datalake-tree-list" sx={{ flex: 1, overflow: 'auto', px: '8px' }}>
        {/* Breadcrumb back - styled like the tree items (14px / gray[200]). */}
        {breadcrumb.length > 0 && (
          <ListItemButton
            onClick={() => onNavigate(breadcrumb.slice(0, -1))}
            data-testid="datalake-back"
            sx={{
              display: 'flex',
              alignItems: 'center',
              gap: '8px',
              px: '8px',
              mb: '4px',
              height: '32px',
              minHeight: '32px',
              borderRadius: '8px',
              transition: 'background 0.15s',
              '--variant-plainHoverBg': theme.palette.notebooklist.hoverBg,
            }}
          >
            <ArrowBackIcon sx={{ fontSize: 16, color: 'text.secondary', flexShrink: 0 }} />
            <Typography noWrap sx={{ fontSize: '14px', fontWeight: 400, color: gray[200] }}>
              {breadcrumb.length === 1
                ? 'All Categories'
                : humanizeSegment(breadcrumb[breadcrumb.length - 2], breadcrumb.length - 2)}
            </Typography>
          </ListItemButton>
        )}
        {isError ? (
          <Box sx={{ p: 2, textAlign: 'center' }} data-testid="datalake-error">
            <Typography level="body-xs" sx={{ color: 'danger.400' }}>
              Failed to load articles
            </Typography>
          </Box>
        ) : isLoading ? (
          <Box sx={{ p: 1.5, display: 'flex', flexDirection: 'column', gap: 1 }}>
            {[1, 2, 3, 4].map(i => (
              <Skeleton key={i} variant="rectangular" height={32} sx={{ borderRadius: 'sm' }} />
            ))}
          </Box>
        ) : showFiles ? (
          /* File list at leaf */
          <List
            size="sm"
            sx={{ py: 0, '--List-gap': '4px', '--ListItem-paddingX': '8px', '--ListItem-paddingY': '0px' }}
          >
            {files.length === 0 ? (
              <Box sx={{ p: 2, textAlign: 'center' }}>
                <Typography level="body-xs" sx={{ color: 'text.tertiary' }}>
                  No articles found
                </Typography>
              </Box>
            ) : (
              files.map(file => (
                <ListItem key={file.id}>
                  <ListItemButton
                    selected={selectedFileId === file.id}
                    onClick={() => onSelectFile(file)}
                    data-testid={`datalake-file-${file.id}`}
                    sx={{
                      borderRadius: '8px',
                      gap: '8px',
                      minHeight: '28px',
                      py: 0,
                      transition: 'background 0.15s',
                      '--variant-plainHoverBg': theme.palette.notebooklist.hoverBg,
                    }}
                  >
                    <ArticleOutlinedIcon
                      sx={{
                        fontSize: 16,
                        color: selectedFileId === file.id ? inkFor(HUES.cyan, isDark) : 'text.tertiary',
                        flexShrink: 0,
                      }}
                    />
                    <ListItemContent>
                      <Typography
                        noWrap
                        sx={{ fontSize: '14px', fontWeight: selectedFileId === file.id ? 'lg' : 400, color: gray[200] }}
                      >
                        {file.fileName.replace(/\.[^/.]+$/, '')}
                      </Typography>
                    </ListItemContent>
                  </ListItemButton>
                </ListItem>
              ))
            )}
          </List>
        ) : (
          /* Folder tree */
          <List
            size="sm"
            sx={{ py: 0, '--List-gap': '4px', '--ListItem-paddingX': '8px', '--ListItem-paddingY': '0px' }}
          >
            {filteredNodes.length === 0 ? (
              <Box sx={{ p: 2, textAlign: 'center' }}>
                <Typography level="body-xs" sx={{ color: 'text.tertiary' }}>
                  {searchQuery ? 'No matches' : 'No categories'}
                </Typography>
              </Box>
            ) : (
              filteredNodes.map(node => {
                const branchInk = inkFor(hueForBranch(node.segment, breadcrumb), isDark);
                return (
                  <ListItem key={node.segment}>
                    <ListItemButton
                      onClick={() => onNavigate([...breadcrumb, node.segment])}
                      sx={{
                        borderRadius: '8px',
                        gap: '8px',
                        minHeight: '28px',
                        py: 0,
                        transition: 'background 0.15s',
                        // Match the sidenav nav-item hover. ListItemButton reads its hover bg from
                        // this Joy var, so a plain '&:hover' loses to Joy's built-in rule.
                        '--variant-plainHoverBg': theme.palette.notebooklist.hoverBg,
                      }}
                      data-testid={`datalake-node-${node.segment}`}
                    >
                      <FolderOutlinedIcon sx={{ fontSize: 16, color: branchInk, flexShrink: 0 }} />
                      <ListItemContent>
                        <Typography noWrap sx={{ fontSize: '14px', fontWeight: 400, color: gray[200] }}>
                          {humanizeSegment(node.segment, breadcrumb.length)}
                        </Typography>
                      </ListItemContent>
                      <Chip
                        size="sm"
                        variant="soft"
                        color="neutral"
                        sx={{ bgcolor: 'transparent', '--Chip-paddingInline': '0px', '--Chip-minHeight': 'auto' }}
                      >
                        {node.fileCount}
                      </Chip>
                    </ListItemButton>
                  </ListItem>
                );
              })
            )}
          </List>
        )}
      </Box>
    </Box>
  );
}
