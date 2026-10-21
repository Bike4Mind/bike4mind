import { FC, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { Box, Button, Dropdown, IconButton, Menu, MenuButton, Tooltip, Typography } from '@mui/joy';
import { Close, InfoOutlined, InsertDriveFileOutlined } from '@mui/icons-material';
import FilesSection from '@client/app/components/Session/AISettings/FilesSection';
import { useAdvancedAISettings } from '@client/app/components/Session/AdvancedAISettings';
import { HEADER_ICON_BUTTON_SX } from '@client/app/components/Session/AISettings/headerIconButtonSx';
import { scrollbarStyles } from '@client/app/utils/scrollbarStyles';
import { STATUS_ITEM_HEIGHT, useStatusLineCompact } from './ComposerStatusLine';

interface NotebookFilesChipProps {
  totalFilesCount: number;
  /** Some files were embedded with a model this deployment no longer searches with. */
  hasEmbeddingMismatches: boolean;
  model: string;
  isMobile: boolean;
  open: boolean;
  setOpen: (open: boolean) => void;
}

// Quiet text like the balance on the other side of the line (CreditButton) - keep the two in sync.
const quietSx = {
  height: STATUS_ITEM_HEIGHT,
  minHeight: STATUS_ITEM_HEIGHT,
  px: 0.75,
  gap: 0.25,
  borderRadius: '6px',
  whiteSpace: 'nowrap',
  fontSize: '12px',
  fontWeight: 400,
  fontVariantNumeric: 'tabular-nums',
} as const;

const DESCRIPTION = 'Sent to the AI with every message in this notebook. They stay until you remove them.';

/**
 * The notebook's files on the composer's status line (ComposerStatusLine), where the toolbar used
 * to carry a files button. Desktop opens the files panel as a menu; phones open the existing
 * Session Files modal (SessionBottomModals). Renders nothing while the notebook has no files.
 */
const NotebookFilesChip: FC<NotebookFilesChipProps> = ({
  totalFilesCount,
  hasEmbeddingMismatches,
  model,
  isMobile,
  open,
  setOpen,
}) => {
  const { t } = useTranslation();
  const menuRef = useRef<HTMLDivElement>(null);
  const setSessionFilesOpen = useAdvancedAISettings(s => s.setSessionFilesOpen);
  const compact = useStatusLineCompact();

  if (totalFilesCount <= 0) return null;

  // "notebook", not just "files": these stay with every message, unlike a one-off attachment.
  const label = `${totalFilesCount} notebook ${totalFilesCount === 1 ? 'file' : 'files'}`;
  const tooltip = hasEmbeddingMismatches
    ? 'Some files were indexed for a different model, so search cannot reach them. Open to reprocess.'
    : 'Kept with this notebook and sent with every message';
  // Out of room on the status line: the icon and the number, the words in the tooltip and the name.
  const shown = compact ? String(totalFilesCount) : label;
  const title = compact ? `${label}. ${tooltip}` : tooltip;
  const color = hasEmbeddingMismatches ? 'danger' : 'neutral';
  const sx = {
    ...quietSx,
    ...(!hasEmbeddingMismatches && {
      '--variant-plainColor': 'var(--joy-palette-text-tertiary)',
      '--variant-plainHoverColor': 'var(--joy-palette-text-secondary)',
    }),
  };
  const icon = <InsertDriveFileOutlined sx={{ fontSize: 14, color: 'inherit' }} />;

  if (isMobile) {
    return (
      <Button
        size="sm"
        variant="plain"
        color={color}
        data-testid="session-files-btn"
        startDecorator={icon}
        onClick={() => setSessionFilesOpen(true)}
        aria-label={compact ? label : undefined}
        sx={sx}
      >
        {shown}
      </Button>
    );
  }

  return (
    <Dropdown
      open={open}
      onOpenChange={(_, isOpen) => {
        setOpen(isOpen);
        if (isOpen) setTimeout(() => menuRef.current?.focus(), 100);
      }}
    >
      <Tooltip title={title} placement="top" variant="soft">
        <MenuButton
          slots={{ root: Button }}
          slotProps={{ root: { size: 'sm', variant: 'plain', color, startDecorator: icon } }}
          data-testid="session-files-btn"
          aria-label={compact ? label : undefined}
          sx={sx}
        >
          {shown}
        </MenuButton>
      </Tooltip>
      {/* Framed like the Tools dropdown (ToolsButton + the sticky header in ToolsSection). */}
      <Menu
        ref={menuRef}
        placement="top-start"
        autoFocus
        sx={{
          zIndex: 1400,
          width: '400px',
          maxHeight: '400px',
          overflow: 'auto',
          p: '8px',
          backgroundColor: 'background.body',
          border: theme => `1px solid ${theme.vars.palette.neutral.outlinedBorder}`,
          boxShadow: 'none',
          ...scrollbarStyles,
        }}
      >
        {/* The -8px margins break out of the menu's padding so the bottom border runs edge to edge. */}
        <Box
          data-testid="notebook-files-header"
          sx={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 1,
            p: '8px 12px',
            mx: '-8px',
            mt: '-8px',
            mb: '12px',
            borderBottom: '1px solid',
            borderColor: 'border.soft',
            position: 'sticky',
            top: '-8px',
            backgroundColor: 'background.body',
            zIndex: 10,
          }}
        >
          <Typography sx={{ color: 'text.primary', fontSize: '14px' }}>Notebook files</Typography>
          {/* Help + close pair styled like the Tools dropdown header (HEADER_ICON_BUTTON_SX). */}
          <Box sx={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <Tooltip title={DESCRIPTION} placement="top" sx={{ maxWidth: '260px' }}>
              <IconButton
                variant="plain"
                size="sm"
                aria-label="About notebook files"
                data-testid="notebook-files-info-btn"
                sx={HEADER_ICON_BUTTON_SX}
              >
                <InfoOutlined sx={{ fontSize: '16px' }} />
              </IconButton>
            </Tooltip>
            <IconButton
              variant="plain"
              size="sm"
              aria-label={t('a11y.close_files', 'Close files')}
              onClick={() => setOpen(false)}
              data-testid="close-files-dropdown"
              sx={HEADER_ICON_BUTTON_SX}
            >
              <Close sx={{ fontSize: '16px' }} />
            </IconButton>
          </Box>
        </Box>
        <FilesSection model={model} />
      </Menu>
    </Dropdown>
  );
};

export default NotebookFilesChip;
