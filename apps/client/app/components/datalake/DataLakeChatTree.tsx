import {
  Box,
  Button,
  Chip,
  IconButton,
  ListItem,
  ListItemButton,
  ListItemContent,
  Tooltip,
  Typography,
  useTheme,
} from '@mui/joy';
import FolderOutlinedIcon from '@mui/icons-material/FolderOutlined';
import ArticleOutlinedIcon from '@mui/icons-material/ArticleOutlined';
import ArrowBackIcon from '@mui/icons-material/ArrowBack';
import CloseIcon from '@mui/icons-material/Close';
import HelpOutlineIcon from '@mui/icons-material/HelpOutline';
import { HEADER_ICON_BUTTON_SX } from '@client/app/components/Session/AISettings/headerIconButtonSx';
import type { TagNode } from '@client/app/components/Files/Browser/TagView/parseTagNamespace';
import DataLakeTreeView, { type DataLakeTreeChrome } from './DataLakeTreeView';
import { HUES, inkFor } from '@client/app/components/datalake/deckChrome';
import {
  COUNT_CHIP_SX,
  FOOTER_BTN_SX,
  ICON_BTN_SX,
  SORT_MODE_ICON,
  TREE_BACK_STICKY_SX,
  TREE_LIST_SX,
  TREE_SCROLL_SX,
  hueForBranch,
  humanizeSegment,
  treeBackRowSx,
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

  const header = (
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
  );

  const footer = (onManage || onCreateLake) && (
    // Sticky bottom bar: manage / create lakes. Pinned below the scrollable list by being
    // TreeView's footer slot, outside the scroll pane.
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
  );

  const chrome: DataLakeTreeChrome = {
    containerSx: {
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
    },
    toolbarSx: { mt: '12px', mb: '20px', px: '12px', display: 'flex', gap: '10px', alignItems: 'center' },
    searchPlaceholder: 'Search',
    searchSx: { flex: 1, '--Input-minHeight': '32px', color: 'text.primary', boxShadow: 'none' },
    renderSortButton: (sortBy, toggle) => {
      const SortModeIcon = SORT_MODE_ICON[sortBy];
      return (
        <Tooltip
          title={sortBy === 'count' ? 'Sort: by count (click for A-Z)' : 'Sort: A-Z (click for count)'}
          size="sm"
        >
          <IconButton
            variant="outlined"
            color="neutral"
            onClick={toggle}
            data-testid="datalake-sort-toggle"
            data-sort={sortBy}
            sx={{ ...ICON_BTN_SX, flexShrink: 0 }}
          >
            <SortModeIcon sx={{ fontSize: 18 }} />
          </IconButton>
        </Tooltip>
      );
    },
    renderBackRow: (label, onBack) => (
      <ListItemButton
        onClick={onBack}
        data-testid="datalake-back"
        sx={treeBackRowSx(theme.palette.notebooklist.hoverBg)}
      >
        <ArrowBackIcon sx={{ fontSize: 16, color: 'text.secondary', flexShrink: 0 }} />
        <Typography noWrap sx={{ fontSize: '14px', fontWeight: 400, color: 'text.primary' }}>
          {label}
        </Typography>
      </ListItemButton>
    ),
    backRowPlacement: 'sticky',
    stickyBackSx: TREE_BACK_STICKY_SX,
    scrollSx: { ...TREE_SCROLL_SX, px: '8px' },
    nodeListSx: TREE_LIST_SX,
    fileListSx: TREE_LIST_SX,
    renderNodeRow: (node, depth, onOpen) => {
      const branchInk = inkFor(hueForBranch(node.segment, breadcrumb), isDark);
      return (
        <ListItem>
          <ListItemButton
            onClick={onOpen}
            sx={treeRowSx(theme.palette.notebooklist.hoverBg)}
            data-testid={`datalake-node-${node.segment}`}
          >
            <FolderOutlinedIcon sx={{ fontSize: 16, color: branchInk, flexShrink: 0 }} />
            <ListItemContent>
              <Typography noWrap sx={{ fontSize: '14px', fontWeight: 400, color: 'text.primary' }}>
                {humanizeSegment(node.segment, depth)}
              </Typography>
            </ListItemContent>
            <Chip size="sm" variant="soft" color="neutral" sx={COUNT_CHIP_SX}>
              {node.fileCount}
            </Chip>
          </ListItemButton>
        </ListItem>
      );
    },
    renderFileRow: (file, selected, onSelect) => (
      <ListItem>
        <ListItemButton
          selected={selected}
          onClick={onSelect}
          data-testid={`datalake-file-${file.id}`}
          sx={treeRowSx(theme.palette.notebooklist.hoverBg)}
        >
          <ArticleOutlinedIcon
            sx={{ fontSize: 16, color: selected ? inkFor(HUES.cyan, isDark) : 'text.tertiary', flexShrink: 0 }}
          />
          <ListItemContent>
            <Typography noWrap sx={{ fontSize: '14px', fontWeight: selected ? 'lg' : 400, color: 'text.primary' }}>
              {file.fileName.replace(/\.[^/.]+$/, '')}
            </Typography>
          </ListItemContent>
        </ListItemButton>
      </ListItem>
    ),
    humanize: humanizeSegment,
    allCategoriesLabel: 'All Categories',
    emptyFilesLabel: 'No articles found',
    errorLabel: 'Failed to load articles',
  };

  return (
    <DataLakeTreeView
      tree={tree}
      articles={articles}
      breadcrumb={breadcrumb}
      onNavigate={onNavigate}
      selectedFileId={selectedFileId}
      onSelectFile={onSelectFile}
      isLoading={isLoading}
      isError={isError}
      chrome={chrome}
      header={header}
      footer={footer}
    />
  );
}
