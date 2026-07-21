import { FC, useCallback, useEffect, useMemo, useRef, useState } from 'react';
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

  // Mobile: show a bottom fade while there's more to scroll, so it's obvious the
  // panel scrolls (custom scrollbars are unreliable on touch). Hidden at the end.
  const mobileScrollRef = useRef<HTMLDivElement>(null);
  const [showBottomFade, setShowBottomFade] = useState(false);
  const updateBottomFade = useCallback(() => {
    const el = mobileScrollRef.current;
    if (!el) return;
    const scrollable = el.scrollHeight > el.clientHeight;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 8;
    setShowBottomFade(scrollable && !atBottom);
  }, []);
  useEffect(() => {
    if (open) updateBottomFade();
  }, [open, updateBottomFade]);
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
              p: 0,
              width: '90dvw',
              height: '90dvh',
              border: 'none',
              backgroundColor: 'background.body',
              overflow: 'hidden',
              position: 'relative',
            }}
          >
            <Box
              ref={mobileScrollRef}
              onScroll={updateBottomFade}
              sx={{ height: '100%', overflow: 'auto', p: 1, ...scrollbarStyles }}
            >
              <ToolsSection {...toolsSectionProps} />
            </Box>
            {/* Scroll affordance: fades content at the bottom edge while more is below. */}
            <Box
              sx={{
                position: 'absolute',
                left: 0,
                right: 0,
                bottom: 0,
                height: '48px',
                pointerEvents: 'none',
                opacity: showBottomFade ? 1 : 0,
                transition: 'opacity 0.2s',
                background: theme => `linear-gradient(to bottom, transparent, ${theme.vars.palette.background.body})`,
              }}
            />
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
          {/* Fast mode sends no tools, so nothing is actually active - hide all
              indicators (tool icons, count, and thinking). Selections persist and
              reappear when switching back to Smart. */}
          {toolMode !== 'fast' && (
            <ToolIndicators
              activePrimaryTools={activePrimaryTools}
              isThinkingActive={isThinkingActive}
              otherActiveToolsCount={otherActiveToolsCount}
              enabledMcpServers={enabledMcpServers}
              availableMcpServers={availableMcpServers}
            />
          )}
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
