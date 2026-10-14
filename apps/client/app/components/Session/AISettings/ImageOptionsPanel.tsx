import { ChangeEvent, FC, ReactNode } from 'react';
import { Badge, Box, Button, Input, Typography } from '@mui/joy';
import { AutoAwesome as PromptBuilderIcon, Tag as TagIcon } from '@mui/icons-material';
import { useLLM } from '@client/app/contexts/LLMContext';
import { useSessions } from '@client/app/contexts/SessionsContext';
import { useFeatureEnabled } from '@client/app/hooks/useFeatureEnabled';
import { isToolDenied } from '@client/app/utils/toolMapping';
import { ImageTemplateControls } from '../ImageTemplates/ImageTemplateControls';
import { isImageGenerationModel } from '../PromptBuilder/models';
import { usePromptBuilderFirstRun } from '../PromptBuilder/usePromptBuilderFirstRun';
import { useAdvancedAISettings } from './useAdvancedAISettingsStore';

const Row: FC<{ label: string; children: ReactNode }> = ({ label, children }) => (
  <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 1.5, minHeight: '36px' }}>
    <Typography level="body-sm" sx={{ color: 'text.primary' }}>
      {label}
    </Typography>
    {children}
  </Box>
);

/**
 * Image-model controls that used to sit in the composer row: images per prompt, the applied
 * template and cost preview, and the prompt builder. Shown from the composer's plus menu
 * (AttachFileButton) only while an image model is selected. PromptBuilderModal itself stays
 * mounted in AdvancedAISettings; this only opens it.
 */
const ImageOptionsPanel: FC<{ onOpenPromptBuilder?: () => void }> = ({ onOpenPromptBuilder }) => {
  const model = useLLM(s => s.model);
  const n = useLLM(s => s.n);
  const { setState: setLLM } = useLLM;
  const { currentSession } = useSessions();
  const { isAdminFeatureEnabled } = useFeatureEnabled();
  const isImageTemplatesEnabled = isAdminFeatureEnabled('EnableImageTemplates');
  const isPromptBuilderEnabled = isAdminFeatureEnabled('EnablePromptBuilder');
  const setPromptBuilderOpen = useAdvancedAISettings(s => s.setPromptBuilderOpen);
  const { showHint: showPromptBuilderHint, markSeen: markPromptBuilderSeen } = usePromptBuilderFirstRun();
  const showPromptBuilder =
    isPromptBuilderEnabled &&
    isImageGenerationModel(model) &&
    !isToolDenied('image_generation', currentSession?.disabledTools);

  const handleCountChange = (e: ChangeEvent<HTMLInputElement>) => {
    const next = parseInt(e.target.value, 10);
    if (!isNaN(next) && next >= 1 && next <= 4) setLLM({ n: next });
  };

  return (
    <Box data-testid="image-options-panel" sx={{ display: 'flex', flexDirection: 'column', gap: 1, p: '4px 8px' }}>
      <Typography level="body-xs" sx={{ color: 'text.tertiary' }}>
        Image options
      </Typography>
      {/* `n` reaches only the image services; more images cost proportionally more credits. */}
      <Row label="Images per prompt">
        <Input
          data-testid="image-response-count-input"
          // Joy's -3px decorator nudge pulls the icon off-centre; cancel the variable.
          startDecorator={<TagIcon sx={{ color: 'text.primary', fontSize: '18px' }} />}
          sx={{ '--Icon-margin': '0px', width: '76px', height: '32px' }}
          size="sm"
          variant="outlined"
          type="number"
          value={n ?? 1}
          onChange={handleCountChange}
          slotProps={{ input: { sx: { textAlign: 'center' }, min: 1, max: 4 } }}
        />
      </Row>
      {isImageTemplatesEnabled && (
        <Row label="Template and cost">
          <ImageTemplateControls />
        </Row>
      )}
      {showPromptBuilder && (
        <Badge
          size="sm"
          color="primary"
          variant="solid"
          badgeInset="4px"
          invisible={!showPromptBuilderHint}
          data-testid="prompt-builder-hint-badge"
          sx={{ display: 'flex' }}
        >
          <Button
            data-testid="prompt-builder-open-btn"
            variant="outlined"
            color="neutral"
            size="sm"
            fullWidth
            startDecorator={<PromptBuilderIcon sx={{ fontSize: '16px' }} />}
            onClick={() => {
              markPromptBuilderSeen();
              setPromptBuilderOpen(true);
              onOpenPromptBuilder?.();
            }}
          >
            Build an image prompt
          </Button>
        </Badge>
      )}
    </Box>
  );
};

export default ImageOptionsPanel;
