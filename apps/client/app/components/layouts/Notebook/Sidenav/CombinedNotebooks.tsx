import { useUser } from '@client/app/contexts/UserContext';
import { useGetFavoriteSessions, useGetOwnSessions, useGetSharedSessions } from '@client/app/hooks/data/sessions';
import { useSearchProjects } from '@client/app/hooks/data/projects';
import { useGetAgents } from '@client/app/hooks/data/agents';
import { useFeatureEnabled } from '@client/app/hooks/useFeatureEnabled';
import { useIsMobile } from '@client/app/hooks/useIsMobile';
import FiltersPanel from './FiltersPanel';
import BulkActionsPanel from './BulkActionsPanel';
import NotebookRow from './NotebookRow';
import NotebookGroupList from './NotebookGroupList';
import ProjectSessionList from './ProjectSessionList';
import ProjectSidenavItem from '@client/app/components/Project/SidenavItem';
import ProjectModal from './ProjectModal';
import TagModal from './TagModal';
import { useBulkActions } from './useBulkActions';
import type { CombinedItem, CombinedSessionDocument } from './types';
import { APP_NAME } from '@client/config/general';
import { ISessionDocument, IProjectDocument } from '@bike4mind/common';
import CompareArrowsIcon from '@mui/icons-material/CompareArrows';
import TuneIcon from '@mui/icons-material/Tune';
import { Box, Badge, Divider, CircularProgress, Typography, Tooltip, Stack, IconButton } from '@mui/joy';
import { debounce } from 'lodash';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNotebookLayout } from '..';
import { useShallow } from 'zustand/react/shallow';
import FavoriteIcon from '@mui/icons-material/Favorite';
import { useTranslation } from 'react-i18next';
import SearchBar from '@client/app/components/Session/SearchBar';
import { BookOpen } from 'lucide-react';
import dayjs from 'dayjs';
import SidenavNav from './SidenavNav';
import { useNavigate, useLocation } from '@tanstack/react-router';
import ConfirmActionModal from '@client/app/components/ConfirmActionModal';
import ShareDocumentModal from '@client/app/components/common/ShareModal';
import { InviteType } from '@bike4mind/common';
import { scrollbarStyles } from '@client/app/utils/scrollbarStyles';
import { useAdvancedSearch } from '@client/app/hooks/useAdvancedSearch';
import AdvancedSearchDrawer from '@client/app/components/Notebook/Search/AdvancedSearchDrawer';
import ContentPasteSearchOutlinedIcon from '@mui/icons-material/ContentPasteSearchOutlined';

