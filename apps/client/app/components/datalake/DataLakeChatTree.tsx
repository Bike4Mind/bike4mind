import {
  Box,
  Button,
  Chip,
  Dropdown,
  IconButton,
  ListDivider,
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
import {
  MENU_ROW_ICON_SX,
  menuRowSx,
  menuSurfaceSx,
} from '@client/app/components/layouts/Notebook/Sidenav/menuSurfaceSx';
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

/**
 * One item in a file row's action menu, styled like the profile menu's rows. Joy MenuItem
 * needs --variant-plainHoverBg pointed at the hover colour too, or its own variant rule wins
 * over the shared recipe's `&:hover`.
 */
const RowMenuItem = ({
  testId,
  icon,
  label,
  onClick,
  danger,
}: {
  testId: string;
  icon: React.ReactNode;
  label: string;
  onClick: () => void;
  danger?: boolean;
}) => (
  <MenuItem
    data-testid={testId}
    onClick={onClick}
    sx={itemTheme => ({
      ...menuRowSx(itemTheme, danger),
      '--variant-plainHoverBg': itemTheme.palette.notebooklist.hoverBg,
      // Tighter than the profile menu's 40px: these rows sit in a 260px rail, not a full panel.
      height: '36px',
      // Joy drives row geometry from these vars, so pin them to the values above rather than
      // relying on sx winning the cascade against Joy's own rule.
      '--ListItem-paddingLeft': '10px',
      '--ListItem-paddingRight': '10px',
      '--ListItem-paddingY': '0px',
      '--ListItem-minHeight': '36px',
      '--ListItem-radius': '8px',
      '--ListItem-gap': '12px',
    })}
  >
    <Box sx={MENU_ROW_ICON_SX}>{icon}</Box>
    <Typography level="body-sm" noWrap sx={{ flex: 1, color: 'inherit', fontSize: '14px', fontWeight: 400 }}>
      {label}
    </Typography>
  </MenuItem>
);

/**
 * The row's three-dots trigger: compact for a 260px rail, and frameless like the tree header's
 * own icon buttons (HEADER_ICON_BUTTON_SX) - only the icon brightens, no ground appears under
 * it. The variant vars are zeroed because Joy paints hover/active fills from them, and a filled
 * square inside an already-highlighted row reads as a second, competing surface.
 */
const ROW_ACTION_SX = {
  '--IconButton-size': '22px',
  '--Icon-color': 'currentColor',
  '--variant-plainHoverBg': 'transparent',
  '--variant-plainActiveBg': 'transparent',
  minWidth: '22px',
  minHeight: '22px',
  color: 'text.tertiary',
  transition: 'color 0.3s',
  '&:hover': { backgroundColor: 'transparent', color: 'text.primary' },
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
      // The row Box owns all of the padding. Joy's ListItem always pads itself and relies on a
      // ListItemButton child cancelling it with negative margins (--ListItemButton-marginInline);
      // a plain Box has no such margin, so leaving this padding in place indents file rows twice
      // as far as the folder rows above.
      <ListItem key={file.id} sx={{ p: 0 }}>
        {/* Plain row, not a ListItemButton: row clicks are dead by design (auto-attach removal);
            every action lives in the row's three-dots menu. The trigger reveals on hover/focus,
            stays visible on touch (no-hover) devices, and pins while its menu is open (:has on
            aria-expanded) so the anchor cannot fade under an open menu. */}
        <Box
          data-testid={`datalake-file-${file.id}`}
          sx={{
            // Same row recipe as the folder rows above, plus the box a Joy ListItemButton makes
            // for itself: the 1px transparent border and the padding read off Joy's own
            // --ListItem vars. Without both, a file row's icon sits a pixel left of a folder
            // row's and the two lists visibly fail to line up.
            ...treeRowSx(theme.palette.notebooklist.hoverBg),
            display: 'flex',
            alignItems: 'center',
            width: '100%',
            minWidth: 0,
            border: '1px solid transparent',
            paddingBlock: 'var(--ListItem-paddingY)',
            paddingInline: 'var(--ListItem-paddingX)',
            backgroundColor: selected ? theme.palette.notebooklist.hoverBg : undefined,
            '&:hover': { backgroundColor: theme.palette.notebooklist.hoverBg },
            '@media (hover: hover)': { '& .dl-row-actions': { opacity: 0 } },
            '&:hover .dl-row-actions, &:focus-within .dl-row-actions': { opacity: 1 },
            '&:has([aria-expanded="true"]) .dl-row-actions': { opacity: 1 },
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
            <Dropdown>
              {/* variant/color go on the MenuButton itself, not only on the IconButton slot:
                  MenuButton emits its OWN variant class, and its 'outlined' default would
                  paint a border and a hover fill over the plain slot underneath. */}
              <MenuButton
                variant="plain"
                color="neutral"
                size="sm"
                slots={{ root: IconButton }}
                slotProps={{
                  root: {
                    'aria-label': 'File actions',
                    'data-testid': `datalake-row-menu-btn-${file.id}`,
                    sx: ROW_ACTION_SX,
                  },
                }}
              >
                <MoreVertIcon sx={{ fontSize: 16 }} />
              </MenuButton>
              {/* Same floating-surface + row recipe as the profile menu (menuSurfaceSx). */}
              <Menu
                size="sm"
                placement="bottom-end"
                sx={menuTheme => ({
                  ...menuSurfaceSx(menuTheme),
                  borderRadius: '8px',
                  minWidth: 200,
                  // Joy's List vars, pinned for the same reason as the row's below: p:1 from the
                  // shared recipe would otherwise fight --List-padding.
                  '--List-padding': '8px',
                  '--List-radius': '8px',
                  '--List-gap': '2px',
                  '--ListDivider-gap': '8px',
                })}
              >
                <RowMenuItem
                  testId={`datalake-attach-item-${file.id}`}
                  icon={<AddIcon sx={{ fontSize: 18 }} />}
                  label="Add to chat"
                  onClick={() => onAttachFile(file)}
                />
                <RowMenuItem
                  testId={`datalake-view-item-${file.id}`}
                  icon={<VisibilityOutlinedIcon sx={{ fontSize: 18 }} />}
                  label="View"
                  onClick={() => onViewFile(file)}
                />
                {canDeleteFile(file) && <ListDivider />}
                {canDeleteFile(file) && (
                  <RowMenuItem
                    testId={`datalake-delete-item-${file.id}`}
                    icon={<DeleteOutlineIcon sx={{ fontSize: 18 }} />}
                    label="Remove"
                    onClick={() => onDeleteFile(file)}
                    danger
                  />
                )}
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
