import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ElementType,
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
} from 'react';
import CloseIcon from '@mui/icons-material/Close';
import DashboardIcon from '@mui/icons-material/Dashboard';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import KeyboardDoubleArrowLeftIcon from '@mui/icons-material/KeyboardDoubleArrowLeft';
import KeyboardDoubleArrowRightIcon from '@mui/icons-material/KeyboardDoubleArrowRight';
import SearchIcon from '@mui/icons-material/Search';
import { Box, Dropdown, IconButton, Input, Menu, MenuButton, MenuItem, Tooltip, Typography } from '@mui/joy';
import { adminFocus } from './shared/adminStyles';
import {
  AdminTab,
  SIDEBAR_SECTIONS,
  filterSidebarSections,
  findSectionKeyForTab,
  type SidebarGate,
  type SidebarItem,
} from './adminSidebarConfig';
import { adminTabToSlug } from './adminTabSlugs';
import { useAdminSidebarSections } from './useAdminSidebarSections';

export type SidebarNavProps = {
  /** The tab to highlight. The layout passes Users while a user profile is open. */
  activeTab: AdminTab | string | null;
  enableUserMigration?: boolean;
  showLiveOpsTriageTab: boolean;
  waitingSubscribersCount?: number;
  hiddenNotifications: string[];
  onTabSelect: (tab: AdminTab) => void;
  /** Folds the nav to an icon rail. */
  collapsed?: boolean;
  /** Omit to hide the collapse toggle (the phone drawer has nothing to collapse to). */
  onToggleCollapsed?: () => void;
  /** Shows a close button in the header; used by the phone drawer. */
  onClose?: () => void;
};

const DASHBOARD_LABEL = 'Dashboard';
const EXPANDED_WIDTH = 248;
const RAIL_WIDTH = 64;

// Every element arrow keys can move between carries this attribute; the filter box is not one of
// them, so ArrowUp off the first entry hands focus back to it explicitly.
const FOCUSABLE_ATTR = 'data-admin-nav-focusable';
const focusableProps = { [FOCUSABLE_ATTR]: '' };

// Mixed from the admin tokens so the same values hold in light and dark mode.
const HOVER_BACKGROUND = 'color-mix(in srgb, var(--joy-palette-admin-ink) 6%, transparent)';
const IDLE_INK = 'color-mix(in srgb, var(--joy-palette-admin-ink) 80%, var(--joy-palette-admin-canvas))';

const isApplePlatform = () =>
  typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);

const tabHref = (tab: AdminTab) => {
  const slug = adminTabToSlug(tab);
  return slug ? `/admin?tab=${slug}` : '/admin';
};

const navItemSx = (active: boolean) => ({
  display: 'flex',
  alignItems: 'center',
  gap: '10px',
  minHeight: 36,
  px: '10px',
  borderRadius: '8px',
  fontSize: 14,
  fontWeight: 500,
  lineHeight: 1.3,
  textDecoration: 'none',
  cursor: 'pointer',
  color: active ? 'admin.ink' : IDLE_INK,
  bgcolor: active ? 'admin.surface' : 'transparent',
  boxShadow: active ? '0 0 0 1px var(--joy-palette-admin-border)' : 'none',
  '& > svg': { fontSize: 18, flexShrink: 0, color: active ? 'admin.accent' : 'inherit' },
  '&:hover': { bgcolor: active ? 'admin.surface' : HOVER_BACKGROUND, color: 'admin.ink', textDecoration: 'none' },
  ...adminFocus,
});

const railButtonSx = (active: boolean) => ({
  width: 40,
  height: 40,
  borderRadius: '8px',
  color: active ? 'admin.accent' : IDLE_INK,
  bgcolor: active ? 'admin.surface' : 'transparent',
  boxShadow: active ? '0 0 0 1px var(--joy-palette-admin-border)' : 'none',
  '&:hover': { bgcolor: active ? 'admin.surface' : HOVER_BACKGROUND, color: 'admin.ink' },
  ...adminFocus,
});

