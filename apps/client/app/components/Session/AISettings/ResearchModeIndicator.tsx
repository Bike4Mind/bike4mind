import { FC, useMemo } from 'react';
import { Box, Tooltip, Typography } from '@mui/joy';
import { Science as ScienceIcon } from '@mui/icons-material';
import { blackAlpha, red } from '@client/app/utils/themes/colors';
import { useLLM } from '@client/app/contexts/LLMContext';
import { useModelInfo } from '@client/app/hooks/data/useModelInfo';
import { useAdvancedAISettings } from './useAdvancedAISettingsStore';
import { isImageModel } from '@client/app/utils/commands';

const fixedHeight = {
  height: '32px !important',
  minHeight: '32px !important',
  maxHeight: '32px !important',
};

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
                {researchMode?.configurations?.length === 0
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
      <Box
        sx={{
          display: 'flex',
          alignItems: 'center',
          borderRadius: '6px',
          border: '1px solid',
          borderColor: researchMode?.configurations?.length === 0 ? red[600] : 'border.solid',
          backgroundColor: theme => theme.palette.primary.softBg,
          cursor: 'pointer',
          transition: 'all 0.2s',
          px: 1,
          ...fixedHeight,
          '&:hover': {
            backgroundColor: theme => theme.palette.primary.softHoverBg,
            borderColor: 'primary.dark',
          },
        }}
        onClick={() => openModal('research-mode')}
      >
        <Box sx={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
          <ScienceIcon
            sx={{
              color: 'text.primary',
              width: '14px',
              height: '14px',
            }}
          />
          <Typography
            level="body-sm"
            sx={{
              color: 'text.primary',
              fontWeight: '400',
              fontSize: '14px',
            }}
          >
            {enabledConfigs.length}
          </Typography>
        </Box>
      </Box>
    </Tooltip>
  );
};

export default ResearchModeIndicator;
