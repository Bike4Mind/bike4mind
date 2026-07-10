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
import { alpha } from '@mui/system';
import SearchIcon from '@mui/icons-material/Search';
import SortByAlphaIcon from '@mui/icons-material/SortByAlpha';
import FolderIcon from '@mui/icons-material/Folder';
import FolderOpenIcon from '@mui/icons-material/FolderOpen';
import ArticleIcon from '@mui/icons-material/Article';
import ArrowBackIcon from '@mui/icons-material/ArrowBack';
import type { TagNode } from '@client/app/components/Files/Browser/TagView/parseTagNamespace';
import { getNodesAtPath } from '@client/app/components/Files/Browser/TagView/parseTagNamespace';
import { HUES, inkFor } from '@client/app/components/datalake/deckChrome';
import type { Hue } from '@client/app/components/datalake/deckChrome';
import type { IFabFileDocument } from '@bike4mind/common';

const PREFIX_LABELS: Record<string, string> = {
  opti: 'Optimization Knowledge',
};

/** Hue-code branches by their top-level prefix so depth reads at a glance. */
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
      data-testid="datalake-tree"
      sx={{
        width: 280,
        minWidth: 280,
        borderRight: '1px solid',
        borderColor: 'divider',
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
      }}
    >
      {/* Search bar + sort toggle */}
      <Box sx={{ p: 1.5, pb: 1, display: 'flex', gap: 0.5, alignItems: 'center' }}>
        <Input
          size="sm"
          placeholder="Filter..."
          startDecorator={<SearchIcon sx={{ fontSize: 18 }} />}
          value={searchQuery}
          onChange={e => setSearchQuery(e.target.value)}
          data-testid="datalake-search"
          sx={{ fontSize: '13px', flex: 1 }}
        />
        <Tooltip
          title={sortBy === 'count' ? 'Sort: by count (click for A-Z)' : 'Sort: A-Z (click for count)'}
          size="sm"
        >
          <IconButton
            size="sm"
            variant={sortBy === 'alpha' ? 'soft' : 'plain'}
            color="neutral"
            onClick={() => setSortBy(prev => (prev === 'count' ? 'alpha' : 'count'))}
            data-testid="datalake-sort-toggle"
            data-sort={sortBy}
            sx={{ flexShrink: 0 }}
          >
            <SortByAlphaIcon sx={{ fontSize: 18 }} />
          </IconButton>
        </Tooltip>
      </Box>

      {/* Breadcrumb back */}
      {breadcrumb.length > 0 && (
        <ListItemButton
          onClick={() => onNavigate(breadcrumb.slice(0, -1))}
          sx={{ px: 1.5, py: 0.75, gap: 1, minHeight: 36 }}
          data-testid="datalake-back"
        >
          <ArrowBackIcon sx={{ fontSize: 16, color: 'text.tertiary' }} />
          <Typography level="body-xs" sx={{ color: 'text.tertiary' }}>
            {breadcrumb.length === 1
              ? 'All Categories'
              : humanizeSegment(breadcrumb[breadcrumb.length - 2], breadcrumb.length - 2)}
          </Typography>
        </ListItemButton>
      )}

      {/* Tree / file list */}
      <Box sx={{ flex: 1, overflow: 'auto' }}>
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
          <List size="sm" sx={{ '--ListItem-paddingX': '12px', '--ListItem-paddingY': '6px' }}>
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
                    sx={{ borderRadius: 'sm', gap: 1 }}
                    data-testid={`datalake-file-${file.id}`}
                  >
                    <ArticleIcon
                      sx={{
                        fontSize: 16,
                        color: selectedFileId === file.id ? inkFor(HUES.cyan, isDark) : 'text.tertiary',
                        flexShrink: 0,
                      }}
                    />
                    <ListItemContent>
                      <Typography
                        level="body-xs"
                        noWrap
                        sx={{ fontWeight: selectedFileId === file.id ? 'lg' : undefined }}
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
          <List size="sm" sx={{ '--ListItem-paddingX': '12px', '--ListItem-paddingY': '4px' }}>
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
                        borderRadius: 'sm',
                        gap: 1,
                        '&:hover': { backgroundColor: alpha(branchInk, isDark ? 0.08 : 0.06) },
                      }}
                      data-testid={`datalake-node-${node.segment}`}
                    >
                      {node.children.length > 0 ? (
                        <FolderIcon sx={{ fontSize: 18, color: branchInk }} />
                      ) : (
                        <FolderOpenIcon sx={{ fontSize: 18, color: alpha(branchInk, 0.7) }} />
                      )}
                      <ListItemContent>
                        <Typography level="body-sm" sx={{ fontWeight: 'md' }}>
                          {humanizeSegment(node.segment, breadcrumb.length)}
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
              })
            )}
          </List>
        )}
      </Box>
    </Box>
  );
}
