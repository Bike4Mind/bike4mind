import { useMemo, useState, type ElementType, type ReactNode } from 'react';
import { Link } from '@tanstack/react-router';
import { Box, IconButton, Stack, Tooltip, Typography } from '@mui/joy';
import PushPinIcon from '@mui/icons-material/PushPin';
import PushPinOutlinedIcon from '@mui/icons-material/PushPinOutlined';
import DashboardCustomizeOutlinedIcon from '@mui/icons-material/DashboardCustomizeOutlined';
import { premiumRoutes } from '@client/app/premium-generated/premiumRoutes.generated';
import { useUser } from '@client/app/contexts/UserContext';
import { adminTabFromSlug } from '../adminTabSlugs';
import { AdminTab } from '../adminSidebarConfig';
import { adminSurface } from '../shared/adminStyles';
import { MAX_PINNED_PAGES, mostVisitedSlugs, useAdminPageUsage, useAdminPageVisits } from './adminPageVisits';
import { sidebarItemForTab } from './dashboardNav';

const MOST_VISITED_LIMIT = 6;

type TabShortcut = { kind: 'tab'; slug: string; tab: AdminTab; label: string; Icon: ElementType; pinned: boolean };
type DashboardShortcut = { kind: 'dashboard'; path: string; label: string; description: string };

function useTabShortcuts(canOpenTab: (tab: AdminTab) => boolean): TabShortcut[] {
  const userId = useUser(state => state.currentUser?.id);
  const usage = useAdminPageUsage(userId);
  // Ranking is fixed at mount; decay over the minutes a page stays open would not change the order.
  const [now] = useState(() => Date.now());
  return useMemo(() => {
    const toShortcut = (slug: string, pinned: boolean): TabShortcut[] => {
      const tab = adminTabFromSlug(slug);
      const item = tab === undefined ? undefined : sidebarItemForTab(tab);
      if (tab === undefined || !item || tab === AdminTab.Dashboard || !canOpenTab(tab)) return [];
      return [{ kind: 'tab', slug, tab, label: item.label, Icon: item.Icon, pinned }];
    };
    // Rank every tracked page, then cut, so pages the viewer cannot open do not use up the row.
    const visited = mostVisitedSlugs(usage, now, Number.POSITIVE_INFINITY).flatMap(slug => toShortcut(slug, false));
    return [...usage.pins.flatMap(slug => toShortcut(slug, true)), ...visited.slice(0, MOST_VISITED_LIMIT)];
  }, [usage, canOpenTab, now]);
}

const dashboardShortcuts: DashboardShortcut[] = premiumRoutes.flatMap(route =>
  route.adminDashboard ? [{ kind: 'dashboard' as const, path: route.path, ...route.adminDashboard }] : []
);

const tileSx = {
  ...adminSurface,
  borderWidth: 1,
  borderStyle: 'solid',
  borderRadius: 'md',
  display: 'flex',
  alignItems: 'center',
  gap: 1,
  minWidth: 0,
  pl: 1.5,
  pr: 0.5,
  py: 1,
} as const;

function ShortcutBody({ Icon, label, caption }: { Icon: ElementType; label: string; caption: ReactNode }) {
  return (
    <Stack direction="row" gap={1} alignItems="center" sx={{ minWidth: 0, flex: 1 }}>
      <Icon fontSize="small" />
      <Box sx={{ minWidth: 0 }}>
        <Typography level="title-sm" noWrap>
          {label}
        </Typography>
        <Typography level="body-xs" noWrap sx={{ color: 'admin.inkMuted' }}>
          {caption}
        </Typography>
      </Box>
    </Stack>
  );
}

/**
 * Pinned admin pages, then the most visited ones, then dashboards contributed by installed features.
 * Usage is kept per admin in this browser (see adminPageVisits.ts).
 */
export function JumpBackIn({
  onNavigate,
  canOpenTab,
}: {
  onNavigate: (tab: AdminTab) => void;
  canOpenTab: (tab: AdminTab) => boolean;
}) {
  const userId = useUser(state => state.currentUser?.id);
  const togglePin = useAdminPageVisits(state => state.togglePin);
  const tabs = useTabShortcuts(canOpenTab);
  const shownPins = useMemo(() => new Set(tabs.filter(tab => tab.pinned).map(tab => tab.slug)), [tabs]);
  const pinCount = shownPins.size;

  if (tabs.length === 0 && dashboardShortcuts.length === 0) {
    return (
      <Typography level="body-sm" sx={{ color: 'admin.inkMuted' }} data-testid="admin-dashboard-jump-empty">
        Pages you open from the sidebar show up here. Pin one to keep it at the front.
      </Typography>
    );
  }

  return (
    <Box
      data-testid="admin-dashboard-jump"
      sx={{ display: 'grid', gap: 1, gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))' }}
    >
      {tabs.map(shortcut => {
        const pinDisabled = !shortcut.pinned && pinCount >= MAX_PINNED_PAGES;
        const pinLabel = shortcut.pinned ? `Unpin ${shortcut.label}` : `Pin ${shortcut.label}`;
        return (
          <Box key={shortcut.slug} sx={tileSx}>
            <Box
              component="button"
              type="button"
              onClick={() => onNavigate(shortcut.tab)}
              data-testid={`admin-dashboard-jump-${shortcut.slug}`}
              sx={{ all: 'unset', cursor: 'pointer', flex: 1, minWidth: 0, color: 'admin.ink' }}
            >
              <ShortcutBody
                Icon={shortcut.Icon}
                label={shortcut.label}
                caption={shortcut.pinned ? 'Pinned' : 'Visited often'}
              />
            </Box>
            <Tooltip title={pinDisabled ? `Up to ${MAX_PINNED_PAGES} pages can be pinned` : pinLabel}>
              <span>
                <IconButton
                  size="sm"
                  variant="plain"
                  color="neutral"
                  aria-label={pinLabel}
                  aria-pressed={shortcut.pinned}
                  disabled={pinDisabled || !userId}
                  onClick={() => userId && togglePin(userId, shortcut.slug, pin => shownPins.has(pin))}
                  data-testid={`admin-dashboard-pin-${shortcut.slug}`}
                >
                  {shortcut.pinned ? <PushPinIcon fontSize="small" /> : <PushPinOutlinedIcon fontSize="small" />}
                </IconButton>
              </span>
            </Tooltip>
          </Box>
        );
      })}
      {dashboardShortcuts.map(dashboard => (
        <Box
          key={dashboard.path}
          component={Link}
          to={dashboard.path}
          aria-label={`Open ${dashboard.label}`}
          title={dashboard.description}
          data-testid="admin-dashboard-extension-link"
          sx={{ ...tileSx, pr: 1.5, textDecoration: 'none', color: 'admin.ink' }}
        >
          <ShortcutBody Icon={DashboardCustomizeOutlinedIcon} label={dashboard.label} caption="Dashboard" />
        </Box>
      ))}
    </Box>
  );
}
