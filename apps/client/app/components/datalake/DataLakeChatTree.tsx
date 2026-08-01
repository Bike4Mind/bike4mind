import { useState, useMemo } from 'react';
import {
  Box,
  Button,
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
import CloseIcon from '@mui/icons-material/Close';
import HelpOutlineIcon from '@mui/icons-material/HelpOutline';
import { HEADER_ICON_BUTTON_SX } from '@client/app/components/Session/AISettings/headerIconButtonSx';
import type { TagNode } from '@client/app/components/Files/Browser/TagView/parseTagNamespace';
import { getNodesAtPath } from '@client/app/components/Files/Browser/TagView/parseTagNamespace';
import { HUES, inkFor } from '@client/app/components/datalake/deckChrome';
import {
  COUNT_CHIP_SX,
  FOOTER_BTN_SX,
  ICON_BTN_SX,
  TREE_LIST_SX,
  hueForBranch,
  humanizeSegment,
  treeRowSx,
} from '@client/app/components/datalake/treeChrome';
import type { IFabFileDocument } from '@bike4mind/common';
import { gray } from '@client/app/utils/themes/colors';

interface DataLakeChatTreeProps {
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
  /** Header close (X) button - turns Data Lake mode off for this chat. */
  onClose?: () => void;
}

/**
 * Chat-embedded Data Lake tree: a rounded sidenav-style card with its own header (title + info +
 * close) and footer (Manage / Create), used as the left rail beside a chat in Data Lake mode.
 * The standalone /data-lakes page uses the brand-agnostic DataLakeTree instead (no header/footer).
 */
export default function DataLakeChatTree({
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
  onClose,
}: DataLakeChatTreeProps) {
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
      {/* Header: title + close (turns Data Lake mode off for this chat). */}
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
        <Box sx={{ flex: 1, minWidth: 0, display: 'flex', alignItems: 'center', gap: '6px' }}>
          <Typography noWrap sx={{ fontSize: '14px', fontWeight: 300, color: 'text.primary' }}>
            {title}
          </Typography>
          <Tooltip
            title="Ground this chat in your Data Lakes - the assistant answers from the files in your lakes, with citations. Turn it on for any chat; use Create to add a lake and Manage to organize them."
            placement="top"
            size="sm"
            sx={{ maxWidth: 280 }}
          >
            <IconButton
              size="sm"
              variant="plain"
              color="neutral"
              aria-label="About Data Lakes"
              data-testid="datalake-info-icon"
              sx={{ ...HEADER_ICON_BUTTON_SX, flexShrink: 0 }}
            >
              <HelpOutlineIcon sx={{ fontSize: 16 }} />
            </IconButton>
          </Tooltip>
        </Box>
        {onClose && (
          <Tooltip title="Close Data Lakes" size="sm">
            <IconButton
              variant="plain"
              color="neutral"
              onClick={onClose}
              aria-label="Close Data Lakes"
              data-testid="datalake-close-btn"
              sx={theme => ({
                ...ICON_BTN_SX,
                // No pressed/active fill - the icon brightening is the only affordance.
                '--variant-plainActiveBg': 'transparent',
                // Icon reads this var; the button flips it on hover so the swap can't lose a
                // specificity fight with the icon's own color. text.icon == text.tertiary in
                // this theme, so hover uses the brighter neutral plain color instead.
                '--dl-close-color': theme.vars.palette.text.tertiary,
                '&:hover': { '--dl-close-color': theme.vars.palette.neutral.plainColor },
              })}
            >
              <CloseIcon sx={{ fontSize: 18, color: 'var(--dl-close-color)', transition: 'color 0.15s' }} />
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
            sx={{ ...ICON_BTN_SX, flexShrink: 0 }}
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
            <Typography noWrap sx={{ fontSize: '14px', fontWeight: 400, color: 'text.primary' }}>
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
          <List size="sm" sx={TREE_LIST_SX}>
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
                    sx={treeRowSx(theme.palette.notebooklist.hoverBg)}
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
                        sx={{
                          fontSize: '14px',
                          fontWeight: selectedFileId === file.id ? 'lg' : 400,
                          color: 'text.primary',
                        }}
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
          <List size="sm" sx={TREE_LIST_SX}>
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
                      sx={treeRowSx(theme.palette.notebooklist.hoverBg)}
                      data-testid={`datalake-node-${node.segment}`}
                    >
                      <FolderOutlinedIcon sx={{ fontSize: 16, color: branchInk, flexShrink: 0 }} />
                      <ListItemContent>
                        <Typography noWrap sx={{ fontSize: '14px', fontWeight: 400, color: 'text.primary' }}>
                          {humanizeSegment(node.segment, breadcrumb.length)}
                        </Typography>
                      </ListItemContent>
                      <Chip size="sm" variant="soft" color="neutral" sx={COUNT_CHIP_SX}>
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

      {/* Sticky bottom bar: manage / create lakes. Pinned below the scrollable list. */}
      {(onManage || onCreateLake) && (
        <Box
          className="datalake-tree-footer"
          sx={{
            display: 'flex',
            gap: '8px',
            p: '12px',
            borderTop: '1px solid',
            borderColor: isDark ? gray[800] : gray[200],
          }}
        >
          {onManage && (
            <Button
              variant="outlined"
              color="neutral"
              onClick={onManage}
              data-testid="datalake-manage-btn"
              sx={FOOTER_BTN_SX}
            >
              Manage
            </Button>
          )}
          {onCreateLake && (
            <Button
              variant="solid"
              color="primary"
              onClick={onCreateLake}
              data-testid="datalake-create-btn"
              sx={FOOTER_BTN_SX}
            >
              Create
            </Button>
          )}
        </Box>
      )}
    </Box>
  );
}
