import Box from '@mui/joy/Box';
import IconButton from '@mui/joy/IconButton';
import Stack from '@mui/joy/Stack';
import Typography from '@mui/joy/Typography';
import { MAX_BROWSER_TABS } from '@shared/browserTabs';
import type { BrowserTabSummary } from '@shared/ipc';
import { CloseIcon, PlusIcon } from './icons';

/** What a tab with no title yet is called: a host while it loads, "New tab" before it has been anywhere. */
export function browserTabLabel(tab: BrowserTabSummary): string {
  if (tab.title) return tab.title;
  if (!tab.url) return 'New tab';
  try {
    return new URL(tab.url).host || tab.url;
  } catch {
    return tab.url;
  }
}

/**
 * The tabs of a conversation's browser, above its url bar.
 *
 * A dot rather than a favicon: the renderer's CSP allows no remote images, and fetching icons
 * through main would be a request per tab per page for a few pixels. The dot turns to the
 * primary colour while its tab loads, which is the part of a favicon that carries information.
 *
 * Tooltips are the native `title`, not Joy's: a Joy tooltip is a portal over the page's
 * rectangle, which the pane answers by taking the page off screen for as long as it shows.
 */
export function BrowserTabStrip({
  tabs,
  activeTabId,
  onSelect,
  onClose,
  onNew,
}: {
  tabs: readonly BrowserTabSummary[];
  activeTabId: number | null;
  onSelect: (id: number) => void;
  onClose: (id: number) => void;
  onNew: () => void;
}) {
  return (
    <Stack
      direction="row"
      alignItems="flex-end"
      spacing={0.25}
      role="tablist"
      aria-label="Browser tabs"
      sx={{ flexShrink: 0, px: 0.75, pt: 0.5, minWidth: 0 }}
      data-testid="browser-tab-strip"
    >
      <Stack
        direction="row"
        spacing={0.25}
        sx={{ minWidth: 0, overflowX: 'auto', scrollbarWidth: 'none', '&::-webkit-scrollbar': { display: 'none' } }}
      >
        {tabs.map(tab => {
          const active = tab.id === activeTabId;
          const label = browserTabLabel(tab);
          return (
            <Box
              key={tab.id}
              role="tab"
              aria-selected={active}
              tabIndex={active ? 0 : -1}
              title={tab.url && tab.url !== label ? `${label}\n${tab.url}` : label}
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
              data-testid="browser-tab-select-btn"
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
                  bgcolor: tab.loading ? 'primary.solidBg' : active ? 'neutral.solidBg' : 'neutral.outlinedBorder',
                }}
              />
              <Typography level="body-xs" noWrap textColor="inherit" sx={{ flex: 1, minWidth: 0 }}>
                {label}
              </Typography>
              <IconButton
                size="sm"
                variant="plain"
                color="neutral"
                aria-label={`Close ${label}`}
                tabIndex={-1}
                onClick={event => {
                  event.stopPropagation();
                  onClose(tab.id);
                }}
                data-testid="browser-tab-close-btn"
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
        title={tabs.length >= MAX_BROWSER_TABS ? `At most ${MAX_BROWSER_TABS} tabs` : 'New tab'}
        disabled={tabs.length >= MAX_BROWSER_TABS}
        onClick={onNew}
        data-testid="browser-tab-new-btn"
        sx={{ '--IconButton-size': '26px', minWidth: 26, minHeight: 26, mb: '1px', flexShrink: 0 }}
      >
        <PlusIcon />
      </IconButton>
    </Stack>
  );
}
