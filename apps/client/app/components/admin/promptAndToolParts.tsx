import type { ReactNode } from 'react';
import { Box, Stack, Tooltip, Typography } from '@mui/joy';

// Small pieces the System prompts and Tools pages share (SystemPromptEditor, SystemPromptsManager,
// ToolDefinitionsTab). The admin toolkit in shared/ has no equivalents yet.

/** An empty value: a muted dash. */
export const Dash = () => (
  <Typography level="body-sm" sx={{ color: 'admin.inkMuted' }}>
    -
  </Typography>
);

/** One line that truncates with an ellipsis, the full text on hover. */
export const TruncatedText = ({ text, mono, testId }: { text: string; mono?: boolean; testId?: string }) => (
  <Tooltip title={text} placement="top-start">
    <Typography
      level="body-sm"
      noWrap
      data-testid={testId}
      sx={{ color: 'admin.ink', minWidth: 0, ...(mono && { fontFamily: 'code' }) }}
    >
      {text}
    </Typography>
  </Tooltip>
);

/** The button row under a dialog's content, the commit button last. */
export const DialogFooter = ({ children }: { children: ReactNode }) => (
  <Stack
    direction="row"
    justifyContent="flex-end"
    flexWrap="wrap"
    gap={1}
    sx={{ pt: 2, mt: 1, borderTop: '1px solid', borderColor: 'admin.border' }}
  >
    {children}
  </Stack>
);

/** A labelled value in a details dialog. */
export const Field = ({ label, children }: { label: string; children: ReactNode }) => (
  <Box>
    <Typography level="body-xs" sx={{ color: 'admin.inkMuted', mb: 0.5 }}>
      {label}
    </Typography>
    {children}
  </Box>
);