const kbdSx = {
  fontFamily: 'code',
  fontSize: 11,
  lineHeight: 1.4,
  px: '5px',
  py: '1px',
  borderRadius: '4px',
  border: '1px solid',
  borderColor: 'admin.border',
  bgcolor: 'admin.surface',
  color: 'admin.inkMuted',
  whiteSpace: 'nowrap',
};

/** A plain left click selects in-app; modified clicks fall through so the link opens a new tab. */
const isPlainClick = (event: MouseEvent) =>
  event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey;

type NavLinkProps = {
  tab: AdminTab;
  label: string;
  Icon: ElementType;
  active: boolean;
  testid?: string;
  endDecorator?: ReactNode;
  onSelect: (tab: AdminTab) => void;
};

const NavLink = ({ tab, label, Icon, active, testid, endDecorator, onSelect }: NavLinkProps) => (
  <Box
    component="a"
    href={tabHref(tab)}
    aria-current={active ? 'page' : undefined}
    data-testid={testid}
    {...focusableProps}
    onClick={(event: MouseEvent<HTMLAnchorElement>) => {
      if (!isPlainClick(event)) return;
      event.preventDefault();
      onSelect(tab);
    }}
    sx={navItemSx(active)}
  >
    <Icon aria-hidden />
    <Box
      component="span"
      sx={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
    >
      {label}
    </Box>
    {endDecorator}
  </Box>
);

const BrandMark = () => (
  <Box
    aria-hidden
    sx={{
      width: 28,
      height: 28,
      flexShrink: 0,
      borderRadius: '8px',
      bgcolor: 'admin.ink',
      color: 'admin.canvas',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      fontWeight: 700,
      fontSize: 12,
    }}
  >
    B4
  </Box>
);

export const SidebarNav = ({
  activeTab,
  enableUserMigration,
  showLiveOpsTriageTab,
  waitingSubscribersCount,
  hiddenNotifications,
  onTabSelect,
  collapsed = false,
  onToggleCollapsed,
  onClose,
}: SidebarNavProps) => {
  const { isExpanded, toggleSection } = useAdminSidebarSections(activeTab);
  const [query, setQuery] = useState('');
  const navRef = useRef<HTMLElement>(null);
  const filterRef = useRef<HTMLInputElement>(null);
  const focusFilterOnExpand = useRef(false);
  const idPrefix = useId();
  const commandKeyHint = useMemo(() => (isApplePlatform() ? '\u2318K' : 'Ctrl K'), []);

  const gates: Record<SidebarGate, boolean> = {
    userMigration: !!enableUserMigration,
    liveOpsTriage: showLiveOpsTriageTab,
  };
  const visibleSections = filterSidebarSections(SIDEBAR_SECTIONS, gates, query);
  const filtering = query.trim() !== '';
  const showDashboard = !filtering || DASHBOARD_LABEL.toLowerCase().includes(query.trim().toLowerCase());
  const activeSectionKey = findSectionKeyForTab(activeTab);

  useEffect(() => {
    if (collapsed || !focusFilterOnExpand.current) return;
    focusFilterOnExpand.current = false;
    filterRef.current?.focus();
  }, [collapsed]);

  const waitingBadge = (item: SidebarItem): ReactNode => {
    if (
      item.badge !== 'waitingSubscribers' ||
      !waitingSubscribersCount ||
      waitingSubscribersCount <= 0 ||
      hiddenNotifications.includes('waiting-subscribers')
    ) {
      return null;
    }
    return (
      <Box
        component="span"
        aria-label={`${waitingSubscribersCount} waiting`}
        sx={{
          minWidth: 20,
          height: 20,
          px: '6px',
          borderRadius: '999px',
          fontSize: 11,
          fontWeight: 600,
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          bgcolor: 'admin.status.bad.background',
          color: 'admin.status.bad.foreground',
        }}
      >
        {waitingSubscribersCount}
      </Box>
    );
  };

  const focusables = () => Array.from(navRef.current?.querySelectorAll<HTMLElement>(`[${FOCUSABLE_ATTR}]`) ?? []);

  const handleNavKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    const items = focusables();
    const index = items.indexOf(event.target as HTMLElement);
    if (index === -1) return;
    event.preventDefault();
    if (event.key === 'ArrowUp' && index === 0 && filterRef.current) {
      filterRef.current.focus();
      return;
    }
    const last = items.length - 1;
    const next =
      event.key === 'Home'
        ? 0
        : event.key === 'End'
          ? last
          : event.key === 'ArrowDown'
            ? Math.min(index + 1, last)
            : Math.max(index - 1, 0);
    items[next]?.focus();
  };

  const handleFilterKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      focusables()[0]?.focus();
    } else if (event.key === 'Enter') {
      const firstMatch = showDashboard && filtering ? AdminTab.Dashboard : visibleSections[0]?.items[0]?.tab;
      if (!filtering || firstMatch === undefined) return;
      event.preventDefault();
      setQuery('');
      onTabSelect(firstMatch);
    } else if (event.key === 'Escape' && query !== '') {
      // Handled here so Esc clears the filter instead of also closing the phone drawer.
      event.stopPropagation();
      setQuery('');
    }
  };

  if (collapsed) {
    return (
      <Box
        component="nav"
        ref={navRef}
        aria-label="Admin"
        data-testid="admin-sidebar-nav"
        data-collapsed="true"
        onKeyDown={handleNavKeyDown}
        sx={{
          width: RAIL_WIDTH,
          height: '100%',
          boxSizing: 'border-box',
          py: '20px',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          gap: '4px',
          overflowY: 'auto',
          bgcolor: 'admin.canvas',
          borderRight: '1px solid',
          borderColor: 'admin.border',
        }}
      >
        <Box sx={{ pb: '10px' }}>
          <BrandMark />
        </Box>
        {onToggleCollapsed && (
          <Tooltip title="Expand sidebar" placement="right">
            <IconButton
              variant="plain"
              color="neutral"
              aria-label="Expand sidebar"
              data-testid="admin-sidebar-expand-btn"
              {...focusableProps}
              onClick={onToggleCollapsed}
              sx={railButtonSx(false)}
            >
              <KeyboardDoubleArrowRightIcon />
            </IconButton>
          </Tooltip>
        )}
        {onToggleCollapsed && (
          <Tooltip title="Filter pages" placement="right">
            <IconButton
              variant="plain"
              color="neutral"
              aria-label="Filter pages"
              data-testid="admin-sidebar-rail-filter-btn"
              {...focusableProps}
              onClick={() => {
                focusFilterOnExpand.current = true;
                onToggleCollapsed();
              }}
              sx={railButtonSx(false)}
            >
              <SearchIcon />
            </IconButton>
          </Tooltip>
        )}
        <Box sx={{ width: 32, my: '6px', borderTop: '1px solid', borderColor: 'admin.border' }} />
        <Tooltip title={DASHBOARD_LABEL} placement="right">
          <Box
            component="a"
            href={tabHref(AdminTab.Dashboard)}
            aria-label={DASHBOARD_LABEL}
            aria-current={activeTab === AdminTab.Dashboard ? 'page' : undefined}
            data-testid="admin-dashboard-tab-btn"
            {...focusableProps}
            onClick={(event: MouseEvent<HTMLAnchorElement>) => {
              if (!isPlainClick(event)) return;
              event.preventDefault();
              onTabSelect(AdminTab.Dashboard);
            }}
            sx={{
              ...railButtonSx(activeTab === AdminTab.Dashboard),
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            <DashboardIcon aria-hidden />
          </Box>
        </Tooltip>
        {visibleSections.map(section => {
          const { Icon: SectionIcon } = section;
          const sectionActive = section.key === activeSectionKey;
          return (
            <Dropdown key={section.key}>
              <Tooltip title={section.label} placement="right">
                <MenuButton
                  slots={{ root: IconButton }}
                  slotProps={{
                    root: {
                      variant: 'plain',
                      color: 'neutral',
                      'aria-label': section.label,
                      sx: railButtonSx(sectionActive),
                      ...focusableProps,
                    },
                  }}
                  data-testid={`admin-sidebar-rail-${section.key}-btn`}
                >
                  <SectionIcon />
                </MenuButton>
              </Tooltip>
              <Menu placement="right-start" size="sm" sx={{ minWidth: 220, zIndex: 1300 }}>
                <Typography level="body-xs" sx={{ px: 1.5, py: 0.5, fontWeight: 600, color: 'admin.inkMuted' }}>
                  {section.label}
                </Typography>
                {section.items.map(item => {
                  const { Icon: ItemIcon } = item;
                  return (
                    <MenuItem
                      key={item.tab}
                      selected={item.tab === activeTab}
                      aria-current={item.tab === activeTab ? 'page' : undefined}
                      onClick={() => onTabSelect(item.tab)}
                    >
                      <ItemIcon fontSize="small" aria-hidden />
                      {item.label}
                      {waitingBadge(item)}
                    </MenuItem>
                  );
                })}
              </Menu>
            </Dropdown>
          );
        })}
      </Box>
    );
  }

  return (
    <Box
      component="nav"
      ref={navRef}
      aria-label="Admin"
      data-testid="admin-sidebar-nav"
      data-collapsed="false"
      onKeyDown={handleNavKeyDown}
      sx={{
        width: { xs: '100%', md: EXPANDED_WIDTH },
        height: '100%',
        boxSizing: 'border-box',
        display: 'flex',
        flexDirection: 'column',
        bgcolor: 'admin.canvas',
        borderRight: { md: '1px solid' },
        borderColor: { md: 'admin.border' },
      }}
    >
      <Box sx={{ display: 'flex', alignItems: 'center', gap: '10px', px: '24px', pt: '20px', pb: '14px' }}>
        <BrandMark />
        <Typography sx={{ fontWeight: 600, fontSize: 14, color: 'admin.ink' }}>Admin</Typography>
        <Box
          component="kbd"
          title="Command palette"
          data-testid="admin-sidebar-command-hint"
          sx={{ ...kbdSx, ml: 'auto' }}
        >
          {commandKeyHint}
        </Box>
        {onToggleCollapsed && (
          <Tooltip title="Collapse sidebar" placement="right">
            <IconButton
              size="sm"
              variant="plain"
              color="neutral"
              aria-label="Collapse sidebar"
              data-testid="admin-sidebar-collapse-btn"
              onClick={onToggleCollapsed}
              sx={{ color: 'admin.inkMuted', '&:hover': { bgcolor: HOVER_BACKGROUND }, ...adminFocus }}
            >
              <KeyboardDoubleArrowLeftIcon />
            </IconButton>
          </Tooltip>
        )}
        {onClose && (
          <IconButton
            size="sm"
            variant="plain"
            color="neutral"
            aria-label="Close admin menu"
            data-testid="admin-sidebar-close-btn"
            onClick={onClose}
            sx={{ color: 'admin.inkMuted', '&:hover': { bgcolor: HOVER_BACKGROUND }, ...adminFocus }}
          >
            <CloseIcon />
          </IconButton>
        )}
      </Box>

      <Box sx={{ px: '14px', pb: '8px' }}>
        <Input
          size="sm"
          value={query}
          onChange={event => setQuery(event.target.value)}
          onKeyDown={handleFilterKeyDown}
          placeholder="Filter pages"
          startDecorator={<SearchIcon aria-hidden />}
          slotProps={{
            input: { ref: filterRef, 'aria-label': 'Filter admin pages', 'data-testid': 'admin-sidebar-filter-input' },
          }}
          sx={{
            '--Input-radius': '8px',
            '--Input-minHeight': '34px',
            bgcolor: 'admin.surface',
            borderColor: 'admin.border',
            color: 'admin.ink',
            boxShadow: 'none',
            '&:focus-within': { outline: '2px solid var(--joy-palette-admin-accent)', outlineOffset: 2 },
            '&::before': { display: 'none' },
          }}
        />
      </Box>

      <Box sx={{ flex: 1, minHeight: 0, overflowY: 'auto', px: '14px', pb: '20px' }}>
        {showDashboard && (
          <NavLink
            tab={AdminTab.Dashboard}
            label={DASHBOARD_LABEL}
            Icon={DashboardIcon}
            active={activeTab === AdminTab.Dashboard}
            testid="admin-dashboard-tab-btn"
            onSelect={onTabSelect}
          />
        )}

        {visibleSections.map(section => {
          const listId = `${idPrefix}-${section.key}`;
          const open = filtering || isExpanded(section.key);
          const holdsActiveTab = section.key === activeSectionKey;
          const sectionHeaderSx = {
            display: 'flex',
            alignItems: 'center',
            gap: '8px',
            width: '100%',
            minHeight: 30,
            mt: '14px',
            mb: '2px',
            px: '10px',
            border: 0,
            borderRadius: '6px',
            bgcolor: 'transparent',
            color: 'admin.inkMuted',
            fontFamily: 'inherit',
            fontSize: 12,
            fontWeight: 600,
            letterSpacing: '0.04em',
            textTransform: 'uppercase' as const,
            textAlign: 'left' as const,
          };
          return (
            <Box key={section.key} data-testid={`admin-sidebar-section-${section.key}`}>
              {filtering ? (
                <Box id={`${listId}-label`} sx={sectionHeaderSx}>
                  {section.label}
                </Box>
              ) : (
                <Box
                  component="button"
                  type="button"
                  id={`${listId}-label`}
                  aria-expanded={open}
                  aria-controls={listId}
                  data-testid={`admin-sidebar-section-${section.key}-btn`}
                  {...focusableProps}
                  onClick={() => toggleSection(section.key)}
                  sx={{
                    ...sectionHeaderSx,
                    cursor: 'pointer',
                    '&:hover': { color: 'admin.ink' },
                    ...adminFocus,
                  }}
                >
                  <Box component="span" sx={{ flex: 1 }}>
                    {section.label}
                  </Box>
                  {holdsActiveTab && !open && (
                    <Box
                      component="span"
                      aria-hidden
                      title="Holds the current page"
                      sx={{ width: 6, height: 6, borderRadius: '999px', bgcolor: 'admin.accent' }}
                    />
                  )}
                  <ExpandMoreIcon
                    aria-hidden
                    sx={{
                      fontSize: 18,
                      transition: 'transform 120ms ease',
                      transform: open ? 'rotate(0deg)' : 'rotate(-90deg)',
                    }}
                  />
                </Box>
              )}
              {open && (
                <Box
                  component="ul"
                  id={listId}
                  aria-labelledby={`${listId}-label`}
                  sx={{ listStyle: 'none', m: 0, p: 0, display: 'flex', flexDirection: 'column', gap: '2px' }}
                >
                  {section.items.map(item => (
                    <li key={item.tab}>
                      <NavLink
                        tab={item.tab}
                        label={item.label}
                        Icon={item.Icon}
                        active={item.tab === activeTab}
                        testid={item.testid}
                        endDecorator={waitingBadge(item)}
                        onSelect={onTabSelect}
                      />
                    </li>
                  ))}
                </Box>
              )}
            </Box>
          );
        })}

        {filtering && visibleSections.length === 0 && !showDashboard && (
          <Box data-testid="admin-sidebar-filter-empty" sx={{ px: '10px', pt: '16px' }}>
            <Typography level="body-sm" sx={{ color: 'admin.inkMuted' }}>
              No pages match &ldquo;{query.trim()}&rdquo;.
            </Typography>
            <Box
              component="button"
              type="button"
              onClick={() => {
                setQuery('');
                filterRef.current?.focus();
              }}
              sx={{
                mt: 1,
                p: 0,
                border: 0,
                bgcolor: 'transparent',
                color: 'admin.accent',
                fontFamily: 'inherit',
                fontSize: 13,
                fontWeight: 500,
                cursor: 'pointer',
                ...adminFocus,
              }}
            >
              Clear filter
            </Box>
          </Box>
        )}
      </Box>
    </Box>
  );
};
