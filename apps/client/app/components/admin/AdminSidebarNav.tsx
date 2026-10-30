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
import { ChevronDown, Ellipsis, PanelLeftClose, PanelLeftOpen, Search, X } from 'lucide-react';
import { Avatar, Box, Chip, Dropdown, IconButton, Input, Menu, MenuButton, MenuItem, Tooltip } from '@mui/joy';
import { adminFocus, adminScrollGutter } from './shared/adminStyles';
import {
  AdminTab,
  SIDEBAR_SECTIONS,
  filterSidebarSections,
  findSectionKeyForTab,
  splitSectionItems,
  type SidebarGate,
  type SidebarItem,
} from './adminSidebarConfig';
import { adminTabToSlug } from './adminTabSlugs';
import { useAdminSidebarMore } from './useAdminSidebarState';

/** The signed-in admin shown in the sidebar footer. */
export type SidebarAccount = {
  name: string;
  role: string;
  photoUrl?: string;
};

export type SidebarNavProps = {
  /** The tab to highlight. The layout passes Users while a user profile is open. */
  activeTab: AdminTab | string | null;
  enableUserMigration?: boolean;
  showLiveOpsTriageTab: boolean;
  waitingSubscribersCount?: number;
  /** A Stripe-billed subscription started since this browser last opened the Subscriptions tab. */
  newSubscriptions?: boolean;
  hiddenNotifications: string[];
  onTabSelect: (tab: AdminTab) => void;
  account?: SidebarAccount;
  /** Folds the nav to an icon rail. */
  collapsed?: boolean;
  /** Omit to hide the collapse toggle (the phone drawer has nothing to collapse to). */
  onToggleCollapsed?: () => void;
  /** Shows a close button in the header; used by the phone drawer. */
  onClose?: () => void;
  /** A short environment name beside the brand ("Staging"), so it stays in view when the banner is not; none on production. */
  environmentLabel?: string | null;
};

const EXPANDED_WIDTH = 248;
const RAIL_WIDTH = 64;

// Every element arrow keys can move between carries this attribute; the filter box is not one of
// them, so ArrowUp off the first entry hands focus back to it explicitly.
const FOCUSABLE_ATTR = 'data-admin-nav-focusable';
const focusableProps = { [FOCUSABLE_ATTR]: '' };

/**
 * DESIGN_GUIDE.md tokens the admin palette does not define yet. Each reads the palette variable
 * first and falls back to a mix of the existing ones, so it is right in light and dark mode today
 * and picks up the real token once the skin adds it.
 */
const tokens = {
  inkSecondary:
    'var(--joy-palette-admin-inkSecondary, color-mix(in srgb, var(--joy-palette-admin-ink) 80%, var(--joy-palette-admin-canvas)))',
  hover:
    'var(--joy-palette-admin-hover, color-mix(in srgb, var(--joy-palette-admin-ink) 6%, var(--joy-palette-admin-canvas)))',
  borderStrong:
    'var(--joy-palette-admin-borderStrong, color-mix(in srgb, var(--joy-palette-admin-ink) 12%, var(--joy-palette-admin-border)))',
};

const ICON_SIZE = 16;
const ICON_STROKE = 2;

const isApplePlatform = () =>
  typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);

const isEditableTarget = (target: EventTarget | null) =>
  target instanceof HTMLElement && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName));

const tabHref = (tab: AdminTab) => {
  const slug = adminTabToSlug(tab);
  return slug ? `/admin?tab=${slug}` : '/admin';
};

/** A plain left click selects in-app; modified clicks fall through so the link opens a new tab. */
const isPlainClick = (event: MouseEvent) =>
  event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey;

/** Only a label that actually got cut off earns a tooltip; set on hover, when layout is known. */
const titleIfTruncated = (event: MouseEvent<HTMLElement>) => {
  const label = event.currentTarget.querySelector<HTMLElement>('[data-nav-label]');
  if (!label) return;
  event.currentTarget.title = label.scrollWidth > label.clientWidth ? (label.textContent ?? '') : '';
};

