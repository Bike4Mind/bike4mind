import { adminFocusScope } from './adminStyles';
import { Button, Stack } from '@mui/joy';
import type { AdminListState } from './useAdminListUrlState';

export type AdminSavedView = { id: string; label: string; query?: string; filters: Record<string, string> };
export function SavedViews({
  views,
  state,
  onChange,
}: {
  views: readonly AdminSavedView[];
  state: AdminListState;
  onChange: (patch: Partial<AdminListState>) => void;
}) {
  return (
    <Stack
      sx={adminFocusScope}
      direction="row"
      flexWrap="wrap"
      gap={1}
      role="group"
      aria-label="Saved views"
      data-testid="admin-saved-views"
    >
      {views.map(view => (
        <Button
          key={view.id}
          size="sm"
          variant={state.view === view.id ? 'solid' : 'plain'}
          aria-pressed={state.view === view.id}
          data-testid={`admin-saved-view-${view.id}-btn`}
          onClick={() => onChange({ view: view.id, query: view.query ?? '', filters: view.filters })}
        >
          {view.label}
        </Button>
      ))}
    </Stack>
  );
}