const CombinedNotebooks = () => {
  const [search, setSearch] = useState('');
  const { currentUser } = useUser();
  const { isFeatureEnabled } = useFeatureEnabled();
  const isAgentsEnabled = isFeatureEnabled('enableAgents');
  const location = useLocation();

  // Route-driven sidebar selection. Anywhere in the projects/agents sections (the grid or a
  // specific /:id screen) the stale current-session highlight should be dropped (currentSessionId
  // is a persisted store value that isn't cleared on navigation). A specific project/agent screen
  // additionally highlights its own row. Computed once here so the hot per-notebook rows don't
  // each subscribe to the router.
  const onProjectsSection = location.pathname === '/projects' || location.pathname.startsWith('/projects/');
  const onAgentsSection = location.pathname === '/agents' || location.pathname.startsWith('/agents/');
  const suppressNotebookHighlight = onProjectsSection || onAgentsSection;
  const activeProjectId = useMemo(() => {
    const match = location.pathname.match(/^\/projects\/([^/]+)/);
    return match ? match[1] : null;
  }, [location.pathname]);
  const activeAgentId = useMemo(() => {
    const match = location.pathname.match(/^\/agents\/([^/]+)/);
    return match ? match[1] : null;
  }, [location.pathname]);

  // The shared sidebar serves the default surface (surface:null). Product surfaces like /opti
  // own a dedicated, fully scoped nav (e.g. OptiSidenav) and no longer render this component, so
  // it carries no surface-specific branching.
  const {
    data: ownData,
    fetchNextPage: fetchNextOwn,
    hasNextPage: hasNextOwn,
    isFetching: isFetchingOwn,
  } = useGetOwnSessions(search);
  const {
    data: sharedData,
    fetchNextPage: fetchNextShared,
    hasNextPage: hasNextShared,
    isFetching: isFetchingShared,
  } = useGetSharedSessions(search);
  // Use the same hook as the projects page to ensure we get all projects
  const { data: projectsResponse, isLoading: isLoadingProjects } = useSearchProjects(
    '', // No search filter, we'll filter locally
    { favorite: false },
    { by: 'updatedAt', direction: 'desc' },
    { enabled: !!currentUser?.id }
  );
  const projectsData = useMemo(() => projectsResponse?.pages?.map(page => page.data).flat() ?? [], [projectsResponse]);
  const { data: agentsData, isLoading: isLoadingAgents } = useGetAgents(isAgentsEnabled);
  const { data: favoriteSessions, isFetching: isFetchingFavorites } = useGetFavoriteSessions();
  const [typeFilter, setTypeFilter] = useState<'all' | 'notebooks' | 'projects' | 'agents'>('all');
  const [showMessageCounts, setShowMessageCounts] = useNotebookLayout(
    useShallow(s => [s.showMessageCounts, s.setShowMessageCounts])
  );
  const [filtersOpen, setFiltersOpen] = useState(false);
  // Measured height of the pinned nav block; drives the search bar's sticky `top` so the
  // separator stays flush under the pinned nav even if its rows/gap/padding change (avoids a
  // brittle hard-coded offset). Defaults to the design value until the observer reports.
  const pinnedNavRef = useRef<HTMLDivElement>(null);
  const [pinnedNavHeight, setPinnedNavHeight] = useState(78);
  const filtersAnchorRef = useRef<HTMLDivElement>(null);
  const { t } = useTranslation();
  const isMobile = useIsMobile();
  const setOpenSideNav = useNotebookLayout(s => s.setOpenSideNav);
  const sidenavRef = useRef<HTMLDivElement>(null);
  const navigate = useNavigate();
  const [showShareModal, setShowShareModal] = useState(false);
  const [showProjectModal, setShowProjectModal] = useState(false);
  const [showTagModal, setShowTagModal] = useState(false);

  // Advanced search state
  const { openDrawer, hasActiveFilters, getActiveFilterCount } = useAdvancedSearch();

  // Check if user is new (created within the last 3 days)
  const isNewUser = useMemo(() => {
    return currentUser?.createdAt && dayjs(currentUser.createdAt).isAfter(dayjs().subtract(3, 'day'));
  }, [currentUser]);

  const handleTutorialClick = () => {
    if (isMobile) setOpenSideNav(false);
    navigate({ to: '/tutorials' });
  };

  // Track the pinned nav's rendered height so the sticky search `top` stays in sync with it.
  useEffect(() => {
    const el = pinnedNavRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => {
      const h = Math.round(el.getBoundingClientRect().height);
      if (h > 0) setPinnedNavHeight(h);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const handleFetchNext = useCallback(
    async (e: React.UIEvent<HTMLDivElement>) => {
      const element = e.target as HTMLDivElement;
      if (!hasNextOwn && !hasNextShared) return;

      const value = Math.floor(element.scrollHeight - element.scrollTop);
      if (value + 2 >= element.clientHeight && value - 2 <= element.clientHeight) {
        if (hasNextOwn) await fetchNextOwn();
        if (hasNextShared) await fetchNextShared();
      }
    },
    [fetchNextOwn, fetchNextShared, hasNextOwn, hasNextShared]
  );

  // This fixes infinite scroll not enabled for lengthy screen height
  useEffect(() => {
    if (sidenavRef.current) {
      const element = sidenavRef.current as HTMLDivElement;
      if (isFetchingOwn || isFetchingShared) return;
      if (element.scrollHeight <= element.clientHeight) {
        if (ownData?.pages.every(page => page.hasMore)) fetchNextOwn();
        if (sharedData?.pages.every(page => page.hasMore)) fetchNextShared();
      }
    }
  }, [fetchNextOwn, fetchNextShared, ownData?.pages, sharedData?.pages, isFetchingOwn, isFetchingShared]);

  // The page-1 trim on remount lives in the useGetOwnSessions / useGetSharedSessions
  // `refetchOnMount` callbacks. Evicting the queries here ran AFTER the observers had already
  // kicked off their cold-mount fetch, so the eviction forced a second fetch (the 2x cold-load
  // double-fetch). Removed.

  const debounceFetch = useMemo(() => debounce(handleFetchNext, 500), [handleFetchNext]);

  const handleNotebookClick = useCallback(
    (s: ISessionDocument) => {
      if (isMobile) setOpenSideNav(false);
      navigate({ to: `/notebooks/${s.id}` });
    },
    [isMobile, setOpenSideNav, navigate]
  );

  // Stable navigate handler for agent/project rows (closes the side nav on mobile first).
  // Stable identity keeps NotebookRow's memo effective so list rows aren't re-rendered en masse.
  const handleItemNavigate = useCallback(
    (path: string) => {
      if (isMobile) setOpenSideNav(false);
      navigate({ to: path });
    },
    [isMobile, setOpenSideNav, navigate]
  );

  // Combine own and shared sessions with indicator
  const combinedSessions = useMemo(() => {
    const combined: CombinedSessionDocument[] = [];
    const existingIds = new Set<string>();

    // Add own sessions (loads independently)
    if (ownData) {
      const ownSessions = ownData.pages
        .map(page => page.data)
        .flat()
        .filter(d => d.userId === currentUser?.id)
        .map(session => {
          existingIds.add(session.id);
          // IMPORTANT: Put overrides AFTER spread so they take precedence
          const result: CombinedSessionDocument = {
            ...session,
            isShared: false,
            isProject: false,
            isAgent: false,
          };
          return result;
        });
      combined.push(...ownSessions);
    }

    // Add shared sessions with indicator (loads independently)
    if (sharedData) {
      const sharedSessions = sharedData.pages
        .map(page => page.data)
        .flat()
        .map(session => {
          existingIds.add(session.id);
          const result: CombinedSessionDocument = {
            ...session,
            isShared: true,
            isProject: false,
            isAgent: false,
          };
          return result;
        });
      combined.push(...sharedSessions);
    }

    // Sort by last updated
    return combined.sort((a, b) => new Date(b.lastUpdated).getTime() - new Date(a.lastUpdated).getTime());
  }, [ownData, sharedData, currentUser?.id]);

  // Process projects separately since they have different structure
  const processedProjects = useMemo(() => {
    if (!projectsData || projectsData.length === 0) {
      return [];
    }

    // Filter projects by search and format them to look like sessions for display
    const projects = projectsData
      .filter(
        project =>
          project.name.toLowerCase().includes(search.toLowerCase()) ||
          project.description?.toLowerCase().includes(search.toLowerCase())
      )
      .map(project => ({
        ...project,
        isProject: true,
        // Map project fields to session-like fields for consistent display
        lastUpdated: project.updatedAt || project.createdAt,
        firstCreated: project.createdAt,
      }));
    return projects;
  }, [projectsData, search]);

  // processedProjects already applies the same name/description search filter; reuse it
  // directly to avoid duplicating the predicate. The spread preserves all IProjectDocument
  // fields so the cast is safe.
  const displayProjects = processedProjects as unknown as IProjectDocument[];

  // Session IDs that belong to a *currently visible* (search-matching) project.
  // Built from processedProjects (search-filtered) so sessions of non-matching projects
  // still appear in the loose date-grouped list when their project is hidden by search.
  const projectSessionIds = useMemo(() => {
    const ids = new Set<string>();
    // as unknown as: processedProjects items are spread IProjectDocument objects; .map()
    // inference produces an anonymous type so the cast is required to access named fields.
    processedProjects.forEach(p => (p as unknown as IProjectDocument).sessionIds?.forEach(id => ids.add(id)));
    return ids;
  }, [processedProjects]);

  // Per-project expand state. A project's notebooks are lazily fetched on first expand.
  const [expandedProjects, setExpandedProjects] = useState<Set<string>>(new Set());

  const handleToggleProject = useCallback((projectId: string) => {
    setExpandedProjects(prev => {
      const next = new Set(prev);
      if (next.has(projectId)) {
        next.delete(projectId);
      } else {
        next.add(projectId);
      }
      return next;
    });
  }, []);

  // Process agents to display in the list
  const processedAgents = useMemo(() => {
    if (!agentsData || !isAgentsEnabled) {
      return [];
    }

    // Filter agents by search and format them for display
    return agentsData
      .filter(
        agent =>
          agent.name.toLowerCase().includes(search.toLowerCase()) ||
          agent.triggerWords.some(trigger => trigger.toLowerCase().includes(search.toLowerCase()))
      )
      .map(agent => ({
        id: agent.id,
        name: agent.name,
        isAgent: true,
        lastUpdated: agent.updatedAt || agent.createdAt,
        firstCreated: agent.createdAt,
        triggerWords: agent.triggerWords,
        visual: agent.visual,
      }));
  }, [agentsData, search, isAgentsEnabled]);

  /**
   * Filter all items ONCE here; reused by both searchResultsMetadata (counts/stats) and
   * renderGroupSessions (rendering). Avoids filtering 4000+ notebooks twice per render.
   */
  const filteredItems = useMemo(() => {
    let allItems: CombinedItem[] = [...combinedSessions, ...processedProjects, ...processedAgents];

    // Apply type filter
    if (typeFilter !== 'all') {
      allItems = allItems.filter(item => {
        if (typeFilter === 'notebooks') {
          const isNotProject = !('isProject' in item) || item.isProject === false;
          const isNotAgent = !('isAgent' in item) || item.isAgent === false;
          return isNotProject && isNotAgent;
        }
        if (typeFilter === 'projects') {
          return 'isProject' in item && item.isProject === true;
        }
        if (typeFilter === 'agents') {
          return 'isAgent' in item && item.isAgent === true;
        }
        return true;
      });
    }

    return allItems;
  }, [combinedSessions, processedProjects, processedAgents, typeFilter]);

  // Items for the date-grouped list: exclude project rows (rendered in the Projects section
  // above) and sessions that already appear nested under a project (avoids duplication).
  // Only deduplicate project-member sessions when the Projects section is actually visible -
  // when typeFilter='notebooks' the Projects section is hidden, so those sessions must remain
  // in the loose list or they become unreachable in both panels.
  const looseFilteredItems = useMemo(() => {
    const projectsVisible = typeFilter === 'all' || typeFilter === 'projects';
    return filteredItems.filter(
      item => !('isProject' in item && item.isProject) && (!projectsVisible || !projectSessionIds.has(item.id))
    );
  }, [filteredItems, projectSessionIds, typeFilter]);

  // Bulk actions target only the sessions that are actually rendered with checkboxes -
  // i.e. the loose date-grouped list (looseFilteredItems), excluding agents. Project-member
  // sessions are hidden inside ProjectSessionList which has no bulk-selection affordance, so
  // they must not be included here or "Select all" would silently target invisible items.
  const selectableSessions = useMemo(
    () => looseFilteredItems.filter(item => !('isAgent' in item && item.isAgent)),
    [looseFilteredItems]
  );

  // Calculate search results metadata from pre-filtered items (no duplicate filtering!)
  const searchResultsMetadata = useMemo(() => {
    // Calculate counts by type from already-filtered items
    const notebooks = filteredItems.filter(item => {
      const isProject = 'isProject' in item && item.isProject === true;
      const isAgent = 'isAgent' in item && item.isAgent === true;
      return !isProject && !isAgent;
    }).length;

    const projects = filteredItems.filter(item => 'isProject' in item && item.isProject === true).length;
    const agents = filteredItems.filter(item => 'isAgent' in item && item.isAgent === true).length;

    // Calculate breakdown (only for notebooks)
    const breakdown = {
      original: filteredItems.filter(item => {
        if ('isShared' in item && item.isShared) return false;
        if ('isProject' in item && item.isProject) return false;
        if ('isAgent' in item && item.isAgent) return false;
        if ('clonedSourceId' in item && item.clonedSourceId) return false;
        if ('forkedSourceId' in item && item.forkedSourceId) return false;
        return true;
      }).length,
      cloned: filteredItems.filter(item => 'clonedSourceId' in item && item.clonedSourceId).length,
      forked: filteredItems.filter(item => 'forkedSourceId' in item && item.forkedSourceId).length,
      shared: filteredItems.filter(item => 'isShared' in item && item.isShared === true).length,
    };

    return {
      total: filteredItems.length,
      notebooks,
      agents,
      projects,
      breakdown,
      page: 1,
      pageSize: filteredItems.length,
      hasMore: false,
    };
  }, [filteredItems]);

  const filteredFavoriteSession = useMemo(() => {
    if (!favoriteSessions) return [];

    // Filter favorites to match search
    return favoriteSessions
      .filter(d => d.name.toLowerCase().includes(search.toLowerCase()))
      .map(session => {
        // Check if it's shared
        const isShared = session.userId !== currentUser?.id;
        return { ...session, isShared };
      });
  }, [favoriteSessions, currentUser?.id, search]);

  // Bulk-action state machine (selection, edit mode, flyout, batch operations). Called after the
  // derived lists it consumes are computed so it receives already-memoized inputs.
  const {
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
  } = useBulkActions({
    combinedSessions,
    filteredFavoriteSession,
    selectableSessions,
    filtersAnchorRef,
    sidenavRef,
    closeFilters: () => setFiltersOpen(false),
  });

  // Visibility options for the filters popover (order matches the design: Show All, Notebooks,
  // Agents, Projects). Agents only appears when the feature is enabled.
  const typeOptions: { value: 'all' | 'notebooks' | 'projects' | 'agents'; label: string }[] = useMemo(
    () => [
      { value: 'all', label: t('filter.showAll', 'Show All') },
      { value: 'notebooks', label: t('notebooks.title', 'Notebooks') },
      ...(isAgentsEnabled ? [{ value: 'agents' as const, label: t('agents.title', 'Agents') }] : []),
      { value: 'projects', label: t('projects.projects', 'Projects') },
    ],
    [isAgentsEnabled, t]
  );

  return (
    <>
      {/* One unified scroll region: pinned nav (frosted) + remaining nav + search + list. */}
      <Stack
        className="notebook-sidenav-content combined-notebooks-content"
        ref={sidenavRef}
        sx={{
          overflowY: 'auto',
          flexGrow: 1,
          minHeight: 0,
          ...scrollbarStyles,
        }}
        onScroll={debounceFetch}
      >
        {/* Pinned nav: New Chat + Files Manager stay put. A solid backdrop
            lets scrolling content pass under it without the labels merging into it. */}
        <Box
          ref={pinnedNavRef}
          className="notebook-sidenav-pinned"
          sx={theme => ({
            position: 'sticky',
            top: 0,
            zIndex: 3,
            px: '10px',
            pt: '10px',
            pb: 0,
            backgroundColor: theme.palette.sidenav?.pinnedBackdrop,
          })}
        >
          <SidenavNav section="pinned" />
        </Box>
        <Stack
          className="notebook-sidenav-container combined-notebooks-container"
          sx={{ p: '0 10px 0', gap: 1.5, mb: 0, mt: '4px' }}
        >
          <SidenavNav section="scroll" />
        </Stack>

        {/* Search bar — sticks just under the pinned nav once you scroll past it.
            Must be a DIRECT child of the scroll region (not the short nav container),
            otherwise sticky has no room and scrolls away with its parent. */}
        <Box
          className="notebook-sidenav-search-container"
          sx={theme => ({
            display: 'flex',
            flexDirection: 'column',
            position: 'sticky',
            // Abut the bottom of the pinned nav using its *measured* height (see pinnedNavHeight),
            // so the divider below sits in this block's clear area and isn't occluded by the pinned nav.
            top: `${pinnedNavHeight}px`,
            zIndex: 2,
            px: '10px',
            pt: '6px',
            pb: '10px',
            backgroundColor: theme.palette.sidenav?.pinnedBackdrop,
          })}
        >
          {/* Divider above the search — part of this sticky block, so it stays directly above the
              search bar (never under the pinned nav) in both the default and scrolled states. */}
          <Divider sx={{ mb: '10px' }} />

          {/* Search row */}
          <Box sx={{ display: 'flex', gap: 1, alignItems: 'center' }}>
            <Box sx={{ flex: 1 }}>
              <SearchBar
                data-testid="notebook-search-input"
                handleChange={setSearch}
                placeHolder={t('search')}
                debounceTimeout={300}
              />
            </Box>
            {/* Advanced Search Button */}
            <Tooltip title="Advanced Search & Actions" placement="bottom">
              <Badge
                badgeContent={getActiveFilterCount()}
                color="primary"
                size="sm"
                invisible={!hasActiveFilters()}
                sx={{
                  '& .MuiBadge-badge': { right: 4, top: 4, fontSize: '10px', minWidth: '16px', height: '16px' },
                }}
              >
                <IconButton
                  data-testid="advanced-search-btn"
                  variant="outlined"
                  color="neutral"
                  onClick={openDrawer}
                  sx={{
                    width: '36px',
                    height: '36px',
                    borderRadius: '8px',
                    position: 'relative',
                  }}
                >
                  <ContentPasteSearchOutlinedIcon sx={{ fontSize: '18px', color: 'text.primary' }} />
                </IconButton>
              </Badge>
            </Tooltip>

            {/* Filters popover: visibility (type) + notebook actions */}
            <Box ref={filtersAnchorRef} sx={{ position: 'relative' }}>
              <Tooltip title={t('filter.title', 'Filters')} placement="bottom">
                <IconButton
                  data-testid="sidenav-filters-btn"
                  variant="outlined"
                  color="neutral"
                  onClick={() => setFiltersOpen(v => !v)}
                  sx={theme => ({
                    width: '36px',
                    height: '36px',
                    borderRadius: '8px',
                    // Active (dropdown open, bulk-actions/edit mode, or a filter applied): keep the default
                    // neutral border, add the faint brand fill (#D1E4F4 @ 5% dark / brand tint light) via the shared token.
                    ...((filtersOpen || isEditMode || typeFilter !== 'all' || showMessageCounts) && {
                      backgroundColor: theme.palette.sidenav?.filterActiveBg,
                    }),
                  })}
                >
                  <TuneIcon sx={{ fontSize: '18px' }} />
                </IconButton>
              </Tooltip>
              {filtersOpen && (
                <FiltersPanel
                  typeOptions={typeOptions}
                  typeFilter={typeFilter}
                  setTypeFilter={setTypeFilter}
                  showMessageCounts={showMessageCounts}
                  setShowMessageCounts={setShowMessageCounts}
                  onOpenBulkActions={openBulkActions}
                  onClose={() => setFiltersOpen(false)}
                />
              )}

              {/* Bulk-actions popover — opened from "Notebooks bulk actions". Replaces the old sticky toolbar.
                Functionality is unchanged; only the surface/affordance is redesigned into this menu.
                Portaled to <body> so the `position: fixed` panel anchors to the viewport and isn't
                clipped by the sidebar's scroll region. */}
              {bulkActionsOpen && (
                <BulkActionsPanel
                  ref={bulkPanelRef}
                  pos={bulkActionsPos}
                  selectedCount={selectedItems.size}
                  selectableCount={selectableSessions.length}
                  onClose={closeBulkActions}
                  onToggleSelectAll={handleToggleSelectAll}
                  onShare={() => {
                    setShowShareModal(true);
                    setBulkActionsOpen(false);
                  }}
                  onFavorite={handleFavoriteSelected}
                  onAddToProject={() => {
                    setShowProjectModal(true);
                    setBulkActionsOpen(false);
                  }}
                  onAddTags={() => {
                    setShowTagModal(true);
                    setBulkActionsOpen(false);
                  }}
                  onDownload={handleDownloadSelected}
                  onDelete={() => {
                    handleDeleteSelected();
                    setBulkActionsOpen(false);
                  }}
                />
              )}
            </Box>
          </Box>
        </Box>
        <Stack className="combined-notebooks-list" gap="10px" sx={{ p: '10px 5px 16px 10px' }}>
          {/* Tutorial section for new users */}
          {isNewUser && (
            <div>
              <Typography
                className="notebook-sidenav-section-title"
                level="body-xs"
                sx={{
                  color: 'neutral.softDisabledColor',
                  marginBottom: '0.1em',
                }}
              >
                Tutorials
              </Typography>
              <Box
                className="notebook-sidenav-tutorial-item"
                role="button"
                tabIndex={0}
                onClick={handleTutorialClick}
                onKeyDown={e => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    handleTutorialClick();
                  }
                }}
                sx={theme => {
                  const isSelected = location.pathname === '/tutorials';
                  return {
                    borderRadius: '8px',
                    gap: '8px',
                    padding: '8px 12px',
                    marginBottom: '10px',
                    display: 'flex',
                    alignItems: 'center',
                    cursor: 'pointer',
                    backgroundColor: isSelected ? theme.palette.notebooklist.focusedBackground : 'transparent',
                    '&:hover': {
                      backgroundColor: isSelected ? undefined : theme.palette.notebooklist.hoverBg,
                    },
                    transition: 'background 0.2s',
                  };
                }}
              >
                {/* 20x20 frame around an 18px SVG, matching the top SidenavNav icon slots.
                    Pin the child svg to 18px so it can't stretch to fill the 20px frame. */}
                <Box
                  sx={{
                    width: 20,
                    height: 20,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    flexShrink: 0,
                    '& svg': { width: '18px', height: '18px' },
                  }}
                >
                  <BookOpen style={{ color: 'inherit' }} />
                </Box>
                <Typography
                  level="body-xs"
                  sx={theme => ({
                    color: theme.palette.neutral.softColor,
                    fontWeight: 400,
                    textAlign: 'left',
                    whiteSpace: 'nowrap',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                  })}
                  noWrap
                >
                  {/* brand externalized */}
                  {APP_NAME ? `How to work with ${APP_NAME}?` : 'How to get started?'}
                </Typography>
              </Box>
            </div>
          )}

          {/* Favorites section */}
          {filteredFavoriteSession.length > 0 && (
            <div>
              <Typography
                className="notebook-sidenav-favorites-title"
                level="body-xs"
                sx={{
                  color: 'neutral.softDisabledColor',
                  marginBottom: '0.1em',
                  display: 'flex',
                  alignItems: 'center',
                  gap: '4px',
                }}
              >
                {t('llm.favorites_count', { count: filteredFavoriteSession.length })}
                <FavoriteIcon sx={{ fontSize: '14px', color: 'primary.500' }} />
              </Typography>
              <div>
                {filteredFavoriteSession.map(d => (
                  <Box
                    key={d.id}
                    data-testid="notebook-list-item"
                    sx={{ display: 'flex', alignItems: 'center', position: 'relative' }}
                  >
                    {('isShared' in d ? d.isShared : false) && (
                      <Box
                        sx={theme => ({
                          width: '20px',
                          height: '20px',
                          borderRadius: '4px',
                          backgroundColor:
                            theme.palette.mode === 'dark' ? 'rgba(209, 228, 244, 0.1)' : 'rgba(209, 228, 244, 0.7)',
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'center',
                          ml: 1,
                          mr: '10px',
                          flexShrink: 0,
                        })}
                      >
                        <CompareArrowsIcon
                          sx={theme => ({
                            fontSize: '14px',
                            color: theme.palette.mode === 'dark' ? '#D1E4F4' : '#335F70',
                          })}
                        />
                      </Box>
                    )}
                    <Box sx={{ flex: 1 }}>
                      <NotebookRow
                        item={d as unknown as CombinedItem}
                        isEditMode={isEditMode}
                        isChecked={selectedItems.has(d.id)}
                        isShared={false}
                        favoriteSessions={favoriteSessions}
                        showMessageCount={false}
                        suppressActive={suppressNotebookHighlight}
                        activeAgentId={activeAgentId}
                        onNavigate={handleItemNavigate}
                        onNotebookClick={handleNotebookClick}
                        onToggle={handleToggleItemSelection}
                      />
                    </Box>
                  </Box>
                ))}
              </div>
            </div>
          )}

          {/* Projects section — collapsible nodes with lazy-loaded nested notebooks */}
          {displayProjects.length > 0 && (typeFilter === 'all' || typeFilter === 'projects') && (
            <div>
              <Typography
                className="notebook-sidenav-section-title"
                level="body-xs"
                sx={{ color: 'neutral.softDisabledColor', marginBottom: '0.1em' }}
              >
                {t('projects.projects', 'Projects')}
              </Typography>
              {displayProjects.map(project => (
                <Box key={project.id}>
                  <ProjectSidenavItem
                    project={project as IProjectDocument}
                    isExpanded={expandedProjects.has(project.id)}
                    onToggleExpand={() => handleToggleProject(project.id)}
                    onClick={() => handleItemNavigate(`/projects/${project.id}`)}
                    isSelected={project.id === activeProjectId}
                  />
                  {expandedProjects.has(project.id) && (
                    <ProjectSessionList
                      project={project as IProjectDocument}
                      onNotebookClick={handleNotebookClick}
                      favoriteSessions={favoriteSessions}
                      suppressActive={suppressNotebookHighlight}
                    />
                  )}
                </Box>
              ))}
            </div>
          )}

          {/* All notebooks grouped by date or tags (excludes project-member sessions) */}
          <NotebookGroupList
            items={looseFilteredItems}
            favoriteItems={filteredFavoriteSession}
            isEditMode={isEditMode}
            selectedItems={selectedItems}
            favoriteSessions={favoriteSessions}
            showMessageCount={showMessageCounts}
            suppressActive={suppressNotebookHighlight}
            activeAgentId={activeAgentId}
            onNavigate={handleItemNavigate}
            onNotebookClick={handleNotebookClick}
            onToggle={handleToggleItemSelection}
          />

          <Stack className="notebook-sidenav-loading-indicator" alignItems={'center'} justifyContent="center">
            {(isFetchingOwn || isFetchingShared || isFetchingFavorites || isLoadingProjects || isLoadingAgents) && (
              <CircularProgress size="sm" />
            )}
          </Stack>
        </Stack>
      </Stack>

      {/* Share Modal */}
      {showShareModal && (
        <ShareDocumentModal
          open={showShareModal}
          onClose={() => {
            setShowShareModal(false);
            setSelectedItems(new Set());
          }}
          type={InviteType.Session}
          sessions={combinedSessions.filter(s => visibleSelectedIds.has(s.id) && !s.isProject && !s.isAgent)}
        />
      )}

      {/* Project Modal */}
      <ProjectModal
        open={showProjectModal}
        onClose={() => setShowProjectModal(false)}
        selectedItems={visibleSelectedIds}
        combinedSessions={combinedSessions}
        onAdded={() => setSelectedItems(new Set())}
      />

      {/* Tag Modal */}
      <TagModal
        open={showTagModal}
        onClose={() => setShowTagModal(false)}
        selectedItems={visibleSelectedIds}
        combinedSessions={combinedSessions}
        onTagged={() => setSelectedItems(new Set())}
      />

      {/* Delete Confirmation Modal */}
      <ConfirmActionModal
        data-testid="confirm-bulk-delete-modal"
        open={showDeleteConfirm}
        title={t('notebooks.delete')}
        description={`Are you sure you want to delete ${selectedItems.size} selected item${selectedItems.size > 1 ? 's' : ''}? This action cannot be undone.`}
        onGoForward={handleDeleteConfirm}
        onGoBackward={() => setShowDeleteConfirm(false)}
        forwardButtonText="Delete"
        backwardButtonText="Cancel"
        loading={deleteSessions.isPending}
      />

      {/* Advanced Search Drawer */}
      <AdvancedSearchDrawer
        metadata={searchResultsMetadata}
        isLoading={isFetchingOwn || isFetchingShared || isLoadingProjects || isLoadingAgents}
      />
    </>
  );
};

export default CombinedNotebooks;
