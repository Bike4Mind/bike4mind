import { Box, Divider, Stack, Typography } from '@mui/joy';
import { useTheme } from '@mui/joy/styles';
import { useNavigate, useLocation } from '@tanstack/react-router';
import { useTranslation } from 'react-i18next';
import { Fragment, ReactNode } from 'react';
import AddIcon from '@mui/icons-material/Add';
import SmartToyOutlinedIcon from '@mui/icons-material/SmartToyOutlined';
import HubOutlinedIcon from '@mui/icons-material/HubOutlined';
import TempleBuddhistOutlinedIcon from '@mui/icons-material/TempleBuddhistOutlined';
import WaterOutlinedIcon from '@mui/icons-material/WaterOutlined';
import CastleOutlinedIcon from '@mui/icons-material/CastleOutlined';
import PublicOutlinedIcon from '@mui/icons-material/PublicOutlined';
import SettingsOutlinedIcon from '@mui/icons-material/SettingsOutlined';
import HelpCenterOutlinedIcon from '@mui/icons-material/HelpCenterOutlined';
import { canAccessTavern } from '@bike4mind/common';
import { premiumRoutes } from '@client/app/premium-generated/premiumRoutes.generated';
import { useFeatureEnabled } from '@client/app/hooks/useFeatureEnabled';
import { useAdminSettingsCache } from '@client/app/hooks/useAdminSettingsCache';
import { useUser } from '@client/app/contexts/UserContext';
import { useOptiAccess } from '@client/app/hooks/data/opti';
import { useIsMobile } from '@client/app/hooks/useIsMobile';
import { useHelpPanel, openHelpPanel } from '@client/app/hooks/useHelpPanel';
import { useGearUnlocks, type GearKey } from '@client/app/hooks/useGearsStatus';
import { useNotebookLayout } from '..';

type NavItem = {
  key: string;
  label: string;
  icon: ReactNode;
  isActive: boolean;
  onClick: () => void;
  // Renders a thin separator above this row - used to set utility items (Help)
  // apart from the workspace destinations above them.
  dividerAbove?: boolean;
};

/**
 * Primary sidebar navigation - a vertical icon list (New Chat, Agents, Projects, OptiHashi,
 * Tavern). OptiHashi/Tavern keep the same entitlement gating as the footer menu, and Agents
 * follows the `enableAgents` flag. The active row is highlighted by route. Files Manager is
 * deliberately NOT a sidenav destination - it is reachable only via the Gears page.
 */
