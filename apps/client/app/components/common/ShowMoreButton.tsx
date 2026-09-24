import React from 'react';
import { Typography } from '@mui/joy';
import { ExpandMoreOutlined as ExpandMoreIcon, ExpandLessOutlined as ExpandLessIcon } from '@mui/icons-material';

/**
 * The control under a bounded artifact body that reveals the rest of it.
 *
 * One component because it appears on three surfaces - the code card, an HTML preview and
 * the source body every non-rendering artifact falls back to - and they are meant to be the
 * same control. It replaced the fold chevron, which hid the whole card behind an unlabelled
 * icon whether or not there was anything more to see.
 */
export interface ShowMoreButtonProps {
  expanded: boolean;
  onToggle: () => void;
  /** Shown when collapsed; defaults to "Show more". A count reads better where we have one. */
  collapsedLabel?: string;
  testId?: string;
}

export function ShowMoreButton({ expanded, onToggle, collapsedLabel = 'Show more', testId }: ShowMoreButtonProps) {
  return (
    <Typography
      component="button"
      type="button"
      level="body-sm"
      aria-expanded={expanded}
      data-testid={testId}
      endDecorator={expanded ? <ExpandLessIcon sx={{ fontSize: 16 }} /> : <ExpandMoreIcon sx={{ fontSize: 16 }} />}
      onClick={e => {
        e.stopPropagation();
        onToggle();
      }}
      sx={{
        mt: '16px',
        p: 0,
        border: 'none',
        background: 'none',
        cursor: 'pointer',
        display: 'flex',
        alignItems: 'center',
        mx: 'auto',
        color: 'text.primary',
        fontWeight: 500,
        gap: '2px',
        // Joy icons read --Icon-color, so the chevron does not follow `color` on its own -
        // it has to be named here or it stays the default grey.
        '&:hover': { textDecoration: 'underline', '--Icon-color': 'var(--joy-palette-text-primary)' },
      }}
    >
      {expanded ? 'Show less' : collapsedLabel}
    </Typography>
  );
}

export default ShowMoreButton;
