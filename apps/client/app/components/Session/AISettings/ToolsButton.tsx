import { FC, useMemo, useRef, useState } from 'react';
import { scrollbarStyles } from '@client/app/utils/scrollbarStyles';
import { Box, Dropdown, IconButton, Menu, MenuButton, Modal, ModalDialog, Typography } from '@mui/joy';
import { Construction as ConstructionIcon } from '@mui/icons-material';
import { B4MLLMTools } from '@bike4mind/common';
import ToolsSection from './ToolsSection';
import ToolIndicators from '../../common/ToolIndicators';
import { useModelInfo } from '@client/app/hooks/data/useModelInfo';

const fixedHeight = {
  height: '32px !important',
  minHeight: '32px !important',
  maxHeight: '32px !important',
};

interface ToolsButtonProps {
  isMobile: boolean;
  isTablet: boolean;
  tools: B4MLLMTools[];
  toolMode: string;
  model: string;
  onRollDice: () => void;
  activePrimaryTools: string[];
  isThinkingActive: boolean;
  otherActiveToolsCount: number;
  enabledMcpServers: string[] | null;
  availableMcpServers: string[];
  setTools: (tools: B4MLLMTools[]) => void;
}

const ToolsButton: FC<ToolsButtonProps> = ({
  isMobile,
  isTablet,
  tools,
  toolMode,
  model,
  onRollDice,
  activePrimaryTools,
  isThinkingActive,
  otherActiveToolsCount,
  enabledMcpServers,
  availableMcpServers,
  setTools,
}) => {
  const [open, setOpen] = useState(false);
  const [isDeepResearchModalOpen, setIsDeepResearchModalOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const { data: modelInfoRepo } = useModelInfo();
  const modelSupportsTools = useMemo(
    () => modelInfoRepo?.find(m => m.id === model)?.supportsTools ?? true,
    [model, modelInfoRepo]
  );

  const toolsSectionProps = {
    tools,
    setTools,
    model,
    onRollDice,
    columns: 1 as const,
    onModalOpenChange: setIsDeepResearchModalOpen,
    onClose: () => setOpen(false),
    toolContainerSx: {
      backgroundColor: (theme: { palette: { background: { surface2: string } } }) => theme.palette.background.surface2,
      padding: '12px',
      '&:hover': {
        backgroundColor: (theme: { palette: { background: { surface2: string } } }) =>
          theme.palette.background.surface2,
      },
    },
  };

  if (isMobile) {
    return (
      <>
        <IconButton
          data-testid="session-tools-dropdown-toggle"
          variant="outlined"
          size="sm"
          onClick={() => setOpen(true)}
          sx={{
            borderRadius: '6px',
            ...fixedHeight,
            width: '32px',
          }}
        >
          <ConstructionIcon
            sx={{
              color: 'text.primary',
              width: '14px',
              height: '14px',
            }}
          />
        </IconButton>
        <Modal open={open} onClose={() => !isDeepResearchModalOpen && setOpen(false)}>
          <ModalDialog
            sx={{
              p: 1,
              width: '90dvw',
              height: '90dvh',
              border: 'none',
              backgroundColor: 'background.body',
              overflow: 'auto',
            }}
          >
            <ToolsSection {...toolsSectionProps} />
          </ModalDialog>
        </Modal>
      </>
    );
  }

  return (
    <Dropdown
      open={open}
      onOpenChange={(_, isOpen) => {
        if (!isOpen && isDeepResearchModalOpen) return;
        setOpen(isOpen);
        if (isOpen) {
          setTimeout(() => menuRef.current?.focus(), 100);
        }
      }}
    >
      <MenuButton
        data-testid="session-tools-dropdown-toggle"
        variant="outlined"
        sx={{
          display: 'flex',
          borderRadius: '6px',
          ...fixedHeight,
          px: 1,
        }}
      >
        <Box sx={{ display: 'flex', alignItems: 'center', gap: '16px' }}>
          <Box sx={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
            <ConstructionIcon
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
                {toolMode === 'smart' ? 'Tools' : 'Fast Tools'}
              </Typography>
            )}
          </Box>
          <ToolIndicators
            activePrimaryTools={activePrimaryTools}
            isThinkingActive={isThinkingActive}
            otherActiveToolsCount={otherActiveToolsCount}
            enabledMcpServers={enabledMcpServers}
            availableMcpServers={availableMcpServers}
          />
        </Box>
      </MenuButton>

      <Menu
        ref={menuRef}
        placement="top"
        autoFocus
        sx={{
          zIndex: 1400,
          ...(modelSupportsTools
            ? { minWidth: '500px', maxWidth: '500px', p: '8px' }
            : { minWidth: 'auto', maxWidth: 'auto', p: '16px' }),
          backgroundColor: theme => theme.palette.background.body,
          border: theme => `1px solid ${theme.vars.palette.neutral.outlinedBorder}`,
          maxHeight: '550px',
          overflow: 'auto',
          boxShadow: 'none',
          ...scrollbarStyles,
        }}
      >
        <Box>
          <ToolsSection {...toolsSectionProps} />
        </Box>
      </Menu>
    </Dropdown>
  );
};

export default ToolsButton;