const SidenavNav = ({ section = 'all' }: { section?: 'pinned' | 'scroll' | 'all' }) => {
  const theme = useTheme();
  const { t } = useTranslation();
  const navigate = useNavigate();
  const location = useLocation();
  const currentUser = useUser(s => s.currentUser);
  const { isFeatureEnabled } = useFeatureEnabled();
  const { isFeatureEnabled: isAdminFeatureEnabled } = useAdminSettingsCache();
  const isMobile = useIsMobile();
  const setOpenSideNav = useNotebookLayout(s => s.setOpenSideNav);

  const isAgentsEnabled = isFeatureEnabled('enableAgents');
  // Mirror the footer gating: entitlement-aware opti access (admin/developer/OptiHashi Pro, plus
  // email-domain grantees) sees OptiHashi without flipping the feature flag.
  const hasOptiAccess = useOptiAccess();
  // Visibility rides purely on product access (tag/entitlement); the legacy
  // experimental toggle was retired with the open-core carve.
  const isOptiEnabled = hasOptiAccess;
  // /tavern is a codegen-mounted premium route; builds without the overlay
  // (open core) have no such route, so the entry must hide or it dead-ends.
  const tavernRouteExists = premiumRoutes.some(route => route.path.startsWith('/tavern'));
  const isTavernEnabled = tavernRouteExists && canAccessTavern(currentUser);
  // The server gates every /api/data-lakes endpoint on the EnableDataLakes admin setting,
  // so hide the Data Lakes destination when it's off - otherwise the link lands on an
  // Explorer whose every request 403s (mirrors FileBrowser's guard).
  const isDataLakesEnabled = isAdminFeatureEnabled('EnableDataLakes');
  // Gears (earned nav): feature rows appear once the user has USED the feature -
  // the permanent rail is New Chat / Gears / Help. Unlocks are derived server-side
  // (has >=1 project, agent, lake, file, publication). While the status loads we
  // show everything (the safe default for existing users; a brand-new user sees
  // the rail settle once, on first paint only).
  const gearUnlocks = useGearUnlocks();
  // Fail OPEN unless a gear is EXPLICITLY present-and-unearned. These rows
  // (Projects, Agents, ...) were unconditional before Gears, so a loading state,
  // a catalog that omits/renames the key, or an admin override that drops it
  // must NOT silently remove core navigation app-wide - only a key the server
  // returns as `false` (a known, genuinely-unearned gear) hides its row.
  const gearOpen = (key: GearKey) => gearUnlocks === undefined || !(key in gearUnlocks) || gearUnlocks[key] === true;
  const helpOpen = useHelpPanel(s => s.open);

  const closeOnMobile = () => {
    if (isMobile) setOpenSideNav(false);
  };

  const iconSlot = (node: ReactNode) => (
    <Box
      sx={{
        width: 20,
        height: 20,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        flexShrink: 0,
        // Joy SvgIcons resolve their color from the --Icon-color CSS variable
        // (set by an ancestor), which wins over plain `color` - so set it directly.
        '--Icon-color': theme.palette.sidenav?.navItemIcon,
        color: theme.palette.sidenav?.navItemIcon,
        // Soften the nav icons: 0.75 in dark, 0.5 in light.
        opacity: theme.palette.mode === 'dark' ? 0.75 : 0.5,
      }}
    >
      {node}
    </Box>
  );

  const items: NavItem[] = [
    {
      key: 'new-chat',
      label: t('sidenav.sessions.new'),
      icon: (
        <Box
          sx={{
            width: 20,
            height: 20,
            borderRadius: '6px',
            backgroundColor: 'primary.500',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            flexShrink: 0,
          }}
        >
          <AddIcon sx={{ fontSize: '16px', color: '#fff' }} />
        </Box>
      ),
      isActive: location.pathname === '/new',
      onClick: () => {
        closeOnMobile();
        navigate({ to: '/new' });
      },
    },
    ...(isOptiEnabled
      ? [
          {
            key: 'opti',
            label: 'OptiHashi',
            icon: iconSlot(<TempleBuddhistOutlinedIcon sx={{ fontSize: '18px' }} />),
            isActive: location.pathname.startsWith('/opti'),
            onClick: () => {
              closeOnMobile();
              // @ts-expect-error - /opti is a premium route, not in static route tree
              navigate({ to: '/opti' });
            },
          },
        ]
      : []),
    // Data Lakes is a top-level destination in its OWN right - NOT nested under Opti.
    // It opens the user's own lakes (browse + manage) at /data-lakes, so a non-Opti
    // user with the feature can reach their lakes too (was previously elided when
    // Opti was off, and pointed at the Opti static-registry explorer when on).
    ...(isDataLakesEnabled && gearOpen('datalakes')
      ? [
          {
            key: 'datalakes',
            label: t('sidenav.dataLakes', 'Data Lakes'),
            icon: iconSlot(<WaterOutlinedIcon sx={{ fontSize: '18px' }} />),
            isActive: location.pathname.startsWith('/data-lakes'),
            onClick: () => {
              closeOnMobile();
              navigate({ to: '/data-lakes' });
            },
          },
        ]
      : []),
    ...(isAgentsEnabled && gearOpen('agents')
      ? [
          {
            key: 'agents',
            label: t('agents.title'),
            icon: iconSlot(<SmartToyOutlinedIcon sx={{ fontSize: '18px' }} />),
            // Active only on the overall agents grid, not a specific agent screen (/agents/:id),
            // which highlights its own row in the list below instead.
            isActive: location.pathname === '/agents',
            onClick: () => {
              closeOnMobile();
              navigate({ to: '/agents' });
            },
          },
        ]
      : []),
    ...(gearOpen('projects')
      ? [
          {
            key: 'projects',
            label: t('projects.projects'),
            // Active only on the overall projects grid, not a specific project screen
            // (/projects/:id), which highlights its own row in the list below instead.
            icon: iconSlot(<HubOutlinedIcon sx={{ fontSize: '18px' }} />),
            isActive: location.pathname === '/projects',
            onClick: () => {
              closeOnMobile();
              navigate({ to: '/projects' });
            },
          },
        ]
      : []),
    ...(gearOpen('published')
      ? [
          {
            // Live Artifacts (published shares) are the product's lead-gen surface -
            // a first-class destination instead of Profile -> Live Artifacts (3 clicks deep).
            key: 'published',
            label: t('sidenav.published', 'Live Artifacts'),
            icon: iconSlot(<PublicOutlinedIcon sx={{ fontSize: '18px' }} />),
            isActive: location.pathname === '/profile' && (location.search as { tab?: string }).tab === 'published',
            onClick: () => {
              closeOnMobile();
              navigate({ to: '/profile', search: { tab: 'published' } });
            },
          },
        ]
      : []),
    ...(isTavernEnabled
      ? [
          {
            key: 'tavern',
            label: 'Tavern',
            icon: iconSlot(<CastleOutlinedIcon sx={{ fontSize: '18px' }} />),
            isActive: location.pathname === '/tavern',
            onClick: () => {
              closeOnMobile();
              // `/tavern` is a codegen-mounted premium route (no core route file), so it
              // is not in Tanstack's statically-typed route union - same `as never` cast
              // as the /hud?tab=tavern redirect in routes/hud/index.tsx.
              navigate({ to: '/tavern' } as never);
            },
          },
        ]
      : []),
    {
      // Permanent: the discovery surface for everything the rail hasn't earned yet.
      key: 'gears',
      label: t('sidenav.gears', 'Gears'),
      icon: iconSlot(<SettingsOutlinedIcon sx={{ fontSize: '18px' }} />),
      isActive: location.pathname === '/gears',
      onClick: () => {
        closeOnMobile();
        navigate({ to: '/gears' });
      },
    },
    {
      key: 'help',
      label: t('sidenav.help', 'Help Center'),
      icon: iconSlot(<HelpCenterOutlinedIcon sx={{ fontSize: '18px' }} />),
      // The help panel is an overlay, not a route - highlight while it's open.
      isActive: helpOpen,
      onClick: () => {
        closeOnMobile();
        openHelpPanel();
      },
    },
  ];

  // Pinned vs scroll split for the unified-scroll sidebar: the first two items stay
  // pinned at the top. items[0] is always New Chat; items[1] is OptiHashi when Opti is
  // enabled, otherwise the next earned destination (the conditional Opti/Data-Lakes
  // entries shift the rest into the scroll slice). The split is purely positional, so
  // it holds either way.
  const shownItems = section === 'pinned' ? items.slice(0, 2) : section === 'scroll' ? items.slice(2) : items;

  return (
    <Stack className="notebook-sidenav-nav" sx={{ gap: '4px' }}>
      {shownItems.map(item => (
        <Fragment key={item.key}>
          {item.dividerAbove && <Divider sx={{ my: '4px', opacity: 0.6 }} />}
          <Box
            data-testid={`sidenav-nav-${item.key}`}
            role="button"
            tabIndex={0}
            aria-current={item.isActive ? 'page' : undefined}
            onClick={item.onClick}
            onKeyDown={e => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                item.onClick?.();
              }
            }}
            sx={{
              display: 'flex',
              alignItems: 'center',
              gap: '12px',
              px: '12px',
              height: '32px',
              minHeight: '32px',
              borderRadius: '8px',
              cursor: 'pointer',
              color: theme.palette.sidenav?.navItemText ?? theme.palette.text.primary,
              backgroundColor: item.isActive ? theme.palette.notebooklist.focusedBackground : 'transparent',
              transition: 'background 0.15s',
              '&:hover': {
                backgroundColor: item.isActive
                  ? theme.palette.notebooklist.focusedBackground
                  : theme.palette.notebooklist.hoverBg,
              },
              '&:focus-visible': { outline: `2px solid ${theme.palette.primary[500]}`, outlineOffset: '-2px' },
            }}
          >
            {item.icon}
            <Typography level="body-sm" sx={{ fontSize: '14px', fontWeight: 400, color: 'inherit' }} noWrap>
              {item.label}
            </Typography>
          </Box>
        </Fragment>
      ))}
    </Stack>
  );
};

export default SidenavNav;
