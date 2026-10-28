import { ViewTabs } from './ViewTabs';
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
    <ViewTabs
      views={views}
      activeId={state.view}
      data-testid="admin-saved-view"
      onSelect={id => {
        const view = views.find(candidate => candidate.id === id);
        if (view) onChange({ view: view.id, query: view.query ?? '', filters: view.filters });
      }}
    />
  );
}
