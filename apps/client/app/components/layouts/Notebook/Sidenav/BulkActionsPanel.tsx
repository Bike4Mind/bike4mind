import { Box, Typography, Divider, IconButton } from '@mui/joy';
import { forwardRef } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import CloseIcon from '@mui/icons-material/Close';
import CheckBoxIcon from '@mui/icons-material/CheckBox';
import CheckBoxOutlineBlankIcon from '@mui/icons-material/CheckBoxOutlineBlank';
import ShareIcon from '@mui/icons-material/ShareOutlined';
import FavoriteBorderIcon from '@mui/icons-material/FavoriteBorder';
import FolderIcon from '@mui/icons-material/FolderOutlined';
import LabelIcon from '@mui/icons-material/LabelOutlined';
import DownloadIcon from '@mui/icons-material/DownloadOutlined';
import DeleteIcon from '@mui/icons-material/DeleteOutlined';

interface BulkActionsPanelProps {
  pos: { top: number; left: number };
  selectedCount: number;
  selectableCount: number;
  onClose: () => void;
  onToggleSelectAll: () => void;
  onShare: () => void;
  onFavorite: () => void | Promise<void>;
  onAddToProject: () => void;
  onAddTags: () => void;
  onDownload: () => void | Promise<void>;
  onDelete: () => void;
}

/**
 * Sidebar bulk-actions popover (Select notebooks -> share/favorite/project/tags/download/delete).
 * Portaled to <body> so the `position: fixed` panel anchors to the viewport and isn't clipped by
 * the sidebar's scroll region. The parent owns open/close state and positioning (`bulkActionsPos`),
 * and forwards its `bulkPanelRef` here (used for outside-click detection) via forwardRef.
 */
