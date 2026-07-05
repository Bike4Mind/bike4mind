import React, { useState, memo } from 'react';
import {
  Modal,
  ModalDialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  Button,
  Stack,
  Typography,
  Alert,
  FormControl,
  FormLabel,
  Textarea,
  Radio,
  RadioGroup,
  Box,
} from '@mui/joy';
import { AutoAwesome, Article, Close as CloseIcon } from '@mui/icons-material';
import { toast } from 'sonner';
import { useChatInput } from '@client/app/hooks/useChatInput';

interface ContentPublishingModalProps {
  open: boolean;
  onClose: () => void;
}

type OutputFormat = 'blog' | 'linkedin' | 'twitter' | 'newsletter';

const VOICE_GUIDE_PLACEHOLDER = `Paste your writing style guide here, or leave empty to use default style.

Example guidelines:
- Ruthless concision
- No superlatives unless backed by data
- Dry clarity over poetry
- Technical precision
- First-person perspective`;

const ContentPublishingModal: React.FC<ContentPublishingModalProps> = ({ open, onClose }) => {
  const { setChatInputValue } = useChatInput();
  const [voiceGuide, setVoiceGuide] = useState<string>('');
  const [additionalInstructions, setAdditionalInstructions] = useState<string>('');
  const [outputFormat, setOutputFormat] = useState<OutputFormat>('blog');

  const handleTransform = () => {
    let prompt = `Transform this conversation into a ${outputFormat} post.`;

    if (voiceGuide.trim()) {
      prompt += `\n\nApply this writing style guide:\n${voiceGuide.trim()}`;
    }

    if (additionalInstructions.trim()) {
      prompt += `\n\nAdditional instructions: ${additionalInstructions.trim()}`;
    }

    setChatInputValue(prompt);

    toast.success('Transformation prompt ready! Click Send to generate your content.', {
      duration: 5000,
    });

    handleClose();
  };

  const handleClose = () => {
    setVoiceGuide('');
    setAdditionalInstructions('');
    setOutputFormat('blog');
    onClose();
  };

  return (
    <Modal open={open} onClose={handleClose}>
      <ModalDialog size="md" sx={{ width: 650, maxWidth: '90vw' }}>
        <DialogTitle>
          <AutoAwesome sx={{ mr: 1 }} />
          Content Publishing Studio
        </DialogTitle>

        <DialogContent sx={{ overflow: 'auto', maxHeight: '70vh' }}>
          <Stack spacing={3}>
            <Alert color="primary" variant="soft">
              <Typography level="body-sm">
                Transform your conversation into polished content with AI-powered voice and style guidance.
              </Typography>
            </Alert>

            {/* Output Format Selection */}
            <FormControl>
              <FormLabel>Output Format</FormLabel>
              <RadioGroup value={outputFormat} onChange={e => setOutputFormat(e.target.value as OutputFormat)}>
                <Box
                  onClick={() => setOutputFormat('blog')}
                  sx={{
                    p: 2,
                    borderRadius: 'sm',
                    border: '1px solid',
                    borderColor: outputFormat === 'blog' ? 'primary.500' : 'neutral.outlinedBorder',
                    cursor: 'pointer',
                    transition: 'all 0.2s ease',
                    '&:hover': {
                      borderColor: outputFormat === 'blog' ? 'primary.600' : 'neutral.outlinedHoverBorder',
                    },
                  }}
                >
                  <Stack direction="row" spacing={1} alignItems="center">
                    <Radio
                      value="blog"
                      data-testid="output-format-blog"
                      sx={{
                        '--Radio-size': '20px',
                        pointerEvents: 'none',
                      }}
                    />
                    <Article fontSize="small" />
                    <Typography level="title-sm">Blog Post</Typography>
                  </Stack>
                  <Typography level="body-xs" sx={{ mt: 1, ml: '28px' }}>
                    Well-structured markdown blog post with headings, formatting, and SEO optimization.
                  </Typography>
                </Box>

                {/* Coming Soon Formats */}
                <Box
                  sx={{
                    p: 2,
                    borderRadius: 'sm',
                    border: '1px solid',
                    borderColor: 'neutral.outlinedBorder',
                    opacity: 0.5,
                    cursor: 'not-allowed',
                  }}
                >
                  <Stack direction="row" spacing={1} alignItems="center">
                    <Radio value="linkedin" disabled sx={{ '--Radio-size': '20px' }} />
                    <Typography level="title-sm">LinkedIn Post</Typography>
                    <Typography level="body-xs" sx={{ color: 'text.tertiary' }}>
                      (Coming Soon)
                    </Typography>
                  </Stack>
                </Box>

                <Box
                  sx={{
                    p: 2,
                    borderRadius: 'sm',
                    border: '1px solid',
                    borderColor: 'neutral.outlinedBorder',
                    opacity: 0.5,
                    cursor: 'not-allowed',
                  }}
                >
                  <Stack direction="row" spacing={1} alignItems="center">
                    <Radio value="twitter" disabled sx={{ '--Radio-size': '20px' }} />
                    <Typography level="title-sm">Twitter Thread</Typography>
                    <Typography level="body-xs" sx={{ color: 'text.tertiary' }}>
                      (Coming Soon)
                    </Typography>
                  </Stack>
                </Box>

                <Box
                  sx={{
                    p: 2,
                    borderRadius: 'sm',
                    border: '1px solid',
                    borderColor: 'neutral.outlinedBorder',
                    opacity: 0.5,
                    cursor: 'not-allowed',
                  }}
                >
                  <Stack direction="row" spacing={1} alignItems="center">
                    <Radio value="newsletter" disabled sx={{ '--Radio-size': '20px' }} />
                    <Typography level="title-sm">Newsletter</Typography>
                    <Typography level="body-xs" sx={{ color: 'text.tertiary' }}>
                      (Coming Soon)
                    </Typography>
                  </Stack>
                </Box>
              </RadioGroup>
            </FormControl>

            {/* Voice Guide */}
            <FormControl>
              <FormLabel>Writing Style Guide (Optional)</FormLabel>
              <Textarea
                placeholder={VOICE_GUIDE_PLACEHOLDER}
                value={voiceGuide}
                onChange={e => setVoiceGuide(e.target.value)}
                minRows={6}
                maxRows={12}
                data-testid="voice-guide-input"
                sx={{ fontFamily: 'monospace', fontSize: '0.875rem' }}
              />
              <Typography level="body-xs" sx={{ mt: 1, color: 'text.tertiary' }}>
                Paste your writing style guide or voice guidelines. The AI will apply these rules when transforming your
                content.
              </Typography>
            </FormControl>

            {/* Additional Instructions */}
            <FormControl>
              <FormLabel>Additional Instructions (Optional)</FormLabel>
              <Textarea
                placeholder="Make it more technical, add code examples, focus on business impact, etc."
                value={additionalInstructions}
                onChange={e => setAdditionalInstructions(e.target.value)}
                minRows={3}
                maxRows={6}
                data-testid="additional-instructions-input"
              />
              <Typography level="body-xs" sx={{ mt: 1, color: 'text.tertiary' }}>
                Provide specific guidance for this transformation (e.g., &quot;Make it more technical&quot;, &quot;Add
                code examples&quot;).
              </Typography>
            </FormControl>

            {/* Coming Soon: FabFile Selection */}
            <Alert color="neutral" variant="soft" size="sm">
              <Typography level="body-xs">
                <strong>Coming Soon:</strong> Select voice guides from your FabFiles library for quick reuse.
              </Typography>
            </Alert>
          </Stack>
        </DialogContent>

        <DialogActions>
          <Button variant="plain" color="neutral" onClick={handleClose} startDecorator={<CloseIcon />}>
            Cancel
          </Button>
          <Button
            variant="solid"
            color="primary"
            onClick={handleTransform}
            startDecorator={<AutoAwesome />}
            disabled={outputFormat !== 'blog'}
            data-testid="transform-content-btn"
          >
            Transform Content
          </Button>
        </DialogActions>
      </ModalDialog>
    </Modal>
  );
};

export default memo(ContentPublishingModal);
