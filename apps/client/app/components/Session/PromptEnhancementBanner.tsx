import React, { useState } from 'react';
import { Box, Typography, Chip, IconButton, Tooltip } from '@mui/joy';
import { AutoFixHigh, ExpandMore, ExpandLess, ChatBubbleOutline } from '@mui/icons-material';
import type { PromptIntent } from '@bike4mind/common';

interface PromptEnhancementBannerProps {
  originalPrompt: string;
  enhancedPrompt: string;
  promptWasEnhanced: boolean;
  /** Resolver intent. 'continuation' = bound to prior context; 'fresh' = self-contained, optionally elaborated via the prompt_enhancement tool. */
  intent?: PromptIntent;
}

const PromptEnhancementBanner: React.FC<PromptEnhancementBannerProps> = ({
  originalPrompt,
  enhancedPrompt,
  promptWasEnhanced,
  intent,
}) => {
  const [showDetails, setShowDetails] = useState(false);

  if (!promptWasEnhanced) {
    return null;
  }

  // Continuations are framed as "context applied", not "enhanced": the resolver's rewrite is
  // non-optional (bound to prior context), so this reads as confirmation rather than overwriting
  // the user's voice. Fresh prompts opted into elaboration via the tool toggle.
  const isContinuation = intent === 'continuation';
  const Icon = isContinuation ? ChatBubbleOutline : AutoFixHigh;
  const headerCopy = isContinuation
    ? 'Used this conversation to resolve the request for the image model.'
    : 'Your prompt was enhanced for better image generation. You can toggle this on/off in tools.';
  const chipLabel = isContinuation ? 'Context applied' : 'Enhanced';
  const detailHeading = isContinuation
    ? 'Resolved Prompt Used for Generation:'
    : 'Enhanced Prompt Used for Generation:';

  return (
    <Box
      data-testid="prompt-enhancement-banner"
      data-intent={intent}
      sx={{
        mb: 2,
        border: '1px solid',
        borderColor: 'promptEnhancement.border',
        borderRadius: 'md',
        bgcolor: 'promptEnhancement.background',
        overflow: 'hidden',
      }}
    >
      {/* Header */}
      <Box
        data-testid="prompt-enhancement-toggle"
        sx={{
          p: 2,
          display: 'flex',
          alignItems: 'center',
          gap: 1,
          cursor: 'pointer',
          '&:hover': {
            bgcolor: 'promptEnhancement.backgroundHover',
          },
        }}
        onClick={() => setShowDetails(!showDetails)}
      >
        <Icon sx={{ color: 'promptEnhancement.iconColor', fontSize: 18 }} />
        <Typography
          level="body-sm"
          sx={{
            flex: 1,
            fontWeight: 'medium',
            color: 'promptEnhancement.textColor',
          }}
        >
          {headerCopy}
        </Typography>
        <Chip
          variant="soft"
          size="sm"
          data-testid="prompt-enhancement-chip"
          sx={{
            bgcolor: 'promptEnhancement.chipBackground',
            color: 'promptEnhancement.chipColor',
            border: '1px solid',
            borderColor: 'promptEnhancement.chipBorder',
          }}
        >
          {chipLabel}
        </Chip>
        <Tooltip title={showDetails ? 'Hide details' : 'Show details'}>
          <IconButton size="sm" variant="plain" color="primary">
            {showDetails ? <ExpandLess /> : <ExpandMore />}
          </IconButton>
        </Tooltip>
      </Box>

      {/* Details */}
      {showDetails && (
        <Box sx={{ px: 2, pb: 2 }}>
          <Box sx={{ mb: 2 }}>
            <Typography level="body-xs" sx={{ mb: 1, fontWeight: 'bold', color: 'text.secondary' }}>
              Your Original Prompt:
            </Typography>
            <Box
              sx={{
                p: 2,
                bgcolor: 'background.level1',
                borderRadius: 'sm',
                border: '1px solid',
                borderColor: 'divider',
              }}
            >
              <Typography level="body-sm" data-testid="prompt-enhancement-original" sx={{ whiteSpace: 'pre-wrap' }}>
                {originalPrompt}
              </Typography>
            </Box>
          </Box>

          <Box>
            <Typography level="body-xs" sx={{ mb: 1, fontWeight: 'bold', color: 'text.secondary' }}>
              {detailHeading}
            </Typography>
            <Box
              sx={{
                p: 2,
                bgcolor: 'promptEnhancement.enhancedPromptBackground',
                borderRadius: 'sm',
                border: '1px solid',
                borderColor: 'promptEnhancement.enhancedPromptBorder',
              }}
            >
              <Typography level="body-sm" data-testid="prompt-enhancement-enhanced" sx={{ whiteSpace: 'pre-wrap' }}>
                {enhancedPrompt}
              </Typography>
            </Box>
          </Box>
        </Box>
      )}
    </Box>
  );
};

export default PromptEnhancementBanner;
