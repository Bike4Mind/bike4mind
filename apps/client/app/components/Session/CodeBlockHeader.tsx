import React from 'react';
import { Box, Typography } from '@mui/joy';
import { CopyCodeButton } from './CopyCodeButton';

export { CODE_SURFACE_STYLE } from '../common/HighlightedCode';

/**
 * A fenced code block: a framed panel whose header carries the language on the left and the
 * copy control on the right, with the highlighted code beneath.
 *
 * The frame would otherwise be drawn by the `pre` itself (markdown/syntaxTheme.ts paints a
 * border, radius and brand veil there); CODE_SURFACE_STYLE clears it so the frame is drawn
 * once, here, with the header INSIDE it rather than floating above it.
 *
 * Only a standalone fence gets this. Code inside an artifact card or a viewer Code tab
 * renders as a bare HighlightedCode, because it already sits in a frame with a title and
 * actions of its own.
 *
 * Shared so a reply block and a prompt block cannot drift apart.
 */
export const CodeBlockHeader: React.FC<{ code: string; language?: string; children: React.ReactNode }> = ({
  code,
  language,
  children,
}) => {
  // 'text'/'plain' is the fallback for a fence with no language, and announcing "plain"
  // tells a reader nothing.
  const label = language && language !== 'text' && language !== 'plain' ? language : null;

  return (
    <Box
      className="code-block"
      sx={{
        my: '0.5em',
        // One source of inset for the whole panel: the header and the code body carry none
        // of their own, so nothing can drift out of alignment with the frame.
        p: '16px',
        borderRadius: '8px',
        overflow: 'hidden',
        border: '1px solid',
        borderColor: 'var(--joy-palette-reading-cardLine, rgba(59, 130, 246, 0.18))',
        background:
          'linear-gradient(180deg, var(--joy-palette-reading-cardTintTop, rgba(59, 130, 246, 0.05)),' +
          ' var(--joy-palette-reading-cardTintBottom, rgba(59, 130, 246, 0.02))),' +
          ' var(--joy-palette-reading-cardBase)',
      }}
    >
      <Box
        className="code-block-header"
        sx={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: '8px',
          minHeight: '24px',
          mb: '12px',
        }}
      >
        <Typography level="body-xs" sx={{ color: 'text.tertiary', fontFamily: 'monospace' }}>
          {label}
        </Typography>
        <CopyCodeButton code={code} language={language} />
      </Box>
      {children}
    </Box>
  );
};

export default CodeBlockHeader;
