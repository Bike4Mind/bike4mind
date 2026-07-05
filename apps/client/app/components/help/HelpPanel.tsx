import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  Box,
  Chip,
  Drawer,
  IconButton,
  Stack,
  Typography,
  Divider,
  Input,
  List,
  ListItem,
  ListItemButton,
  ListItemContent,
  CircularProgress,
  Tabs,
  TabList,
  Tab,
} from '@mui/joy';
import KeyboardIcon from '@mui/icons-material/Keyboard';
import MenuBookIcon from '@mui/icons-material/MenuBook';
import { useTheme } from '@mui/joy/styles';
import CloseIcon from '@mui/icons-material/Close';
import ArrowBackIcon from '@mui/icons-material/ArrowBack';
import ArrowForwardIcon from '@mui/icons-material/ArrowForward';
import HomeIcon from '@mui/icons-material/Home';
import SearchIcon from '@mui/icons-material/Search';
import DragIndicatorIcon from '@mui/icons-material/DragIndicator';
import { useHelpPanel } from '@client/app/hooks/useHelpPanel';
import { useHelpIndex, searchEntries, getEntryBySlug } from '@client/app/hooks/useHelpIndex';
import { useAdminSettingsCache } from '@client/app/hooks/useAdminSettingsCache';
import HelpContent from './HelpContent';
import HelpTOC from './HelpTOC';
import HelpBreadcrumbs from './HelpBreadcrumbs';
import HelpChat from './HelpChat';
import RecentlyViewedList from './RecentlyViewedList';
import { useHelpChat } from '@client/app/hooks/useHelpChat';
import { useHelpAnalytics, useMyRecentlyViewed } from '@client/app/hooks/useHelpAnalytics';
import { useArticleFeedbackState } from '@client/app/hooks/useArticleFeedbackState';
import ThumbUpIcon from '@mui/icons-material/ThumbUp';
import ThumbDownIcon from '@mui/icons-material/ThumbDown';
import ThumbUpOutlinedIcon from '@mui/icons-material/ThumbUpOutlined';
import ThumbDownOutlinedIcon from '@mui/icons-material/ThumbDownOutlined';
import type { HelpIndexEntry } from '@bike4mind/scripts/help/types';

const MIN_PANEL_WIDTH = 320;
const MAX_PANEL_WIDTH = 1200;
const MIN_CHAT_HEIGHT = 300;
const MAX_CHAT_HEIGHT = 700;

/** Compact thumbs up/down shown next to breadcrumbs in the article header */
const HeaderFeedbackThumbs: React.FC<{ slug: string }> = ({ slug }) => {
  const { rating, handleRating } = useArticleFeedbackState(slug);

  return (
    <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5, flexShrink: 0 }}>
      <IconButton
        size="sm"
        variant="plain"
        color={rating === 'helpful' ? 'success' : 'neutral'}
        onClick={() => handleRating('helpful')}
        data-testid="help-header-thumbs-up"
        sx={{ '--IconButton-size': '28px' }}
      >
        {rating === 'helpful' ? <ThumbUpIcon sx={{ fontSize: 16 }} /> : <ThumbUpOutlinedIcon sx={{ fontSize: 16 }} />}
      </IconButton>
      <IconButton
        size="sm"
        variant="plain"
        color={rating === 'not_helpful' ? 'danger' : 'neutral'}
        onClick={() => handleRating('not_helpful')}
        data-testid="help-header-thumbs-down"
        sx={{ '--IconButton-size': '28px' }}
      >
        {rating === 'not_helpful' ? (
          <ThumbDownIcon sx={{ fontSize: 16 }} />
        ) : (
          <ThumbDownOutlinedIcon sx={{ fontSize: 16 }} />
        )}
      </IconButton>
      {rating && (
        <Chip size="sm" color="neutral" variant="soft" sx={{ fontSize: '0.65rem' }}>
          Thanks!
        </Chip>
      )}
    </Box>
  );
};