const BulkActionsPanel = forwardRef<HTMLDivElement, BulkActionsPanelProps>(function BulkActionsPanel(
  {
    pos,
    selectedCount,
    selectableCount,
    onClose,
    onToggleSelectAll,
    onShare,
    onFavorite,
    onAddToProject,
    onAddTags,
    onDownload,
    onDelete,
  },
  ref
) {
  const { t } = useTranslation();

  const allSelected = selectedCount > 0 && selectedCount === selectableCount;

  const actions: {
    key: string;
    icon: typeof ShareIcon;
    label: string;
    onClick: () => void | Promise<void>;
    danger?: boolean;
  }[] = [
    { key: 'share', icon: ShareIcon, label: t('sidenav.shareSelected', 'Share selected'), onClick: onShare },
    {
      key: 'favorite',
      icon: FavoriteBorderIcon,
      label: t('sidenav.addToFavorites', 'Add to favorites'),
      onClick: onFavorite,
    },
    { key: 'project', icon: FolderIcon, label: t('sidenav.addToProject', 'Add to project'), onClick: onAddToProject },
    { key: 'tags', icon: LabelIcon, label: t('sidenav.addTags', 'Add tags'), onClick: onAddTags },
    {
      key: 'download',
      icon: DownloadIcon,
      label: t('sidenav.downloadSelected', 'Download selected'),
      onClick: onDownload,
    },
    { key: 'delete', icon: DeleteIcon, label: t('sidenav.deleteSelected', 'Delete selected'), onClick: onDelete },
  ];

  return createPortal(
    <>
      <Box
        ref={ref}
        data-testid="sidenav-bulk-actions-panel"
        role="menu"
        aria-label={t('sidenav.selectNotebooks', 'SELECT NOTEBOOKS')}
        sx={theme => ({
          position: 'fixed',
          top: pos.top,
          left: pos.left,
          minWidth: 240,
          zIndex: 10001,
          backgroundColor: theme.palette.background.surface,
          border: `1px solid ${theme.palette.divider}`,
          borderRadius: '12px',
          boxShadow: theme.palette.mode === 'light' ? 'none' : theme.shadow.lg,
          p: '8px',
          pt: '16px',
        })}
      >
        {/* Header + selection count */}
        <Box sx={{ pl: '8px', mb: '6px' }}>
          <Box
            sx={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              p: 0,
              mb: '4px',
            }}
          >
            <Typography
              level="body-xs"
              sx={{ color: 'text.tertiary', fontSize: '12px', fontWeight: 400, letterSpacing: 0 }}
            >
              {t('sidenav.selectNotebooks', 'SELECT NOTEBOOKS')}
            </Typography>
            <IconButton
              data-testid="sidenav-bulk-actions-close"
              aria-label={t('common.close', 'Close')}
              size="sm"
              variant="plain"
              color="neutral"
              onClick={onClose}
              sx={{ minWidth: 0, minHeight: 0, p: '2px' }}
            >
              <CloseIcon sx={{ fontSize: '18px', color: 'text.tertiary' }} />
            </IconButton>
          </Box>

          <Typography level="body-sm" sx={{ color: 'text.primary', fontWeight: 500, fontSize: '13px', p: 0, m: 0 }}>
            {selectedCount} {t('sidenav.selected', 'selected')}
          </Typography>
        </Box>

        {/* Select all */}
        <Box
          data-testid="sidenav-bulk-select-all"
          role="menuitemcheckbox"
          aria-checked={allSelected}
          tabIndex={0}
          onClick={onToggleSelectAll}
          onKeyDown={e => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              onToggleSelectAll();
            }
          }}
          sx={theme => ({
            display: 'flex',
            alignItems: 'center',
            gap: '12px',
            px: '8px',
            height: '36px',
            mb: '6px',
            borderRadius: '8px',
            cursor: 'pointer',
            color: theme.palette.sidenav?.navItemText,
            '--Icon-color': theme.palette.text.tertiary,
            transition: 'background 0.15s',
            '&:hover': { backgroundColor: theme.palette.notebooklist.hoverBg },
            '&:focus-visible': {
              outline: `2px solid ${theme.palette.primary[500]}`,
              outlineOffset: '-2px',
            },
          })}
        >
          <Box
            sx={{
              width: 22,
              height: 22,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              flexShrink: 0,
            }}
          >
            {allSelected ? (
              <CheckBoxIcon sx={{ fontSize: '18px', color: 'text.primary' }} />
            ) : (
              <CheckBoxOutlineBlankIcon sx={{ fontSize: '18px', color: 'text.tertiary' }} />
            )}
          </Box>
          <Typography level="body-sm" sx={{ flex: 1, color: 'inherit', fontSize: '14px', fontWeight: 400 }} noWrap>
            {t('sidenav.selectAll', 'Select all')}
          </Typography>
        </Box>

        <Divider sx={{ my: '6px' }} />

        {/* Bulk actions */}
        {actions.map(({ key, icon: Icon, label, onClick, danger }) => (
          <Box
            key={key}
            data-testid={`sidenav-bulk-${key}`}
            role="menuitem"
            tabIndex={0}
            onClick={onClick}
            onKeyDown={e => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                void onClick();
              }
            }}
            sx={theme => ({
              display: 'flex',
              alignItems: 'center',
              gap: '12px',
              px: '8px',
              height: '36px',
              borderRadius: '8px',
              cursor: 'pointer',
              color: danger ? theme.palette.danger[500] : theme.palette.sidenav?.navItemText,
              // Joy icons read --Icon-color, not `color`. Tint them text.tertiary (danger -> red).
              '--Icon-color': danger ? theme.palette.danger[500] : theme.palette.text.tertiary,
              transition: 'background 0.15s',
              '&:hover': { backgroundColor: theme.palette.notebooklist.hoverBg },
              '&:focus-visible': {
                outline: `2px solid ${theme.palette.primary[500]}`,
                outlineOffset: '-2px',
              },
            })}
          >
            <Box
              sx={{
                width: 22,
                height: 22,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                flexShrink: 0,
              }}
            >
              <Icon sx={{ fontSize: '18px' }} />
            </Box>
            <Typography level="body-sm" sx={{ flex: 1, color: 'inherit', fontSize: '14px', fontWeight: 400 }} noWrap>
              {label}
            </Typography>
          </Box>
        ))}
      </Box>
    </>,
    document.body
  );
});

export default BulkActionsPanel;