const rowSx = {
  display: 'flex',
  alignItems: 'center',
  gap: '10px',
  width: '100%',
  height: 36,
  px: '10px',
  boxSizing: 'border-box',
  borderRadius: '8px',
  border: 0,
  fontFamily: 'inherit',
  fontSize: 14,
  fontWeight: 500,
  lineHeight: '20px',
  textAlign: 'left',
  textDecoration: 'none',
  cursor: 'pointer',
  '& > svg': { flexShrink: 0 },
  ...adminFocus,
} as const;

const navItemSx = (active: boolean) => ({
  ...rowSx,
  color: active ? 'admin.ink' : tokens.inkSecondary,
  bgcolor: active ? 'admin.surface' : 'transparent',
  boxShadow: active ? '0 0 0 1px var(--joy-palette-admin-border)' : 'none',
  '& > svg': { flexShrink: 0, color: active ? 'admin.ink' : 'admin.inkMuted' },
  '&:hover': {
    bgcolor: active ? 'admin.surface' : tokens.hover,
    color: 'admin.ink',
    textDecoration: 'none',
    '& > svg': { color: 'admin.ink' },
  },
});

const iconButtonSx = (active = false) => ({
  width: 36,
  height: 36,
  minHeight: 36,
  borderRadius: '8px',
  color: active ? 'admin.ink' : 'admin.inkMuted',
  bgcolor: active ? 'admin.surface' : 'transparent',
  boxShadow: active ? '0 0 0 1px var(--joy-palette-admin-border)' : 'none',
  '&:hover': { bgcolor: active ? 'admin.surface' : tokens.hover, color: 'admin.ink' },
  ...adminFocus,
});

const kbdSx = {
  fontFamily: 'code',
  fontSize: 11,
  lineHeight: '16px',
  px: '5px',
  borderRadius: '4px',
  border: '1px solid',
  borderColor: tokens.borderStrong,
  bgcolor: 'admin.surface',
  color: 'admin.inkMuted',
  whiteSpace: 'nowrap',
};

// The thumb shows only while the pointer or focus is in the list, so a long nav does not wear a permanent scrollbar.
const quietScrollSx = {
  overflowY: 'auto',
  overscrollBehavior: 'contain',
  ...adminScrollGutter,
} as const;

// The size goes in an inline style too: app-wide svg rules otherwise beat lucide's width attribute.
const NavIcon = ({ Icon, size = ICON_SIZE, rotate }: { Icon: ElementType; size?: number; rotate?: boolean }) => (
  <Icon
    size={size}
    strokeWidth={ICON_STROKE}
    aria-hidden
    focusable="false"
    style={{ width: size, height: size, flexShrink: 0, transform: rotate ? 'rotate(180deg)' : undefined }}
  />
);

type NavLinkProps = {
  item: SidebarItem;
  active: boolean;
  endDecorator?: ReactNode;
  onSelect: (tab: AdminTab) => void;
};

const NavLink = ({ item, active, endDecorator, onSelect }: NavLinkProps) => (
  <Box
    component="a"
    href={tabHref(item.tab)}
    aria-current={active ? 'page' : undefined}
    data-testid={item.testid}
    {...focusableProps}
    onMouseEnter={titleIfTruncated}
    onClick={(event: MouseEvent<HTMLAnchorElement>) => {
      if (!isPlainClick(event)) return;
      event.preventDefault();
      onSelect(item.tab);
    }}
    sx={navItemSx(active)}
  >
    <NavIcon Icon={item.Icon} />
    <Box
      component="span"
      data-nav-label=""
      sx={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
    >
      {item.label}
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
      letterSpacing: '-0.01em',
    }}
  >
    B4
  </Box>
);

const AccountAvatar = ({ account }: { account: SidebarAccount }) => (
  <Avatar
    src={account.photoUrl || undefined}
    alt=""
    sx={{
      '--Avatar-size': '24px',
      flexShrink: 0,
      fontSize: 11,
      fontWeight: 600,
      bgcolor: tokens.hover,
      color: 'admin.ink',
    }}
  >
    {account.name.trim().charAt(0).toUpperCase()}
  </Avatar>
);

const SectionLabel = ({ id, children }: { id: string; children: ReactNode }) => (
  <Box
    id={id}
    sx={{
      px: '10px',
      pt: '20px',
      pb: '6px',
      fontSize: 12,
      fontWeight: 500,
      lineHeight: '16px',
      color: 'admin.inkMuted',
    }}
  >
    {children}
  </Box>
);

