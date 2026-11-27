import type { ReactNode } from 'react';
import Box from '@mui/joy/Box';
import Button from '@mui/joy/Button';
import Chip from '@mui/joy/Chip';
import Sheet from '@mui/joy/Sheet';
import Stack from '@mui/joy/Stack';
import Typography from '@mui/joy/Typography';

/**
 * One thing the user can configure about the app itself.
 *
 * Deliberately not shaped around any one screen: `summary` is whatever one line describes the
 * current state, and `attention` is whatever is wrong with it. Customize and Settings both
 * fill these same fields, and a third screen would need no change here.
 *
 * `control` is the setting itself, rendered on the screen under the label. An entry that has
 * none falls back to `onOpen` behind a button, which is what an entry whose control is a
 * window of its own - an OS permission prompt, say - still wants.
 */
export interface ConfigEntry {
  id: string;
  icon: ReactNode;
  label: string;
  /** Current state in one line, so the section answers the easy question before it is read. */
  summary: string;
  description?: string;
  /** Set only when the entry needs the user; also surfaced on its screen's nav row. */
  attention?: string;
  /**
   * How to colour that chip. Danger by default, because every entry that had one until now was
   * reporting something broken. An update is not broken - drawing "Restart" in the same red as
   * a dead MCP server would read as a fault the user has to go and fix.
   */
  attentionColor?: 'danger' | 'primary';
  control?: ReactNode;
  onOpen?: () => void;
}

export function EntrySection({ entry }: { entry: ConfigEntry }) {
  return (
    <Sheet
      variant="outlined"
      sx={{ borderRadius: 'sm', mb: 1, px: 1.5, py: 1.25 }}
      data-testid="config-section"
      data-entry={entry.id}
    >
      <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
        <Box sx={{ color: 'text.tertiary', display: 'flex' }}>{entry.icon}</Box>
        <Stack sx={{ flex: 1, minWidth: 0 }}>
          <Typography level="title-sm" noWrap>
            {entry.label}
          </Typography>
          <Typography level="body-xs" textColor="text.tertiary" noWrap data-testid="config-entry-summary">
            {entry.summary}
          </Typography>
        </Stack>
        {entry.attention && (
          <Chip size="sm" variant="soft" color={entry.attentionColor ?? 'danger'} data-testid="config-entry-attention">
            {entry.attention}
          </Chip>
        )}
        {/* An entry with no control of its own keeps the button it used to have in the list. */}
        {!entry.control && entry.onOpen && (
          <Button size="sm" variant="outlined" color="neutral" onClick={entry.onOpen} data-testid="config-entry-btn">
            Open
          </Button>
        )}
      </Stack>

      {entry.control && <Box sx={{ mt: 1.25 }}>{entry.control}</Box>}
    </Sheet>
  );
}

/**
 * The flash a deep-linked setting gets. Padded out to the side so the tint does not touch the
 * text; the fade out is skipped for reduced motion.
 */
export function settingHighlightSx(highlighted: boolean) {
  return {
    px: 1.5,
    mx: -1.5,
    transition: 'background-color 600ms ease, box-shadow 600ms ease',
    '@media (prefers-reduced-motion: reduce)': { transition: 'none' },
    ...(highlighted
      ? {
          borderRadius: 'sm',
          bgcolor: 'var(--joy-palette-primary-softBg)',
          boxShadow: 'inset 0 0 0 1px var(--joy-palette-primary-outlinedBorder)',
        }
      : {}),
  } as const;
}

export function SettingsRow({
  entry,
  expanded = false,
  highlighted = false,
  action,
}: {
  entry: ConfigEntry;
  expanded?: boolean;
  highlighted?: boolean;
  /** Beside the label, e.g. a search result's way to its page. */
  action?: ReactNode;
}) {
  const labelId = `settings-label-${entry.id}`;
  return (
    <Box
      component="section"
      aria-labelledby={labelId}
      data-testid="config-section"
      data-entry={entry.id}
      data-highlighted={highlighted ? 'true' : undefined}
      sx={{
        ...settingHighlightSx(highlighted),
        display: 'flex',
        flexDirection: expanded ? 'column' : { xs: 'column', md: 'row' },
        alignItems: expanded ? 'stretch' : { xs: 'stretch', md: 'center' },
        gap: 2.5,
        py: 2.5,
        borderBottom: '1px solid',
        borderColor: 'divider',
        '&:last-child': { borderBottom: 0 },
      }}
    >
      <Stack spacing={0.75} sx={{ flex: 1, minWidth: 0 }}>
        <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
          <Typography id={labelId} level="title-sm" sx={{ fontWeight: 500 }}>
            {entry.label}
          </Typography>
          {entry.attention && (
            <Chip
              size="sm"
              variant="soft"
              color={entry.attentionColor ?? 'danger'}
              data-testid="config-entry-attention"
            >
              {entry.attention}
            </Chip>
          )}
          {action}
        </Stack>
        <Typography level="body-sm" textColor="text.tertiary" data-testid="config-entry-summary">
          {entry.description ?? entry.summary}
        </Typography>
      </Stack>
      {entry.control && (
        <Box sx={{ flexShrink: 0, minWidth: 0, maxWidth: expanded ? '100%' : { xs: '100%', md: 300 } }}>
          {entry.control}
        </Box>
      )}
    </Box>
  );
}

/**
 * The attention chip a screen's nav row carries, built from that screen's own entries.
 *
 * Undefined rather than an empty node when nothing is wrong: the nav row hands this straight to
 * a Joy endDecorator, which reserves its gap for anything that is not absent.
 */
export function entryAttentionChip(entries: ConfigEntry[], testId: string): ReactNode {
  const flagged = entries.find(entry => entry.attention);
  if (!flagged?.attention) return undefined;

  return (
    <Chip size="sm" variant="soft" color={flagged.attentionColor ?? 'danger'} data-testid={testId}>
      {flagged.attention}
    </Chip>
  );
}
