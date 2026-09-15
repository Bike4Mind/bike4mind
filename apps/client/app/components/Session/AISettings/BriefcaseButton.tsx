import { FC, useRef, useState } from 'react';
import { Box, Dropdown, IconButton, Menu, MenuButton, Modal, ModalDialog, Typography } from '@mui/joy';
import { WorkOutline as BriefcaseIcon, Close as CloseIcon } from '@mui/icons-material';
import { BriefcasePanel } from '@client/app/components/Briefcase/BriefcasePanel';

const fixedHeight = {
  height: '32px !important',
  minHeight: '32px !important',
  maxHeight: '32px !important',
};

interface BriefcaseButtonProps {
  isMobile: boolean;
  isTablet: boolean;
}

/**
 * Composer-toolbar entry for the briefcase. Mirrors AgentsButton: a desktop
 * Dropdown/Menu and a mobile Modal, both rendering the catalog (BriefcasePanel)
 * as the popover body. Visibility is feature-gated by the caller.
 */
const BriefcaseButton: FC<BriefcaseButtonProps> = ({ isMobile, isTablet }) => {
  const [open, setOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  if (isMobile) {
    return (
      <>
        <IconButton
          data-testid="briefcase-toggle"
          variant="outlined"
          size="sm"
          onClick={() => setOpen(true)}
          sx={{ borderRadius: '6px', width: '32px', ...fixedHeight }}
        >
          <BriefcaseIcon sx={{ color: 'text.primary', width: '14px', height: '14px' }} />
        </IconButton>
        <Modal open={open} onClose={() => setOpen(false)}>
          <ModalDialog
            sx={{ p: 1, width: '90dvw', maxHeight: '90dvh', border: 'none', backgroundColor: 'background.body' }}
          >
            <IconButton
              onClick={() => setOpen(false)}
              size="sm"
              variant="plain"
              color="neutral"
              sx={{ zIndex: 1, alignSelf: 'flex-end' }}
              data-testid="briefcase-modal-close-btn"
            >
              <CloseIcon sx={{ fontSize: 20 }} />
            </IconButton>
            <Box sx={{ overflow: 'auto' }}>
              <BriefcasePanel onLaunched={() => setOpen(false)} />
            </Box>
          </ModalDialog>
        </Modal>
      </>
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
      <MenuButton
        data-testid="briefcase-toggle"
        variant="outlined"
        sx={{ display: 'flex', borderRadius: '6px', px: 1, ...fixedHeight }}
      >
        <Box sx={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
          <BriefcaseIcon sx={{ color: 'text.primary', width: '14px', height: '14px' }} />
          {!isTablet && (
            <Typography level="body-sm" sx={{ color: 'text.primary', fontWeight: '400', fontSize: '14px' }}>
              Briefcase
            </Typography>
          )}
        </Box>
      </MenuButton>
      <Menu
        ref={menuRef}
        placement="top"
        autoFocus
        sx={{
          zIndex: 1400,
          border: '1px solid',
          borderColor: 'border.soft',
          boxShadow: 'none',
          backgroundColor: 'background.body',
          p: 1,
          borderRadius: '8px',
          minWidth: '300px',
          maxWidth: '360px',
          maxHeight: '480px',
          overflow: 'auto',
        }}
      >
        <BriefcasePanel onLaunched={() => setOpen(false)} />
      </Menu>
    </Dropdown>
  );
};

export default BriefcaseButton;
