import { FC, useRef, useState } from 'react';
import { Box, Dropdown, Menu, MenuButton, Modal, ModalDialog, Typography } from '@mui/joy';
import { SmartToy as SmartToyIcon } from '@mui/icons-material';
import AgentsSection from './AgentsSection';
import AgentsCountBadge from '../../common/AgentsCountBadge';
import { useAdvancedAISettings } from './useAdvancedAISettingsStore';

const fixedHeight = {
  height: '32px !important',
  minHeight: '32px !important',
  maxHeight: '32px !important',
};

interface AgentsButtonProps {
  isMobile: boolean;
  isTablet: boolean;
  activeAgentsCount: number;
}

const AgentsButton: FC<AgentsButtonProps> = ({ isMobile, isTablet, activeAgentsCount }) => {
  const [desktopOpen, setDesktopOpen] = useState(false);
  const [isAgentSettingsModalOpen, setIsAgentSettingsModalOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  // Mobile agents modal is driven by the shared store (triggered from AttachFileButton)
  const mobileOpen = useAdvancedAISettings(s => s.agentsDropdownOpen);
  const setMobileOpen = useAdvancedAISettings(s => s.setAgentsDropdownOpen);

  if (isMobile) {
    return (
      <Modal open={mobileOpen} onClose={() => setMobileOpen(false)}>
        <ModalDialog
          sx={{
            p: 0,
            width: '90dvw',
            height: '90dvh',
            border: 'none',
            backgroundColor: 'background.body',
          }}
        >
          <AgentsSection onClose={() => setMobileOpen(false)} onModalOpenChange={setIsAgentSettingsModalOpen} />
        </ModalDialog>
      </Modal>
    );
  }

  return (
    <Dropdown
      open={desktopOpen}
      onOpenChange={(_, isOpen) => {
        if (!isOpen && isAgentSettingsModalOpen) return;
        setDesktopOpen(isOpen);
        if (isOpen) {
          setTimeout(() => menuRef.current?.focus(), 100);
        }
      }}
    >
      <MenuButton
        variant="outlined"
        sx={{
          display: 'flex',
          borderRadius: '6px',
          px: 1,
          ...fixedHeight,
        }}
      >
        <Box sx={{ display: 'flex', alignItems: 'center', gap: '16px' }}>
          <Box sx={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
            <SmartToyIcon
              sx={{
                color: 'text.primary',
                width: '14px',
                height: '14px',
              }}
            />
            {!isTablet && (
              <Typography
                level="body-sm"
                sx={{
                  color: 'text.primary',
                  fontWeight: '400',
                  fontSize: '14px',
                }}
              >
                Agents
              </Typography>
            )}
          </Box>
          <AgentsCountBadge count={activeAgentsCount} sx={{ px: 1, minWidth: 'auto', width: 'auto', ml: 0 }} />
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
          p: 0,
          borderRadius: '8px',
          width: '100%',
          maxWidth: '340px',
        }}
      >
        <AgentsSection onClose={() => setDesktopOpen(false)} onModalOpenChange={setIsAgentSettingsModalOpen} />
      </Menu>
    </Dropdown>
  );
};

export default AgentsButton;
