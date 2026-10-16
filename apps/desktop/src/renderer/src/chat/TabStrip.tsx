import Box from '@mui/joy/Box';
import IconButton from '@mui/joy/IconButton';
import Stack from '@mui/joy/Stack';
import Typography from '@mui/joy/Typography';
import type { ReactNode } from 'react';
import { CloseIcon, PlusIcon } from './icons';
import { hiddenScrollbarSx } from './layout';

export interface StripTab<Id extends string | number> {
  id: Id;
  label: string;
  /** The native tooltip. */
  title: string;
  /** Turns the tab's dot to the primary colour. */
  busy?: boolean;
  /** Dims the dot, for a tab whose content has ended. */
  ended?: boolean;
}

/**
 * A row of closable tabs with a "new" button, shared by the browser pane and the terminal panel.
 *
 * Tooltips are the native `title`, not Joy's: a Joy tooltip is a portal over the browser page's
 * rectangle, which the pane answers by taking the page off screen for as long as it shows.
 * `testIdPrefix` names every control `<prefix>-tab-...`.
 */
export function TabStrip<Id extends string | number>({
  tabs,
  activeId,
  ariaLabel,
  testIdPrefix,
  newDisabledTitle,
  onSelect,
  onClose,
  onNew,
  trailing,
}: {
  tabs: readonly StripTab<Id>[];
  activeId: Id | null;
  ariaLabel: string;
  testIdPrefix: string;
  /** Set when no more tabs may be opened; becomes the disabled button's tooltip. */
  newDisabledTitle?: string;
  onSelect: (id: Id) => void;
  onClose: (id: Id) => void;
  onNew: () => void;
  trailing?: ReactNode;
}) {
  return (
    <Stack
      direction="row"
      alignItems="flex-end"
      spacing={0.25}
      role="tablist"
      aria-label={ariaLabel}
      sx={{ flexShrink: 0, px: 0.75, pt: 0.5, minWidth: 0 }}
      data-testid={`${testIdPrefix}-tab-strip`}
    >
      <Stack direction="row" spacing={0.25} sx={{ minWidth: 0, overflowX: 'auto', ...hiddenScrollbarSx }}>
        {tabs.map(tab => {
          const active = tab.id === activeId;
          return (
            <Box
              key={tab.id}
              role="tab"
              aria-selected={active}
              tabIndex={active ? 0 : -1}
              title={tab.title}
              onClick={() => onSelect(tab.id)}
              onKeyDown={event => {
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault();
                  onSelect(tab.id);
                }
              }}
              // Middle-click closes, as in every browser. The press is swallowed so it does not
              // start the platform's autoscroll first.
              onMouseDown={event => {
                if (event.button === 1) event.preventDefault();
              }}
              onAuxClick={event => {
                if (event.button === 1) onClose(tab.id);
              }}
              data-testid={`${testIdPrefix}-tab-select-btn`}
              data-tab-id={tab.id}
              sx={{
                display: 'flex',
                alignItems: 'center',
                gap: 0.75,
                flex: '0 1 180px',
                minWidth: 72,
                height: 28,
                pl: 1,
                pr: 0.25,
                borderTopLeftRadius: 'var(--joy-radius-sm)',
                borderTopRightRadius: 'var(--joy-radius-sm)',
                border: '1px solid',
                borderBottom: 'none',
                borderColor: active ? 'divider' : 'transparent',
                bgcolor: active ? 'background.surface' : 'transparent',
                color: active ? 'text.primary' : 'text.tertiary',
                cursor: 'default',
                userSelect: 'none',
                outline: 'none',
                '&:hover': active ? undefined : { bgcolor: 'background.level2', color: 'text.secondary' },
                '&:focus-visible': { boxShadow: 'inset 0 0 0 2px var(--joy-palette-focusVisible)' },
              }}
            >
              <Box
                aria-hidden
                sx={{
                  width: 6,
                  height: 6,
                  borderRadius: '50%',
                  flexShrink: 0,
                  bgcolor: tab.busy
                    ? 'primary.solidBg'
                    : tab.ended
                      ? 'transparent'
                      : active
                        ? 'neutral.solidBg'
                        : 'neutral.outlinedBorder',
                  border: tab.ended ? '1px solid' : 'none',
                  borderColor: 'neutral.outlinedBorder',
                }}
              />
              <Typography level="body-xs" noWrap textColor="inherit" sx={{ flex: 1, minWidth: 0 }}>
                {tab.label}
              </Typography>
              <IconButton
                size="sm"
                variant="plain"
                color="neutral"
                aria-label={`Close ${tab.label}`}
                tabIndex={-1}
                onClick={event => {
                  event.stopPropagation();
                  onClose(tab.id);
                }}
                data-testid={`${testIdPrefix}-tab-close-btn`}
                sx={{
                  '--IconButton-size': '20px',
                  minWidth: 20,
                  minHeight: 20,
                  flexShrink: 0,
                  '& svg': { width: 12, height: 12 },
                }}
              >
                <CloseIcon />
              </IconButton>
            </Box>
          );
        })}
      </Stack>
      <IconButton
        size="sm"
        variant="plain"
        color="neutral"
        aria-label="New tab"
        title={newDisabledTitle ?? 'New tab'}
        disabled={!!newDisabledTitle}
        onClick={onNew}
        data-testid={`${testIdPrefix}-tab-new-btn`}
        sx={{ '--IconButton-size': '26px', minWidth: 26, minHeight: 26, mb: '1px', flexShrink: 0 }}
      >
        <PlusIcon />
      </IconButton>
      {trailing && (
        <Stack direction="row" spacing={0.25} alignItems="center" sx={{ '&&': { ml: 'auto' }, pl: 1, mb: '1px' }}>
          {trailing}
        </Stack>
      )}
    </Stack>
  );
}
