import { memo } from 'react';
import { ISessionDocument, IProjectDocument, ISessionFavoriteItem } from '@bike4mind/common';
import SessionSidenavItem from '@client/app/components/Session/SidenavItem';
import ProjectSidenavItem from '@client/app/components/Project/SidenavItem';
import AgentSidenavItem from '@client/app/components/Agent/SidenavItem';
import type { CombinedItem } from './types';

/**
 * Memoized list row. Defined at module level so the `memo` boundary is stable across the
 * list's renders. It encapsulates the agent/project/session branching and the per-row click
 * handlers.
 *
 * The list is built inside a `useMemo` keyed on selection/filter state, so a single selection
 * toggle or search keystroke recomputes every row element. Because every callback this row
 * receives is stable (the parent's `useCallback`s) and the rest of its props are primitives or
 * referentially-stable, `React.memo` skips re-rendering the rows whose props didn't change -
 * only the toggled/changed row re-renders, not all of them. Same unstable-identity re-render
 * problem, applied to the hot 900-line `SessionSidenavItem`.
 */
const NotebookRow = memo(function NotebookRow({
  item,
  isEditMode,
  isChecked,
  isShared,
  favoriteSessions,
  showMessageCount,
  disableExportOps,
  onNavigate,
  onNotebookClick,
  onToggle,
}: {
  item: CombinedItem;
  isEditMode: boolean;
  isChecked: boolean;
  isShared: boolean;
  favoriteSessions?: ISessionFavoriteItem[];
  showMessageCount: boolean;
  disableExportOps: boolean;
  onNavigate: (path: string) => void;
  onNotebookClick: (session: ISessionDocument) => void;
  onToggle: (id: string) => void;
}) {
  if ('isAgent' in item && item.isAgent) {
    // any: CombinedItem's agent variant is structurally looser than AgentSidenavItem's prop
    return <AgentSidenavItem agent={item as any} onClick={() => onNavigate(`/agents/${item.id}`)} />;
  }
  if ('isProject' in item && item.isProject) {
    // any: CombinedItem's project variant is structurally looser than IProjectDocument
    return (
      <ProjectSidenavItem
        project={item as any as IProjectDocument}
        onClick={() => onNavigate(`/projects/${item.id}`)}
      />
    );
  }
  return (
    <SessionSidenavItem
      session={item as ISessionDocument}
      onClick={() => onNotebookClick(item as ISessionDocument)}
      favoriteSessions={favoriteSessions}
      isEditMode={isEditMode}
      isChecked={isChecked}
      onToggleSelection={() => onToggle(item.id)}
      isShared={isShared}
      showMessageCount={showMessageCount}
      disableExportOps={disableExportOps}
    />
  );
});

export default NotebookRow;
