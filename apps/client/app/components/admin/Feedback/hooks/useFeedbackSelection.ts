import { useState } from 'react';
import type { AdminSelection } from '../../shared/BulkActionBar';

export function useFeedbackSelection({ pageIds, scopeKey }: { pageIds: string[]; scopeKey: string; total: number }) {
  const [state, setState] = useState<{ key: string; selection: AdminSelection }>({
    key: scopeKey,
    selection: { mode: 'explicit', ids: [] },
  });
  const selection: AdminSelection = state.key === scopeKey ? state.selection : { mode: 'explicit', ids: [] };
  if (state.key !== scopeKey) setState({ key: scopeKey, selection });
  const setSelection = (next: AdminSelection) => setState({ key: scopeKey, selection: next });
  const clear = () => setSelection({ mode: 'explicit', ids: [] });
  const toggle = (id: string) => {
    const ids = new Set(selection.mode === 'allMatching' ? pageIds : selection.ids);
    if (ids.has(id)) ids.delete(id);
    else ids.add(id);
    setSelection({ mode: 'explicit', ids: [...ids] });
  };
  return { selection, setSelection, clear, toggle };
}
