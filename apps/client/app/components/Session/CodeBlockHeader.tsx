import React from 'react';
import { Box, Typography } from '@mui/joy';
import { CopyCodeButton } from './CopyCodeButton';

/**
 * A fenced code block: a framed panel whose header carries the language on the left and the
 * copy control on the right, with the highlighted code beneath.
 *
 * The frame normally lives on the `pre` itself (markdown/syntaxTheme.ts paints the border,
 * radius and brand veil there). It moves here so the header sits INSIDE the panel rather
 * than floating above it - pass `CODE_BLOCK_INNER_STYLE` to the highlighter so the `pre`
 * gives up the frame it would otherwise draw a second time.
 *
 * Shared so a reply block and a prompt block cannot drift apart.
 */

/**
 * The block renders through a real `pre` (`PreTag="pre"`), not a div: observatory.css skins
 * INLINE code via `:not(pre) > code`, adding a border and padding, and as a div that skin
 * matched here and drew a thin outline around every line of every code block.
 *
 * The code tag keeps the rest of `syntaxTheme` untouched - including the reading mono face.
 * Its own fill is the same `reading.surface` this panel carries, so it cannot be seen; an
 * earlier attempt to clear it replaced the theme's code styles wholesale and took the font
 * with them.
 */
export const CODE_BLOCK_INNER_STYLE = {
  margin: 0,
  border: 'none',
  borderRadius: '6px',
  background: 'var(--joy-palette-reading-surface, #13181C)',
  padding: '12px',
} as const;

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
          ' var(--joy-palette-background-surface2)',
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
