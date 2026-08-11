import {
  Box,
  Button,
  Chip,
  Dropdown,
  IconButton,
  ListItem,
  ListItemButton,
  ListItemContent,
  Menu,
  MenuButton,
  MenuItem,
  Tooltip,
  Typography,
  useTheme,
} from '@mui/joy';
import FolderOutlinedIcon from '@mui/icons-material/FolderOutlined';
import ArticleOutlinedIcon from '@mui/icons-material/ArticleOutlined';
import ArrowBackIcon from '@mui/icons-material/ArrowBack';
import AddIcon from '@mui/icons-material/Add';
import CloseIcon from '@mui/icons-material/Close';
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutline';
import HelpOutlineIcon from '@mui/icons-material/HelpOutline';
import MoreVertIcon from '@mui/icons-material/MoreVert';
import VisibilityOutlinedIcon from '@mui/icons-material/VisibilityOutlined';
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
  /** Hover action: attach the file to the chat session. */
  onAttachFile: (file: IFabFileDocument) => void;
  /** Hover menu action: open the file in the rail reader. */
  onViewFile: (file: IFabFileDocument) => void;
  /** Gates the per-row delete button (owning lake resolved + manageable). */
  canDeleteFile: (file: IFabFileDocument) => boolean;
  /** Hover action: request removal from the owning lake (host owns the confirm). */
  onDeleteFile: (file: IFabFileDocument) => void;
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

/** Compact 22px hover-action buttons so three of them fit a 260px rail row. */
const ROW_ACTION_SX = {
  '--IconButton-size': '22px',
  minWidth: '22px',
  minHeight: '22px',
} as const;

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
  onAttachFile,
  onViewFile,
  canDeleteFile,
  onDeleteFile,
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
    stickyBackSx: TREE_BACK_STICKY_SX,
    scrollSx: { ...TREE_SCROLL_SX, px: '8px' },
    nodeListSx: TREE_LIST_SX,
    fileListSx: TREE_LIST_SX,
    renderNodeRow: (node, depth, onOpen) => {
      const branchInk = inkFor(hueForBranch(node.segment, breadcrumb), isDark);
      return (
        <ListItem key={node.segment}>
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
    renderFileRow: (file, selected) => (
      <ListItem key={file.id}>
        {/* Plain row, not a ListItemButton: row clicks are dead by design (auto-attach removal);
            every action is an explicit control. Actions reveal on hover/focus and stay visible
            on touch (no-hover) devices. */}
        <Box
          data-testid={`datalake-file-${file.id}`}
          sx={{
            display: 'flex',
            alignItems: 'center',
            gap: '8px',
            width: '100%',
            minWidth: 0,
            minHeight: '28px',
            borderRadius: '8px',
            px: '8px',
            transition: 'background 0.15s',
            backgroundColor: selected ? theme.palette.notebooklist.hoverBg : undefined,
            '&:hover': { backgroundColor: theme.palette.notebooklist.hoverBg },
            '@media (hover: hover)': { '& .dl-row-actions': { opacity: 0 } },
            '&:hover .dl-row-actions, &:focus-within .dl-row-actions': { opacity: 1 },
          }}
        >
          <ArticleOutlinedIcon
            sx={{ fontSize: 16, color: selected ? inkFor(HUES.cyan, isDark) : 'text.tertiary', flexShrink: 0 }}
          />
          <Typography
            noWrap
            sx={{ flex: 1, minWidth: 0, fontSize: '14px', fontWeight: selected ? 'lg' : 400, color: 'text.primary' }}
          >
            {file.fileName.replace(/\.[^/.]+$/, '')}
          </Typography>
          <Box
            className="dl-row-actions"
            sx={{ display: 'flex', alignItems: 'center', gap: '2px', flexShrink: 0, transition: 'opacity 0.15s' }}
          >
            <Tooltip title="Add to chat" size="sm">
              <IconButton
                size="sm"
                variant="plain"
                color="neutral"
                aria-label="Add to chat"
                data-testid={`datalake-attach-btn-${file.id}`}
                onClick={() => onAttachFile(file)}
                sx={ROW_ACTION_SX}
              >
                <AddIcon sx={{ fontSize: 16 }} />
              </IconButton>
            </Tooltip>
            {canDeleteFile(file) && (
              <Tooltip title="Remove from lake" size="sm">
                <IconButton
                  size="sm"
                  variant="plain"
                  color="neutral"
                  aria-label="Remove from lake"
                  data-testid={`datalake-delete-btn-${file.id}`}
                  onClick={() => onDeleteFile(file)}
                  sx={ROW_ACTION_SX}
                >
                  <DeleteOutlineIcon sx={{ fontSize: 16 }} />
                </IconButton>
              </Tooltip>
            )}
            <Dropdown>
              <MenuButton
                slots={{ root: IconButton }}
                slotProps={{
                  root: {
                    size: 'sm',
                    variant: 'plain',
                    color: 'neutral',
                    'aria-label': 'More actions',
                    'data-testid': `datalake-row-menu-btn-${file.id}`,
                    sx: ROW_ACTION_SX,
                  },
                }}
              >
                <MoreVertIcon sx={{ fontSize: 16 }} />
              </MenuButton>
              <Menu size="sm" placement="bottom-end">
                <MenuItem data-testid={`datalake-view-item-${file.id}`} onClick={() => onViewFile(file)}>
                  <VisibilityOutlinedIcon sx={{ fontSize: 16 }} />
                  View
                </MenuItem>
              </Menu>
            </Dropdown>
          </Box>
        </Box>
      </ListItem>
    ),
    humanize: humanizeSegment,
    allCategoriesLabel: 'All Categories',
    emptyFilesLabel: 'No articles found',
    errorLabel: 'Failed to load articles',
  };

  return (
    // Chat rows carry explicit actions instead of a click handler; TreeView still requires the
    // callback for the page tree's sake, so it gets a no-op.
    <DataLakeTreeView
      tree={tree}
      articles={articles}
      breadcrumb={breadcrumb}
      onNavigate={onNavigate}
      selectedFileId={selectedFileId}
      onSelectFile={() => {}}
      isLoading={isLoading}
      isError={isError}
      chrome={chrome}
      header={header}
      footer={footer}
    />
  );
}
