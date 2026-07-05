import { RefObject, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { useSessions } from '@client/app/contexts/SessionsContext';
import { useDeleteSessions, useDownloadSession } from '@client/app/hooks/data/sessions';
import { api } from '@client/app/contexts/ApiContext';
import type { CombinedSessionDocument } from './types';

interface UseBulkActionsArgs {
  /** All own+shared sessions, used to resolve selected ids back to session docs. */
  combinedSessions: CombinedSessionDocument[];
  /** Search-filtered favorites, used to decide favorite vs unfavorite per session. */
  filteredFavoriteSession: { id: string }[];
  /** Selectable (non-project, non-agent) items, used for select-all and the selectable count. */
  selectableSessions: { id: string }[];
  /** The filters button, used to anchor the fixed-position flyout. */
  filtersAnchorRef: RefObject<HTMLDivElement | null>;
  /** The scroll container, so outside-click keeps the sidebar interactive while the panel is open. */
  sidenavRef: RefObject<HTMLDivElement | null>;
  /** Close the filters popover when the bulk-actions panel opens. */
  closeFilters: () => void;
}

/**
 * Bulk-actions state machine for the sidebar, extracted from CombinedNotebooks.
 *
 * Owns the selection set, edit mode, and the bulk-actions flyout (open state, viewport
 * position, outside-click/resize handling) plus the batch operations (select-all,
 * favorite, download, delete). The parent supplies the derived lists it can't compute here
 * and the two refs it shares with other panels.
 *
 * Note the two distinct close semantics, preserved verbatim from the original component:
 * `closeBulkActions` (X / outside-click) acts as *cancel* - it exits edit mode and clears the
 * selection - whereas the action buttons (share/project/tags/delete) only hide the panel via
 * `setBulkActionsOpen(false)`, keeping the selection so the follow-on modal can act on it.
 */
export function useBulkActions({
  combinedSessions,
  filteredFavoriteSession,
  selectableSessions,
  filtersAnchorRef,
  sidenavRef,
  closeFilters,
}: UseBulkActionsArgs) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { currentSessionId } = useSessions();
  const deleteSessions = useDeleteSessions();
  const downloadSession = useDownloadSession();

  const [selectedItems, setSelectedItems] = useState<Set<string>>(new Set());
  const [isEditMode, setIsEditMode] = useState(false);
  const [bulkActionsOpen, setBulkActionsOpen] = useState(false);
  // Viewport coords for the bulk-actions flyout. It renders `position: fixed` so it can escape the
  // sidebar's scroll clipping context and fly out to the right of the filters button.
  const [bulkActionsPos, setBulkActionsPos] = useState({ top: 0, left: 0 });
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const bulkPanelRef = useRef<HTMLDivElement>(null);

  const handleToggleItemSelection = useCallback((sessionId: string) => {
    setSelectedItems(prev => {
      const newSet = new Set(prev);
      if (newSet.has(sessionId)) {
        newSet.delete(sessionId);
      } else {
        newSet.add(sessionId);
      }
      return newSet;
    });
  }, []);

  const handleDeleteSelected = () => {
    setShowDeleteConfirm(true);
  };

  // Anchor the flyout's left edge 8px past the right edge of the filters button. Re-run on resize so it stays attached.
  const recomputeBulkActionsPos = useCallback(() => {
    const rect = filtersAnchorRef.current?.getBoundingClientRect();
    if (rect) {
      setBulkActionsPos({ top: rect.top, left: rect.right + 8 });
    }
  }, [filtersAnchorRef]);

  // Open the bulk-actions popover: enter edit mode (row checkboxes) and close the filters panel.
  const openBulkActions = () => {
    recomputeBulkActionsPos();
    setIsEditMode(true);
    closeFilters();
    setBulkActionsOpen(true);
  };

  // Dismiss the bulk-actions popover (X / outside click) - acts as cancel: exits edit mode and clears selection.
  const closeBulkActions = () => {
    setBulkActionsOpen(false);
    setIsEditMode(false);
    setSelectedItems(new Set());
  };

  // Close the bulk-actions popover on outside click - but NOT when clicking inside the panel or the
  // sidebar (so the sidebar stays scrollable and notebook checkboxes remain selectable while open).
  useEffect(() => {
    if (!bulkActionsOpen) return;
    const handlePointerDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (bulkPanelRef.current?.contains(target) || sidenavRef.current?.contains(target)) return;
      setBulkActionsOpen(false);
      setIsEditMode(false);
      setSelectedItems(new Set());
    };
    document.addEventListener('mousedown', handlePointerDown);
    return () => document.removeEventListener('mousedown', handlePointerDown);
  }, [bulkActionsOpen, sidenavRef]);

  // Keep the fixed-position flyout attached to the filters button across viewport changes
  // (resize / zoom / tablet rotation) while it's open.
  useEffect(() => {
    if (!bulkActionsOpen) return;
    window.addEventListener('resize', recomputeBulkActionsPos);
    return () => window.removeEventListener('resize', recomputeBulkActionsPos);
  }, [bulkActionsOpen, recomputeBulkActionsPos]);

  // Intersection of selectedItems with currently visible (checkboxed) sessions. Ghost
  // selections - sessions moved to a project while checked, then dropped from looseFilteredItems
  // by a projectsData refetch - are excluded so no bulk operation acts on invisible items.
  const visibleSelectedIds = useMemo(() => {
    const visible = new Set(selectableSessions.map(s => s.id));
    return new Set(Array.from(selectedItems).filter(id => visible.has(id)));
  }, [selectedItems, selectableSessions]);

  const handleDeleteConfirm = useCallback(async () => {
    const sessionIds = Array.from(visibleSelectedIds);

    const result = await deleteSessions.mutateAsync(sessionIds);

    // Handle navigation if current session was deleted
    if (currentSessionId && sessionIds.includes(currentSessionId)) {
      if (!result.newLastNotebookId) {
        navigate({ to: '/new' });
      } else {
        navigate({ to: `/notebooks/${result.newLastNotebookId}` });
      }
    }

    // Success - clean up state
    setSelectedItems(new Set());
    setShowDeleteConfirm(false);
    setIsEditMode(false);
  }, [deleteSessions, navigate, currentSessionId, visibleSelectedIds]);

  const handleToggleSelectAll = () => {
    if (selectableSessions.length > 0 && selectedItems.size === selectableSessions.length) {
      setSelectedItems(new Set());
    } else {
      setSelectedItems(new Set(selectableSessions.map(s => s.id)));
    }
  };

  const handleFavoriteSelected = async () => {
    const sessions = combinedSessions.filter(s => visibleSelectedIds.has(s.id));

    // Batch favorite/unfavorite operations
    try {
      await Promise.all(
        sessions.map(async session => {
          const isFavorite = filteredFavoriteSession.some(fav => fav.id === session.id);
          if (isFavorite) {
            await api.delete(`/api/sessions/${session.id}/favorite`);
          } else {
            await api.post(`/api/sessions/${session.id}/favorite`);
          }
        })
      );

      queryClient.invalidateQueries({ queryKey: ['sessions', 'favorites'] });
      toast.success(`Updated favorites for ${sessions.length} item${sessions.length > 1 ? 's' : ''}`);
      setSelectedItems(new Set());
    } catch (error) {
      toast.error('Failed to update favorites');
    }
  };

  const handleDownloadSelected = async () => {
    const sessions = combinedSessions.filter(s => visibleSelectedIds.has(s.id));

    try {
      for (const session of sessions) {
        await downloadSession.mutateAsync(session);
      }
      toast.success(`Downloaded ${sessions.length} item${sessions.length > 1 ? 's' : ''} as text files`);
      setSelectedItems(new Set());
    } catch (error) {
      toast.error('Failed to download items');
    }
  };

  return {
    selectedItems,
    visibleSelectedIds,
    setSelectedItems,
    isEditMode,
    bulkActionsOpen,
    setBulkActionsOpen,
    bulkActionsPos,
    bulkPanelRef,
    showDeleteConfirm,
    setShowDeleteConfirm,
    deleteSessions,
    handleToggleItemSelection,
    handleToggleSelectAll,
    handleFavoriteSelected,
    handleDownloadSelected,
    handleDeleteSelected,
    handleDeleteConfirm,
    openBulkActions,
    closeBulkActions,
  };
}
