import type { ReactNode } from 'react';
import { Box, Button, Stack } from '@mui/joy';
import { adminFocus, adminFocusScope } from './adminStyles';

export type ViewTab = { id: string; label: string; count?: number };

/** Saved-view tabs: 34 px, the active one ink-filled, each with an optional count pill. */
export function ViewTabs({
  views,
  activeId,
  onSelect,
  trailing,
  'aria-label': ariaLabel = 'Saved views',
  'data-testid': testId = 'admin-view-tabs',
}: {
  views: readonly ViewTab[];
  activeId: string | undefined;
  onSelect: (id: string) => void;
  /** After the tabs, e.g. a "Save view" button. */
  trailing?: ReactNode;
  'aria-label'?: string;
  'data-testid'?: string;
}) {
  return (
    <Stack
      direction="row"
      gap={0.5}
      role="group"
      aria-label={ariaLabel}
      data-testid={testId}
      sx={{ ...adminFocusScope, overflowX: 'auto', flexWrap: 'nowrap', pb: 0.25 }}
    >
      {views.map(view => {
        const active = view.id === activeId;
        return (
          <Button
            key={view.id}
            size="sm"
            variant="plain"
            aria-pressed={active}
            data-testid={`${testId}-${view.id}-btn`}
            onClick={() => onSelect(view.id)}
            endDecorator={
              view.count === undefined ? undefined : (
                <Box
                  component="span"
                  data-testid={`${testId}-${view.id}-count`}
                  sx={{
                    fontSize: 11,
                    fontWeight: 600,
                    fontVariantNumeric: 'tabular-nums',
                    lineHeight: '18px',
                    px: 0.75,
                    borderRadius: '999px',
                    bgcolor: active ? 'rgba(255, 255, 255, 0.18)' : 'admin.hover',
                    color: 'inherit',
                  }}
                >
                  {view.count.toLocaleString()}
                </Box>
              )
            }
            sx={{
              ...adminFocus,
              flexShrink: 0,
              minHeight: 34,
              height: 34,
              px: 1.5,
              borderRadius: '8px',
              fontSize: 13,
              fontWeight: 500,
              color: 'admin.inkSecondary',
              bgcolor: 'transparent',
              '&:hover': { bgcolor: 'admin.hover' },
              // Joy styles aria-pressed buttons with its own active variant; outrank it.
              '&&[aria-pressed="true"]': { color: 'admin.surface', bgcolor: 'admin.ink' },
            }}
          >
            {view.label}
          </Button>
        );
      })}
      {trailing}
    </Stack>
  );
}
