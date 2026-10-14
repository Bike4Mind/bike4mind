import { FC, useMemo } from 'react';
import { Box, Button, Tooltip, Typography } from '@mui/joy';
import { Science as ScienceIcon } from '@mui/icons-material';
import { blackAlpha } from '@client/app/utils/themes/colors';
import { useLLM } from '@client/app/contexts/LLMContext';
import { useModelInfo } from '@client/app/hooks/data/useModelInfo';
import { useAdvancedAISettings } from './useAdvancedAISettingsStore';
import { isImageModel } from '@client/app/utils/commands';

const ResearchModeIndicator: FC = () => {
  const researchMode = useLLM(state => state.researchMode);
  const model = useLLM(state => state.model);
  const { data: modelInfoRepo } = useModelInfo();
  const openModal = useAdvancedAISettings(s => s.openModal);

  const enabledConfigs = useMemo(
    () => researchMode?.configurations?.filter(c => c.enabled) ?? [],
    [researchMode?.configurations]
  );

  if (!researchMode?.enabled || isImageModel(model)) return null;
  const noModels = (researchMode?.configurations?.length ?? 0) === 0;

  return (
    <Tooltip
      title={
        <Box sx={{ px: '2px', pt: '12px', pb: '4px' }}>
          <Box sx={{ display: 'flex', alignItems: 'center', gap: '12px', mb: '16px', px: '8px' }}>
            <ScienceIcon
              sx={{
                fontSize: '28px',
                color: 'text.primary50',
              }}
            />
            <Box sx={{ display: 'flex', flexDirection: 'column', gap: 0.75 }}>
              <Typography
                level="body-xs"
                sx={{
                  fontWeight: 'normal',
                  color: 'text.primary',
                  fontSize: '14px',
                  lineHeight: 1.2,
                }}
              >
                Research Mode Active
              </Typography>
              <Typography
                level="body-xs"
                sx={{
                  fontSize: '13px',
                  lineHeight: 1.2,
                  color: 'text.primary',
                  opacity: 0.5,
                }}
              >
                {noModels
                  ? 'Click to add models in the configuration to start using research mode'
                  : `Comparing ${enabledConfigs.length} models in parallel:`}
              </Typography>
            </Box>
          </Box>
          {enabledConfigs.map((config, idx) => {
            const configModelInfo = modelInfoRepo?.find(m => m.id === config.model);
            return (
              <Box
                key={config.id}
                onClick={() => openModal('research-mode')}
                sx={{
                  mb: idx === enabledConfigs.length - 1 ? 0 : 1,
                  p: 1.5,
                  borderRadius: '6px',
                  backgroundColor: theme => theme.palette.aiSettings.cardBackground,
                  border: '1px solid',
                  borderColor: theme => theme.palette.aiSettings.cardBorderColor,
                  cursor: 'pointer',
                  transition: 'all 0.2s',
                  '&:hover': {
                    backgroundColor: theme => theme.palette.notebooklist.hoverBg,
                  },
                }}
              >
                <Box sx={{ mb: '8px' }}>
                  <Typography
                    level="body-xs"
                    sx={{
                      fontWeight: 500,
                      fontSize: '14px',
                      color: 'text.primary',
                    }}
                  >
                    {idx + 1}. {configModelInfo?.name || config.model || config.label}
                  </Typography>
                </Box>

                <Box sx={{ display: 'flex', flexDirection: 'row', gap: '20px' }}>
                  {config.parameters.temperature !== undefined && (
                    <Box sx={{ display: 'flex', alignItems: 'center', gap: '2px' }}>
                      <Typography level="body-xs" sx={{ fontSize: '13px', color: 'text.primary', opacity: 0.5 }}>
                        Temp:
                      </Typography>
                      <Typography level="body-xs" sx={{ fontSize: '13px', color: 'text.primary' }}>
                        {config.parameters.temperature}
                      </Typography>
                    </Box>
                  )}
                  {config.parameters.maxTokens && (
                    <Box sx={{ display: 'flex', alignItems: 'center', gap: '2px' }}>
                      <Typography level="body-xs" sx={{ fontSize: '13px', color: 'text.primary', opacity: 0.5 }}>
                        Max Output:
                      </Typography>
                      <Typography level="body-xs" sx={{ fontSize: '13px', color: 'text.primary' }}>
                        {config.parameters.maxTokens.toLocaleString()}
                      </Typography>
                    </Box>
                  )}
                  {config.parameters.topP !== undefined && (
                    <Box sx={{ display: 'flex', alignItems: 'center', gap: '2px' }}>
                      <Typography level="body-xs" sx={{ fontSize: '13px', color: 'text.primary', opacity: 0.5 }}>
                        TopP:
                      </Typography>
                      <Typography level="body-xs" sx={{ fontSize: '13px', color: 'text.primary' }}>
                        {config.parameters.topP}
                      </Typography>
                    </Box>
                  )}
                </Box>
              </Box>
            );
          })}
        </Box>
      }
      arrow
      placement="top"
      sx={{
        border: '1px solid',
        borderColor: 'border.solid',
        minWidth: '320px',
        boxShadow: `0 2px 8px ${blackAlpha[0][6]}`,
        '& .MuiTooltip-arrow': {
          marginTop: '-1px',
          '&::before': {
            borderColor: theme => theme.palette.aiSettings.tooltipArrowBorder,
          },
        },
      }}
    >
      {/* Quiet text on the composer's status line (ComposerStatusLine), matching the balance on
          the other side; warning-coloured while no model is set up to compare. */}
      <Button
        size="sm"
        variant="plain"
        color={noModels ? 'warning' : 'neutral'}
        data-testid="research-mode-status-btn"
        onClick={() => openModal('research-mode')}
        startDecorator={<ScienceIcon sx={{ fontSize: 14 }} />}
        sx={{
          height: '24px',
          minHeight: '24px',
          px: 0.75,
          gap: 0.25,
          borderRadius: '6px',
          whiteSpace: 'nowrap',
          fontSize: '12px',
          fontWeight: 400,
          ...(!noModels && {
            '--variant-plainColor': 'var(--joy-palette-text-tertiary)',
            '--variant-plainHoverColor': 'var(--joy-palette-text-secondary)',
          }),
        }}
      >
        {noModels
          ? 'Research mode \u00b7 add models'
          : `Research mode \u00b7 ${enabledConfigs.length} ${enabledConfigs.length === 1 ? 'model' : 'models'}`}
      </Button>
    </Tooltip>
  );
};

export default ResearchModeIndicator;