export const SidebarNav = ({
  activeTab,
  enableUserMigration,
  showLiveOpsTriageTab,
  waitingSubscribersCount,
  newSubscriptions = false,
  hiddenNotifications,
  onTabSelect,
  account,
  collapsed = false,
  onToggleCollapsed,
  onClose,
  environmentLabel,
}: SidebarNavProps) => {
  const { isMoreOpen, toggleMore } = useAdminSidebarMore();
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
  // The rail has no filter box to show or clear a query, so it always lists every section.
  const visibleSections = filterSidebarSections(SIDEBAR_SECTIONS, gates, collapsed ? '' : query);
  const filtering = query.trim() !== '';
  const activeSectionKey = findSectionKeyForTab(activeTab);

  useEffect(() => {
    if (collapsed || !focusFilterOnExpand.current) return;
    focusFilterOnExpand.current = false;
    filterRef.current?.focus();
  }, [collapsed]);

  // "/" focuses the filter from anywhere in the admin, unless the admin is typing somewhere.
  useEffect(() => {
    if (collapsed) return;
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.defaultPrevented || event.key !== '/' || event.metaKey || event.ctrlKey || event.altKey) return;
      if (isEditableTarget(event.target) || !filterRef.current?.offsetParent) return;
      event.preventDefault();
      filterRef.current.focus();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [collapsed]);

  const itemBadge = (item: SidebarItem): ReactNode => {
    if (item.badge === 'newSubscriptions') {
      return newSubscriptions ? (
        <Box
          component="span"
          role="img"
          aria-label="New subscriptions since your last visit"
          data-testid="admin-sidebar-new-subscriptions-dot"
          sx={{ width: 8, height: 8, flexShrink: 0, borderRadius: '50%', bgcolor: 'admin.status.bad.foreground' }}
        />
      ) : null;
    }
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
        aria-label={`${waitingSubscribersCount} waiting for an invite`}
        title={`${waitingSubscribersCount} waiting for an invite`}
        sx={{
          minWidth: 20,
          height: 20,
          px: '6px',
          boxSizing: 'border-box',
          borderRadius: '999px',
          fontSize: 11,
          fontWeight: 600,
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          bgcolor: 'admin.status.neutral.background',
          color: 'admin.status.neutral.foreground',
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
      const firstMatch = visibleSections[0]?.items[0]?.tab;
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

  const collapseButton = onToggleCollapsed && (
    <Tooltip title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'} placement="right">
      <IconButton
        variant="plain"
        color="neutral"
        aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
        data-testid={collapsed ? 'admin-sidebar-expand-btn' : 'admin-sidebar-collapse-btn'}
        {...(collapsed ? focusableProps : {})}
        onClick={onToggleCollapsed}
        sx={{ ...iconButtonSx(), width: 28, height: 28, minHeight: 28, minWidth: 28 }}
      >
        {collapsed ? <NavIcon Icon={PanelLeftOpen} /> : <NavIcon Icon={PanelLeftClose} />}
      </IconButton>
    </Tooltip>
  );

  const navFrameSx = {
    height: '100%',
    boxSizing: 'border-box',
    display: 'flex',
    flexDirection: 'column',
    bgcolor: 'admin.canvas',
    color: tokens.inkSecondary,
  } as const;

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
          ...navFrameSx,
          width: RAIL_WIDTH,
          alignItems: 'center',
          pt: '20px',
          borderRight: '1px solid',
          borderColor: 'admin.border',
        }}
      >
        <Box sx={{ pt: '4px', pb: '18px' }}>
          <BrandMark />
        </Box>
        <Box
          sx={{
            ...quietScrollSx,
            flex: 1,
            minHeight: 0,
            width: '100%',
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            gap: '4px',
          }}
        >
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
                sx={iconButtonSx()}
              >
                <NavIcon Icon={Search} />
              </IconButton>
            </Tooltip>
          )}
          {visibleSections.map(section => {
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
                        sx: iconButtonSx(sectionActive),
                        ...focusableProps,
                      },
                    }}
                    data-testid={`admin-sidebar-rail-${section.key}-btn`}
                  >
                    <NavIcon Icon={section.Icon} />
                  </MenuButton>
                </Tooltip>
                <Menu
                  placement="right-start"
                  // Clear the rail's right edge instead of overlapping it.
                  modifiers={[{ name: 'offset', options: { offset: [-6, 14] } }]}
                  size="sm"
                  sx={{
                    minWidth: 220,
                    zIndex: 1300,
                    p: '6px',
                    borderRadius: '12px',
                    bgcolor: 'admin.surface',
                    borderColor: 'admin.border',
                    boxShadow: '0 8px 24px rgba(0, 0, 0, 0.08)',
                  }}
                >
                  <Box
                    sx={{ px: '10px', pt: '4px', pb: '6px', fontSize: 12, fontWeight: 500, color: 'admin.inkMuted' }}
                  >
                    {section.label}
                  </Box>
                  {section.items.map(item => {
                    const active = item.tab === activeTab;
                    return (
                      <MenuItem
                        key={item.tab}
                        aria-current={active ? 'page' : undefined}
                        onClick={() => onTabSelect(item.tab)}
                        sx={{ ...navItemSx(active), minHeight: 36, gap: '10px' }}
                      >
                        <NavIcon Icon={item.Icon} />
                        <Box component="span" sx={{ flex: 1 }}>
                          {item.label}
                        </Box>
                        {itemBadge(item)}
                      </MenuItem>
                    );
                  })}
                </Menu>
              </Dropdown>
            );
          })}
        </Box>
        <Box sx={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '10px', py: '14px' }}>
          {collapseButton}
          {account && (
            <Tooltip title={`${account.name} \u00B7 ${account.role}`} placement="right">
              <Box data-testid="admin-sidebar-account">
                <AccountAvatar account={account} />
              </Box>
            </Tooltip>
          )}
        </Box>
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
        ...navFrameSx,
        width: { xs: '100%', md: EXPANDED_WIDTH },
        borderRight: { md: '1px solid' },
        borderColor: { md: 'admin.border' },
      }}
    >
      <Box sx={{ px: '14px', pt: '20px' }}>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: '10px', px: '10px', pt: '4px', pb: '18px' }}>
          <BrandMark />
          <Box sx={{ fontWeight: 600, fontSize: 14, lineHeight: '20px', color: 'admin.ink' }}>Admin</Box>
          {environmentLabel && (
            <Chip size="sm" variant="soft" color="neutral" data-testid="admin-sidebar-environment-chip">
              {environmentLabel}
            </Chip>
          )}
          <Box
            component="kbd"
            title="Command palette"
            data-testid="admin-sidebar-command-hint"
            sx={{ ...kbdSx, ml: 'auto' }}
          >
            {commandKeyHint}
          </Box>
          {onClose && (
            <IconButton
              variant="plain"
              color="neutral"
              aria-label="Close admin menu"
              data-testid="admin-sidebar-close-btn"
              onClick={onClose}
              sx={{ ...iconButtonSx(), width: 28, height: 28, minHeight: 28, minWidth: 28, mr: '-6px' }}
            >
              <NavIcon Icon={X} />
            </IconButton>
          )}
        </Box>
        <Input
          value={query}
          onChange={event => setQuery(event.target.value)}
          onKeyDown={handleFilterKeyDown}
          placeholder="Filter pages"
          startDecorator={<NavIcon Icon={Search} size={14} />}
          endDecorator={
            filtering ? undefined : (
              <Box component="kbd" aria-hidden sx={kbdSx}>
                /
              </Box>
            )
          }
          slotProps={{
            input: { ref: filterRef, 'aria-label': 'Filter admin pages', 'data-testid': 'admin-sidebar-filter-input' },
          }}
          sx={{
            '--Input-radius': '8px',
            '--Input-minHeight': '32px',
            '--Input-paddingInline': '10px',
            '--Input-gap': '8px',
            '--Input-decoratorChildHeight': '20px',
            fontSize: 13,
            bgcolor: 'admin.surface',
            border: '1px solid',
            borderColor: tokens.borderStrong,
            color: 'admin.ink',
            boxShadow: 'none',
            '& input::placeholder': { color: 'admin.inkMuted', opacity: 1 },
            '& .MuiInput-startDecorator': { color: 'admin.inkMuted' },
            '&:hover': { borderColor: tokens.borderStrong },
          }}
        />
      </Box>

      <Box sx={{ ...quietScrollSx, flex: 1, minHeight: 0, px: '14px', pt: '2px', pb: '16px' }}>
        {visibleSections.map(section => {
          const labelId = `${idPrefix}-${section.key}`;
          const moreOpen = filtering || isMoreOpen(section.key);
          const { shown, hiddenCount } = splitSectionItems(section.items, activeTab, moreOpen);
          const canCollapseAgain =
            !filtering && moreOpen && splitSectionItems(section.items, activeTab, false).hiddenCount > 0;
          return (
            <Box key={section.key} component="section" data-testid={`admin-sidebar-section-${section.key}`}>
              <SectionLabel id={labelId}>{section.label}</SectionLabel>
              <Box
                component="ul"
                aria-labelledby={labelId}
                sx={{ listStyle: 'none', m: 0, p: 0, display: 'flex', flexDirection: 'column', gap: '2px' }}
              >
                {shown.map(item => (
                  <li key={item.tab}>
                    <NavLink
                      item={item}
                      active={item.tab === activeTab}
                      endDecorator={itemBadge(item)}
                      onSelect={onTabSelect}
                    />
                  </li>
                ))}
                {(hiddenCount > 0 || canCollapseAgain) && (
                  <li>
                    <Box
                      component="button"
                      type="button"
                      aria-expanded={moreOpen}
                      data-testid={`admin-sidebar-more-${section.key}-btn`}
                      {...focusableProps}
                      onClick={() => toggleMore(section.key)}
                      sx={{
                        ...navItemSx(false),
                        color: 'admin.inkMuted',
                      }}
                    >
                      {moreOpen ? <NavIcon Icon={ChevronDown} rotate /> : <NavIcon Icon={Ellipsis} />}
                      <Box component="span" sx={{ flex: 1 }}>
                        {moreOpen ? 'Less' : 'More'}
                      </Box>
                      {!moreOpen && (
                        <Box component="span" sx={{ fontSize: 12, color: 'admin.inkMuted' }}>
                          {hiddenCount}
                        </Box>
                      )}
                    </Box>
                  </li>
                )}
              </Box>
            </Box>
          );
        })}

        {filtering && visibleSections.length === 0 && (
          <Box data-testid="admin-sidebar-filter-empty" sx={{ px: '10px', pt: '20px' }}>
            <Box sx={{ fontSize: 13, color: 'admin.inkMuted' }}>No pages match &ldquo;{query.trim()}&rdquo;.</Box>
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
                color: 'var(--joy-palette-admin-link, var(--joy-palette-admin-accent))',
                fontFamily: 'inherit',
                fontSize: 13,
                fontWeight: 500,
                cursor: 'pointer',
                '&:hover': { textDecoration: 'underline' },
                ...adminFocus,
              }}
            >
              Clear filter
            </Box>
          </Box>
        )}
      </Box>

      {(account || onToggleCollapsed) && (
        <Box
          sx={{
            display: 'flex',
            alignItems: 'center',
            gap: '10px',
            mx: '14px',
            px: '10px',
            py: '12px',
            borderTop: '1px solid',
            borderColor: 'admin.border',
          }}
        >
          {account && (
            <Box
              data-testid="admin-sidebar-account"
              sx={{ display: 'flex', alignItems: 'center', gap: '10px', flex: 1, minWidth: 0 }}
            >
              <AccountAvatar account={account} />
              <Box sx={{ minWidth: 0, lineHeight: '16px' }}>
                <Box
                  sx={{
                    fontSize: 13,
                    fontWeight: 500,
                    color: 'admin.ink',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  }}
                >
                  {account.name}
                </Box>
                <Box sx={{ fontSize: 12, color: 'admin.inkMuted' }}>{account.role}</Box>
              </Box>
            </Box>
          )}
          <Box sx={{ ml: 'auto' }}>{collapseButton}</Box>
        </Box>
      )}
    </Box>
  );
};
