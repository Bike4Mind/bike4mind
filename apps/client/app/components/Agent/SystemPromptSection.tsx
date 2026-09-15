import React from 'react';
import { Card, Typography, FormControl, IconButton, Box, Textarea, Tooltip } from '@mui/joy';
import DownloadIcon from '@mui/icons-material/Download';
import ShimmerWrapper from '../ShimmerWrapper';
import AutoAwesomeIconButton from './AutoAwesomeIconButton';

interface SystemPromptSectionProps {
  systemPrompt: string;
  shimmeringField: string | null;
  isDownloadingSystemPrompt: boolean;
  isGeneratingSystemPrompt?: boolean;
  onSystemPromptChange: (value: string) => void;
  onGenerateSystemPrompt: () => void;
  onDownloadSystemPrompt: () => void;
  readOnly?: boolean;
}

const SystemPromptSection: React.FC<SystemPromptSectionProps> = ({
  systemPrompt,
  shimmeringField,
  isDownloadingSystemPrompt,
  isGeneratingSystemPrompt = false,
  onSystemPromptChange,
  onGenerateSystemPrompt,
  onDownloadSystemPrompt,
  readOnly = false,
}) => {
  return (
    <Card
      variant="outlined"
      sx={{
        backgroundColor: theme => theme.palette.background.body,
        border: '1px solid',
        borderColor: 'divider',
        borderRadius: '8px',
        p: 2,
        gap: 0,
        height: '100%',
      }}
    >
      <Box sx={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 1, mb: 1 }}>
        <Box sx={{ display: 'flex', flexDirection: 'column', gap: 0 }}>
          <Typography level="title-md">System Prompt</Typography>
        </Box>
        <Box sx={{ display: 'flex', gap: 1, alignItems: 'center' }}>
          <Tooltip title="Download system prompt" placement="top">
            <IconButton
              size="sm"
              sx={{
                width: '24px',
                height: '24px',
                minWidth: '24px',
                minHeight: '24px',
              }}
              onClick={onDownloadSystemPrompt}
              disabled={!systemPrompt || isDownloadingSystemPrompt}
              loading={isDownloadingSystemPrompt}
              color="neutral"
              variant="outlined"
            >
              <DownloadIcon sx={{ fontSize: '14px' }} />
            </IconButton>
          </Tooltip>
          <AutoAwesomeIconButton
            tooltip="Generate system prompt"
            onClick={readOnly ? undefined : () => onGenerateSystemPrompt()}
            disabled={readOnly || isGeneratingSystemPrompt}
            loading={isGeneratingSystemPrompt}
          />
        </Box>
      </Box>

      <FormControl sx={{ mt: 0 }} size="sm">
        <ShimmerWrapper isShimmering={shimmeringField === 'systemPrompt'} fieldName="systemPrompt">
          <Textarea
            data-testid="agent-form-system-prompt"
            size="sm"
            sx={{
              border: '1px solid',
              borderColor: 'divider',
              backgroundColor: 'background.panel',
              color: 'text.primary',
              boxShadow: 'none',
              fontFamily: 'code',
              fontSize: '14px',
              '&::placeholder': { color: 'text.secondary' },
            }}
            minRows={12}
            maxRows={24}
            value={systemPrompt}
            onChange={e => onSystemPromptChange(e.target.value)}
            placeholder="Tell the agent who it is, what it can do, and how it should respond."
            readOnly={readOnly}
          />
        </ShimmerWrapper>
      </FormControl>
    </Card>
  );
};

export default SystemPromptSection;