const HelpPanel: React.FC = () => {
  const theme = useTheme();
  const mode = theme.palette.mode;

  const {
    open,
    currentSlug,
    currentAnchor,
    panelWidth,
    setPanelWidth,
    chatHeight,
    setChatHeight,
    close,
    navigateTo,
    goBack,
    goForward,
    history,
    historyIndex,
  } = useHelpPanel();

  const { data: helpIndex, isLoading: indexLoading } = useHelpIndex();

  // Check if AI Help Chat is enabled by admin
  const { isFeatureEnabled } = useAdminSettingsCache();
  const isHelpChatEnabled = isFeatureEnabled('EnableHelpChat');

  // Track whether the help chat is expanded (for showing the drag handle)
  const isChatOpen = useHelpChat(state => state.isOpen);
  const showChatDragHandle = isHelpChatEnabled && isChatOpen;

  // Drag handle state for horizontal splitter
  const [isChatDragging, setIsChatDragging] = useState(false);

  const [activeTab, setActiveTab] = useState<'shortcuts' | 'help'>('help');

  const [searchQuery, setSearchQuery] = React.useState('');
  const [searchResults, setSearchResults] = React.useState<HelpIndexEntry[]>([]);
  const [showSearch, setShowSearch] = React.useState(false);

  // Analytics tracking
  const { trackArticleView, trackSearch } = useHelpAnalytics();

  // Recently viewed help articles - shown on the Help Center home view
  const { data: recentlyViewedData } = useMyRecentlyViewed();
  const recentlyViewed = recentlyViewedData?.recentlyViewed ?? [];

  const resizeRef = useRef<HTMLDivElement>(null);
  const isResizing = useRef(false);
  const hasProcessedDeepLink = useRef(false);
  const prevSearchQueryRef = useRef('');

  // Get current entry
  const currentEntry = helpIndex ? getEntryBySlug(helpIndex.entries, currentSlug) : undefined;

  // Sync the active tab when the panel opens OR when the slug is programmatically
  // set to features/keyboard-shortcuts (e.g. via Command Palette while panel is open).
  // Rule: only switch TO 'shortcuts' reactively - never force back to 'help' on slug
  // changes, so in-Help-Center navigation doesn't clobber the user's tab choice.
  const prevOpenRef = useRef(false);
  useEffect(() => {
    if (!open) {
      prevOpenRef.current = false;
      return;
    }
    const opening = !prevOpenRef.current;
    prevOpenRef.current = true;
    if (opening) {
      // Default to Shortcuts unless opening directly to a specific help article.
      // Plain `?` press has currentSlug='index', so it correctly lands on Shortcuts.
      setActiveTab(
        currentSlug && currentSlug !== 'index' && currentSlug !== 'features/keyboard-shortcuts' ? 'help' : 'shortcuts'
      );
    } else if (currentSlug === 'features/keyboard-shortcuts') {
      // Panel already open - programmatic navigation to shortcuts (e.g. Command Palette).
      setActiveTab('shortcuts');
    }
    // Navigating away from shortcuts while panel is open: no tab flip.
  }, [open, currentSlug]);

  // Track article views when slug changes
  useEffect(() => {
    if (open && currentSlug && currentSlug !== 'index' && currentEntry) {
      trackArticleView(currentSlug, currentEntry.title);
    }
  }, [open, currentSlug, currentEntry, trackArticleView]);

  // Deep linking: check URL params on mount
  useEffect(() => {
    // Only process deep link once on initial render
    if (hasProcessedDeepLink.current) return;

    const urlParams = new URLSearchParams(window.location.search);
    const helpParam = urlParams.get('help');
    const anchorParam = urlParams.get('anchor');

    if (helpParam) {
      hasProcessedDeepLink.current = true;
      // Open help panel to the specified slug and anchor
      navigateTo(helpParam, anchorParam || undefined);
      useHelpPanel.getState().setOpen(true);
    }
  }, [navigateTo]);

  // Sync URL when navigating (for shareable links)
  useEffect(() => {
    if (!open) {
      // Remove help params when panel is closed
      const url = new URL(window.location.href);
      if (url.searchParams.has('help') || url.searchParams.has('anchor')) {
        url.searchParams.delete('help');
        url.searchParams.delete('anchor');
        window.history.replaceState({}, '', url.toString());
      }
      return;
    }

    // Update URL with current help state (only for articles, not home)
    if (currentSlug && currentSlug !== 'index') {
      const url = new URL(window.location.href);
      url.searchParams.set('help', currentSlug);
      if (currentAnchor) {
        url.searchParams.set('anchor', currentAnchor);
      } else {
        url.searchParams.delete('anchor');
      }
      window.history.replaceState({}, '', url.toString());
    }
  }, [open, currentSlug, currentAnchor]);

  // Handle search - only fire analytics when the query itself changes, not on helpIndex reload
  useEffect(() => {
    if (!helpIndex || !searchQuery.trim()) {
      setSearchResults([]);
      return;
    }
    const results = searchEntries(helpIndex.entries, searchQuery);
    setSearchResults(results);
    // Deduplicate: skip tracking if the query hasn't changed (including clear-then-retype)
    if (searchQuery !== prevSearchQueryRef.current) {
      prevSearchQueryRef.current = searchQuery;
      trackSearch(searchQuery, results.length);
    }
  }, [searchQuery, helpIndex, trackSearch]);

  // Handle resize
  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    isResizing.current = true;
    e.preventDefault();
  }, []);

  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      if (!isResizing.current) return;

      const newWidth = window.innerWidth - e.clientX;
      if (newWidth >= MIN_PANEL_WIDTH && newWidth <= MAX_PANEL_WIDTH) {
        setPanelWidth(newWidth);
      }
    };

    const handleMouseUp = () => {
      isResizing.current = false;
    };

    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);

    return () => {
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
    };
  }, [setPanelWidth]);

  // Handle vertical drag for chat height (updates React state on every move,
  // same approach as the panel-width resize so content reflows live)
  const chatDragParentRef = useRef<HTMLElement | null>(null);

  const handleChatDragPointerDown = useCallback(
    (e: React.PointerEvent) => {
      e.preventDefault();
      const handle = e.currentTarget as HTMLElement;
      handle.setPointerCapture(e.pointerId);

      setIsChatDragging(true);
      chatDragParentRef.current = handle.parentElement;

      const body = document.body;
      body.style.userSelect = 'none';
      body.style.cursor = 'row-resize';

      const handlePointerMove = (ev: PointerEvent) => {
        const parent = chatDragParentRef.current;
        if (!parent) return;
        const parentRect = parent.getBoundingClientRect();
        const newHeight = parentRect.bottom - ev.clientY;
        const clamped = Math.max(MIN_CHAT_HEIGHT, Math.min(MAX_CHAT_HEIGHT, newHeight));
        setChatHeight(clamped);
      };

      const handlePointerUp = () => {
        setIsChatDragging(false);
        chatDragParentRef.current = null;
        body.style.userSelect = '';
        body.style.cursor = '';
        window.removeEventListener('pointermove', handlePointerMove);
        window.removeEventListener('pointerup', handlePointerUp);
      };

      window.addEventListener('pointermove', handlePointerMove);
      window.addEventListener('pointerup', handlePointerUp);
    },
    [setChatHeight]
  );

  // Navigate to home
  const handleHome = () => {
    setShowSearch(false);
    setSearchQuery('');
    setViewingCategory(null);
    navigateTo('index');
  };

  // Handle search result click
  const handleSearchResultClick = (entry: HelpIndexEntry) => {
    setShowSearch(false);
    setSearchQuery('');
    navigateTo(entry.slug);
  };

  // Render search results
  const renderSearchResults = () => {
    if (!searchQuery.trim()) {
      return (
        <Box sx={{ p: 3, textAlign: 'center' }}>
          <Typography level="body-sm" sx={{ color: 'text.tertiary' }}>
            Type to search documentation
          </Typography>
        </Box>
      );
    }

    if (searchResults.length === 0) {
      return (
        <Box sx={{ p: 3, textAlign: 'center' }}>
          <Typography level="body-sm" sx={{ color: 'text.tertiary' }}>
            No results found for &quot;{searchQuery}&quot;
          </Typography>
        </Box>
      );
    }

    return (
      <List size="sm">
        {searchResults.map(entry => (
          <ListItem key={entry.slug}>
            <ListItemButton onClick={() => handleSearchResultClick(entry)}>
              <ListItemContent>
                <Typography level="body-sm" fontWeight="md">
                  {entry.title}
                </Typography>
                {entry.description && (
                  <Typography level="body-xs" sx={{ color: 'text.tertiary' }}>
                    {entry.description.slice(0, 100)}
                    {entry.description.length > 100 ? '...' : ''}
                  </Typography>
                )}
              </ListItemContent>
            </ListItemButton>
          </ListItem>
        ))}
      </List>
    );
  };

  // State for viewing a specific category
  const [viewingCategory, setViewingCategory] = React.useState<string | null>(null);

  // Get category being viewed
  const currentCategory = viewingCategory ? helpIndex?.categories.find(c => c.name === viewingCategory) : null;

  // Render category view with all articles
  const renderCategoryView = () => {
    if (!currentCategory) return null;

    return (
      <Box sx={{ p: 2 }}>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 2 }}>
          <IconButton size="sm" variant="plain" onClick={() => setViewingCategory(null)}>
            <ArrowBackIcon />
          </IconButton>
          <Typography level="h4" sx={{ textTransform: 'capitalize' }}>
            {currentCategory.label}
          </Typography>
        </Box>

        <List size="sm">
          {currentCategory.entries.map(entry => (
            <ListItem key={entry.slug}>
              <ListItemButton onClick={() => navigateTo(entry.slug)}>
                <ListItemContent>
                  <Typography level="body-sm" fontWeight="md">
                    {entry.title}
                  </Typography>
                  {entry.description && (
                    <Typography level="body-xs" sx={{ color: 'text.tertiary' }}>
                      {entry.description.slice(0, 80)}
                      {entry.description.length > 80 ? '...' : ''}
                    </Typography>
                  )}
                </ListItemContent>
              </ListItemButton>
            </ListItem>
          ))}
        </List>
      </Box>
    );
  };

  // Render home page with category list
  const renderHomePage = () => {
    if (!helpIndex) return null;

    // If viewing a specific category, show that instead
    if (viewingCategory) {
      return renderCategoryView();
    }

    return (
      <Box sx={{ p: 2 }}>
        <Typography level="h3" sx={{ mb: 2 }}>
          Help Center
        </Typography>
        <Typography level="body-md" sx={{ mb: 3 }}>
          Welcome to the documentation. Browse by category or use the search above.
        </Typography>

        <RecentlyViewedList articles={recentlyViewed} onNavigate={navigateTo} />

        {helpIndex.categories.map(category => (
          <Box key={category.name} sx={{ mb: 3 }}>
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 1 }}>
              <Typography level="title-md" sx={{ textTransform: 'capitalize' }}>
                {category.label}
              </Typography>
              {category.accessLevel === 'admin' && (
                <Chip size="sm" variant="soft" color="warning">
                  Admin
                </Chip>
              )}
            </Box>
            <List size="sm">
              {category.entries.slice(0, 5).map(entry => (
                <ListItem key={entry.slug}>
                  <ListItemButton onClick={() => navigateTo(entry.slug)}>
                    <ListItemContent>
                      <Typography level="body-sm">{entry.title}</Typography>
                    </ListItemContent>
                  </ListItemButton>
                </ListItem>
              ))}
              {category.entries.length > 5 && (
                <ListItem>
                  <ListItemButton onClick={() => setViewingCategory(category.name)}>
                    <ListItemContent>
                      <Typography level="body-xs" sx={{ color: 'primary.500' }}>
                        View all {category.entries.length} articles...
                      </Typography>
                    </ListItemContent>
                  </ListItemButton>
                </ListItem>
              )}
            </List>
          </Box>
        ))}
      </Box>
    );
  };

  // Compute from subscribed state to avoid stale reads from getState()
  const canGoBack = historyIndex > 0;
  const canGoForward = historyIndex < history.length - 1;

  return (
    <Drawer
      anchor="right"
      open={open}
      onClose={close}
      slotProps={{
        content: {
          sx: {
            width: panelWidth,
            maxWidth: '100vw',
            bgcolor: 'background.surface',
          },
        },
        backdrop: {
          sx: {
            backgroundColor: 'transparent',
          },
        },
      }}
      sx={{
        // Ensure help panel appears above modals (MUI modals use z-index ~1300)
        zIndex: 1400,
        '& .MuiDrawer-content': {
          boxShadow: mode === 'dark' ? '-4px 0 20px rgba(0,0,0,0.5)' : '-4px 0 20px rgba(0,0,0,0.1)',
        },
      }}
    >
      {/* Resize handle - click or tab to focus, then use arrow keys to resize */}
      <Box
        ref={resizeRef}
        onMouseDown={handleMouseDown}
        onKeyDown={e => {
          // Only resize when this element is focused
          if (e.target !== resizeRef.current) return;
          const step = e.shiftKey ? 50 : 10;
          if (e.key === 'ArrowLeft') {
            e.preventDefault();
            e.stopPropagation();
            setPanelWidth(Math.min(MAX_PANEL_WIDTH, panelWidth + step));
          } else if (e.key === 'ArrowRight') {
            e.preventDefault();
            e.stopPropagation();
            setPanelWidth(Math.max(MIN_PANEL_WIDTH, panelWidth - step));
          }
        }}
        tabIndex={0}
        role="separator"
        aria-label="Resize help panel. Use left/right arrow keys when focused."
        aria-orientation="vertical"
        aria-valuenow={panelWidth}
        aria-valuemin={MIN_PANEL_WIDTH}
        aria-valuemax={MAX_PANEL_WIDTH}
        sx={{
          position: 'absolute',
          left: 0,
          top: 0,
          bottom: 0,
          width: '6px',
          cursor: 'col-resize',
          backgroundColor: 'transparent',
          transition: 'background-color 0.15s, width 0.15s',
          '&:hover': {
            backgroundColor: 'primary.400',
            width: '6px',
          },
          '&:focus': {
            backgroundColor: 'primary.500',
            width: '6px',
            outline: 'none',
            boxShadow: '0 0 0 2px var(--joy-palette-primary-200)',
          },
          zIndex: 1,
        }}
      />

      <Stack sx={{ height: '100%', overflow: 'hidden' }}>
        {/* Header */}
        <Box
          sx={{
            px: 1.5,
            pt: 1,
            borderBottom: '1px solid',
            borderColor: 'divider',
            display: 'flex',
            flexDirection: 'column',
            gap: 0,
          }}
        >
          {/* Top row: nav buttons + close */}
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, pb: 0.5 }}>
            {activeTab === 'help' && (
              <>
                <IconButton
                  size="sm"
                  variant="plain"
                  onClick={handleHome}
                  disabled={currentSlug === 'index' && !showSearch}
                  aria-label="Go to help home"
                >
                  <HomeIcon />
                </IconButton>

                <IconButton size="sm" variant="plain" onClick={goBack} disabled={!canGoBack} aria-label="Go back">
                  <ArrowBackIcon />
                </IconButton>

                <IconButton
                  size="sm"
                  variant="plain"
                  onClick={goForward}
                  disabled={!canGoForward}
                  aria-label="Go forward"
                >
                  <ArrowForwardIcon />
                </IconButton>
              </>
            )}

            <Box sx={{ flex: 1 }} />

            {activeTab === 'help' && (
              <IconButton
                size="sm"
                variant={showSearch ? 'soft' : 'plain'}
                onClick={() => setShowSearch(!showSearch)}
                color={showSearch ? 'primary' : 'neutral'}
                aria-label={showSearch ? 'Close search' : 'Open search'}
              >
                <SearchIcon />
              </IconButton>
            )}

            <IconButton size="sm" variant="plain" onClick={close} aria-label="Close help panel">
              <CloseIcon />
            </IconButton>
          </Box>

          {/* Tab switcher */}
          <Tabs
            value={activeTab}
            onChange={(_, val) => {
              if (val === 'shortcuts' || val === 'help') setActiveTab(val);
            }}
            sx={{ bgcolor: 'transparent' }}
          >
            <TabList
              size="sm"
              sx={{
                bgcolor: 'transparent',
                '& .MuiTab-root': { minHeight: 36, px: 2 },
              }}
            >
              <Tab value="shortcuts">
                <KeyboardIcon sx={{ fontSize: 16, mr: 0.75 }} />
                Shortcuts
              </Tab>
              <Tab value="help">
                <MenuBookIcon sx={{ fontSize: 16, mr: 0.75 }} />
                Help Center
              </Tab>
            </TabList>
          </Tabs>
        </Box>

        {/* Search bar (Help Center tab only) */}
        {activeTab === 'help' && showSearch && (
          <Box sx={{ p: 1.5, borderBottom: '1px solid', borderColor: 'divider' }}>
            <Input
              size="sm"
              placeholder="Search documentation..."
              value={searchQuery}
              onChange={e => setSearchQuery(e.target.value)}
              startDecorator={<SearchIcon />}
              autoFocus
              sx={{ width: '100%' }}
            />
          </Box>
        )}

        {/* Content area */}
        <Box sx={{ flex: 1, overflow: 'auto' }}>
          {activeTab === 'shortcuts' ? (
            <HelpContent slug="features/keyboard-shortcuts" />
          ) : indexLoading ? (
            <Box sx={{ display: 'flex', justifyContent: 'center', alignItems: 'center', height: '100%' }}>
              <CircularProgress />
            </Box>
          ) : showSearch ? (
            renderSearchResults()
          ) : currentSlug === 'index' || !currentEntry ? (
            renderHomePage()
          ) : (
            <Stack sx={{ height: '100%' }}>
              {/* Breadcrumbs + header feedback thumbs */}
              <Box sx={{ px: 2, pt: 2, display: 'flex', alignItems: 'center', gap: 1 }}>
                <Box sx={{ flex: 1 }}>
                  <HelpBreadcrumbs
                    entry={currentEntry}
                    onNavigate={navigateTo}
                    onCategoryClick={category => {
                      setViewingCategory(category);
                      navigateTo('index');
                    }}
                  />
                </Box>
                <HeaderFeedbackThumbs slug={currentSlug} />
              </Box>

              {/* Main content with TOC */}
              <Box
                sx={{
                  display: 'flex',
                  flex: 1,
                  overflow: 'hidden',
                  flexDirection: panelWidth < 500 ? 'column' : 'row',
                }}
              >
                {/* Article content */}
                <Box sx={{ flex: 1, overflow: 'auto' }}>
                  <HelpContent slug={currentSlug} anchor={currentAnchor} />
                </Box>

                {/* TOC sidebar (only show if panel is wide enough) */}
                {panelWidth >= 500 && currentEntry && currentEntry.headings.length > 0 && (
                  <>
                    <Divider orientation="vertical" />
                    <Box sx={{ width: 180, overflow: 'auto', flexShrink: 0 }}>
                      <HelpTOC headings={currentEntry.headings} currentAnchor={currentAnchor} />
                    </Box>
                  </>
                )}
              </Box>
            </Stack>
          )}
        </Box>

        {/* Horizontal drag handle between content and chat */}
        {showChatDragHandle && (
          <Box
            onPointerDown={handleChatDragPointerDown}
            data-dragging={isChatDragging}
            sx={{
              height: '8px',
              cursor: 'row-resize',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              position: 'relative',
              flexShrink: 0,
              touchAction: 'none',
              '&::before': {
                content: '""',
                position: 'absolute',
                left: 0,
                right: 0,
                top: '50%',
                transform: 'translateY(-50%)',
                height: '1px',
                backgroundColor: 'divider',
                transition: 'all 0.2s ease',
              },
              '&:hover::before, &[data-dragging="true"]::before': {
                height: '3px',
                backgroundColor: 'primary.400',
              },
            }}
          >
            <DragIndicatorIcon
              sx={{
                fontSize: '16px',
                color: isChatDragging ? 'primary.400' : 'text.tertiary',
                opacity: isChatDragging ? 1 : 0.6,
                transition: 'all 0.2s ease',
                pointerEvents: 'none',
              }}
            />
          </Box>
        )}

        {/* AI Help Chat - Admin feature flag controlled */}
        {isHelpChatEnabled && (
          <Box sx={{ height: isChatOpen ? chatHeight : 'auto', flexShrink: 0 }}>
            <HelpChat currentHelpSlug={currentSlug !== 'index' ? currentSlug : undefined} height={chatHeight} />
          </Box>
        )}
      </Stack>
    </Drawer>
  );
};

export default HelpPanel;
