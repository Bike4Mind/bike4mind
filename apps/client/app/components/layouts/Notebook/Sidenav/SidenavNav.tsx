import { Box, Chip, Divider, Dropdown, Menu, MenuButton, MenuItem, Typography } from '@mui/joy';
import { useTheme, type Theme } from '@mui/joy/styles';
import { useNavigate, useLocation } from '@tanstack/react-router';
import { useTranslation } from 'react-i18next';
import { Fragment, ReactNode, useEffect, useRef, useState } from 'react';
import FolderSharedIcon from '@mui/icons-material/FolderSharedOutlined';
import SmartToyOutlinedIcon from '@mui/icons-material/SmartToyOutlined';
import HubOutlinedIcon from '@mui/icons-material/HubOutlined';
import TempleBuddhistOutlinedIcon from '@mui/icons-material/TempleBuddhistOutlined';
import GroupsOutlinedIcon from '@mui/icons-material/GroupsOutlined';
import CastleOutlinedIcon from '@mui/icons-material/CastleOutlined';
import Diversity3OutlinedIcon from '@mui/icons-material/Diversity3Outlined';
import AccountTreeOutlinedIcon from '@mui/icons-material/AccountTreeOutlined';
import AutoAwesomeOutlinedIcon from '@mui/icons-material/AutoAwesomeOutlined';
import PublicOutlinedIcon from '@mui/icons-material/PublicOutlined';
import StorefrontOutlinedIcon from '@mui/icons-material/StorefrontOutlined';
import SettingsOutlinedIcon from '@mui/icons-material/SettingsOutlined';
import PermMediaOutlinedIcon from '@mui/icons-material/PermMediaOutlined';
import ExtensionOutlinedIcon from '@mui/icons-material/ExtensionOutlined';
import FormatListBulletedIcon from '@mui/icons-material/FormatListBulleted';
import ChevronLeftIcon from '@mui/icons-material/ChevronLeft';
import { canAccessTavern, FirstRunEvents } from '@bike4mind/common';
import { premiumRoutes } from '@client/app/premium-generated/premiumRoutes.generated';
import { premiumNavItems } from '@client/app/premium-generated/premiumNavItems.generated';
import { filterVisiblePremiumNavItems } from '@client/app/utils/premiumNav';
import { useEntitlements } from '@client/app/hooks/data/entitlements';
import { useFeatureEnabled } from '@client/app/hooks/useFeatureEnabled';
import { useUser } from '@client/app/contexts/UserContext';
import { useOptiVisible } from '@client/app/hooks/data/opti';
import { useMeetingsAccess } from '@client/app/hooks/data/meetings';
import { useFileBrowser } from '@client/app/components/Files/Browser';
import { useIsMobile } from '@client/app/hooks/useIsMobile';
import { useGearsNavSignal } from '@client/app/hooks/useVisibleGears';
import { firstUsableStudioModality } from '@client/app/components/Studio/studioModality';
import { useAudioProviders } from '@client/app/hooks/data/audioProviders';
import { useMusicModels } from '@client/app/hooks/data/musicGenerations';
import { useVideoModels } from '@client/app/hooks/data/videoGenerations';
import { neutralFrame, rewardGreen } from '@client/app/components/common/gearRewardStyles';
import { gray } from '@client/app/utils/themes/colors';
import { useNotebookLayout } from '..';
import { useLogEvent } from '@client/app/hooks/data/analytics';
import { claimFirstRunImpression } from '@client/app/utils/firstRunImpression';
import { menuItemListSx, menuRowSx, menuSurfaceSx } from './menuSurfaceSx';
import { NavIcon, NewActionIcon, SIDENAV, SidenavNavRow, SidenavNavStack, navLabelSx, navRowSx } from './kit';

/** Rows kept at the top in the unified-scroll sidebar's pinned section. */
const PINNED_COUNT = 2;
/** Past this many rows, the lowest-priority ones fold into a More menu; More counts toward it. */
const MAX_NAV_ROWS = 8;

/** Shared by the tags on the right of a row: labels, not controls - the row
 *  under them is what gets clicked. */
const navTagSx = {
  '--Chip-minHeight': `${SIDENAV.tagHeight}px`,
  // 13px, as on the Gears page's credit chips.
  fontSize: '13px',
  pointerEvents: 'none',
} as const;

/**
 * Start here: the Gears page's neutral marker in dark mode. In light mode that
 * tint vanishes on the active row's blue wash, so it gets a white fill and the
 * theme's solid light border instead - the same white the Gears cards use.
 */
const startHereTagSx = (theme: Theme) =>
  theme.palette.mode === 'dark'
    ? { ...neutralFrame(theme), color: theme.palette.text.primary }
    : {
        backgroundColor: gray[0],
        border: `1px solid ${theme.palette.border.light}`,
        color: theme.palette.text.primary,
      };

type NavItem = {
  key: string;
  label: string;
  icon: ReactNode;
  isActive: boolean;
  onClick: () => void;
  // Renders a thin separator above this row, to set a utility item apart from the
  // workspace destinations above it.
  dividerAbove?: boolean;
  // Pinned to the row's right edge.
  trailing?: ReactNode;
  // Lower stays in the nav longer once rows overflow MAX_NAV_ROWS; ties fold in display order.
  priority: number;
};

/**
 * Primary sidebar navigation - a vertical icon list (New Chat, Files Manager, Agents, Projects,
 * OptiHashi, Tavern). OptiHashi/Tavern keep the same entitlement gating as the footer menu, and
 * Agents follows the `enableAgents` flag. The active row is highlighted by route (Files Manager
 * by the file-browser drawer's open state, since it isn't a route).
 */
const SidenavNav = ({ section = 'all' }: { section?: 'pinned' | 'scroll' | 'all' }) => {
  const theme = useTheme();
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const location = useLocation();
  const currentUser = useUser(s => s.currentUser);
  const { isFeatureEnabled } = useFeatureEnabled();
  const { open: fileBrowserOpen, setOpen: setFileBrowserOpen } = useFileBrowser();
  const isMobile = useIsMobile();
  const setOpenSideNav = useNotebookLayout(s => s.setOpenSideNav);
  const { mutate: logEvent } = useLogEvent();
  const startHereShownRef = useRef(false);
  const [moreOpen, setMoreOpen] = useState(false);

  const isAgentsEnabled = isFeatureEnabled('enableAgents');
  // Mirror the footer gating: entitlement-aware opti access (admin/developer/OptiHashi Pro, plus
  // email-domain grantees) sees OptiHashi without flipping the feature flag, unless the user hid
  // the workspace in Settings (display only; /opti itself stays reachable).
  const isOptiEnabled = useOptiVisible();
  // /meetings is a codegen-mounted premium route. The hook folds the route-exists check in
  // with product access, so an open-core build has no row and no dead-end.
  const isMeetingsEnabled = useMeetingsAccess();
  // /tavern is a codegen-mounted premium route; builds without the overlay
  // (open core) have no such route, so the entry must hide or it dead-ends.
  const tavernRouteExists = premiumRoutes.some(route => route.path.startsWith('/tavern'));
  const isTavernEnabled = tavernRouteExists && canAccessTavern(currentUser);
  // Bob (premium overlay) is a codegen-mounted `/bob` route contributed as a
  // premium nav item. Surface it in the main sidebar only when the overlay contributes it
  // AND the user's entitlements make it visible - reusing filterVisiblePremiumNavItems so the
  // gate matches ProfileMenu's source (STRICT: no admin/developer bypass) and open-core builds
  // (no overlay -> empty premiumNavItems) hide the row instead of dead-ending on a missing route.
  const { data: entitlements } = useEntitlements();
  const visibleNavItems = filterVisiblePremiumNavItems(premiumNavItems, entitlements, currentUser?.tags);
  const bobNavItem = visibleNavItems.find(item => item.path === '/bob');
  // The row uses the icon the overlay contributes with its nav item (the same one ProfileMenu
  // renders), falling back to a stock glyph when it contributes none.
  const BobIcon = bobNavItem?.icon;
  // Nav items an overlay opts into the sidebar (`sidebar: true`), under the same STRICT gate as Bob
  // and drawn the same way. Bob keeps its dedicated row, so its path is skipped rather than drawn twice.
  // Keyed by path, prefixed so a contributed row can never collide with a core row's key or test id.
  // Paths that differ only in punctuation map to one key, so the first such item wins rather than
  // two rows sharing a React key and a test id.
  const sidebarNavItems = visibleNavItems
    .filter(item => item.sidebar && item.path !== '/bob')
    .map(item => ({ item, key: `premium${item.path.replace(/[^a-z0-9]+/gi, '-')}` }))
    .filter(({ key }, index, all) => all.findIndex(other => other.key === key) === index);
  // Gears no longer gates navigation. A feature's row is always present; the gear
  // still pays its one-time credit reward on first use, but discovery must not
  // depend on having already discovered it - Hearth was only reachable from the
  // Gears page, so its row could never appear on its own.

  const gearsSignal = useGearsNavSignal();
  useEffect(() => {
    if (section === 'pinned' || !gearsSignal.startHere || gearsSignal.claimableCount > 0 || startHereShownRef.current) {
      return;
    }
    startHereShownRef.current = true;
    if (!claimFirstRunImpression(FirstRunEvents.START_HERE_CHIP_SHOWN, currentUser?.id)) return;
    logEvent({ type: FirstRunEvents.START_HERE_CHIP_SHOWN });
  }, [section, gearsSignal.startHere, gearsSignal.claimableCount, currentUser?.id, logEvent]);
  // Shown only when a modality's endpoint (GET /api/v1/video-models, /music-models, /api/ai/audio-providers) lists a
  // model or provider this user can run, and it opens on that modality's tab, so it never dead-ends.
  const videoModels = useVideoModels();
  const musicModels = useMusicModels();
  const audioProviders = useAudioProviders();
  // Decided once every list has settled, so a fast later answer cannot open Studio on a later tab while Video is usable.
  const studioModality =
    videoModels.isPending || musicModels.isPending || audioProviders.isPending
      ? undefined
      : firstUsableStudioModality({
          video: (videoModels.data?.length ?? 0) > 0,
          music: (musicModels.data?.length ?? 0) > 0,
          speech: (audioProviders.data?.speech.length ?? 0) > 0,
          'sound-effects': (audioProviders.data?.soundEffects.length ?? 0) > 0,
        });

  const closeOnMobile = () => {
    if (isMobile) setOpenSideNav(false);
  };

  const items: NavItem[] = [
    {
      key: 'new-chat',
      priority: 0,
      label: t('sidenav.sessions.new'),
      icon: <NewActionIcon />,
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
            priority: 1,
            label: 'OptiHashi',
            icon: (
              <NavIcon>
                <TempleBuddhistOutlinedIcon sx={{ fontSize: '18px' }} />
              </NavIcon>
            ),
            isActive: location.pathname.startsWith('/opti'),
            onClick: () => {
              closeOnMobile();
              // @ts-expect-error - /opti is a premium route, not in static route tree
              navigate({ to: '/opti' });
            },
          },
        ]
      : []),
    ...(bobNavItem
      ? [
          {
            key: 'bob',
            priority: 1,
            label: 'Bob',
            icon: <NavIcon>{BobIcon ? <BobIcon /> : <Diversity3OutlinedIcon sx={{ fontSize: '18px' }} />}</NavIcon>,
            isActive: location.pathname.startsWith('/bob'),
            onClick: () => {
              closeOnMobile();
              // `/bob` is a codegen-mounted premium route (no core route file), so it is not in
              // Tanstack's statically-typed route union - same `as never` cast as /tavern below.
              navigate({ to: '/bob' } as never);
            },
          },
        ]
      : []),
    ...(isMeetingsEnabled
      ? [
          {
            key: 'meetings',
            priority: 1,
            label: 'Interactive Meetings',
            icon: (
              <NavIcon>
                <GroupsOutlinedIcon sx={{ fontSize: '18px' }} />
              </NavIcon>
            ),
            isActive: location.pathname.startsWith('/meetings'),
            onClick: () => {
              closeOnMobile();
              // `/meetings` is codegen-mounted too, so the same cast applies.
              navigate({ to: '/meetings' } as never);
            },
          },
        ]
      : []),
    // No Data Lakes sidebar destination: the in-chat Data Lakes toggle is the only entry point,
    // and since #1943 the only surface - the standalone page is retired.
    {
      key: 'files',
      priority: 0,
      label: t('files.manager', 'Files Manager'),
      icon: (
        <NavIcon>
          <FolderSharedIcon sx={{ fontSize: '18px' }} />
        </NavIcon>
      ),
      isActive: fileBrowserOpen,
      onClick: () => {
        closeOnMobile();
        setFileBrowserOpen(true);
      },
    },
    // Overlay-contributed rows go after Files Manager, so they never take the pinned slot (see the
    // split below) and never push a core row out of it.
    ...sidebarNavItems.map(({ item, key }) => {
      const ContributedIcon = item.icon;
      return {
        key,
        label: item.label,
        priority: 3,
        icon: (
          <NavIcon>
            {ContributedIcon ? <ContributedIcon /> : <ExtensionOutlinedIcon sx={{ fontSize: '18px' }} />}
          </NavIcon>
        ),
        isActive: location.pathname === item.path || location.pathname.startsWith(`${item.path}/`),
        onClick: () => {
          closeOnMobile();
          // Codegen-mounted, so not in Tanstack's statically-typed route union - same cast as /bob.
          navigate({ to: item.path } as never);
        },
      };
    }),
    ...(isAgentsEnabled
      ? [
          {
            key: 'agents',
            priority: 0,
            label: t('agents.title'),
            icon: (
              <NavIcon>
                <SmartToyOutlinedIcon sx={{ fontSize: '18px' }} />
              </NavIcon>
            ),
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
    {
      key: 'projects',
      priority: 3,
      label: t('projects.projects'),
      // Active only on the overall projects grid, not a specific project screen
      // (/projects/:id), which highlights its own row in the list below instead.
      icon: (
        <NavIcon>
          <HubOutlinedIcon sx={{ fontSize: '18px' }} />
        </NavIcon>
      ),
      isActive: location.pathname === '/projects',
      onClick: () => {
        closeOnMobile();
        navigate({ to: '/projects' });
      },
    },
    ...(studioModality
      ? [
          {
            key: 'studio',
            priority: 1,
            label: t('sidenav.studio', 'Studio'),
            icon: (
              <NavIcon>
                <PermMediaOutlinedIcon sx={{ fontSize: '18px' }} />
              </NavIcon>
            ),
            isActive: location.pathname.startsWith('/studio/'),
            onClick: () => {
              closeOnMobile();
              navigate({ to: '/studio/$modality', params: { modality: studioModality } });
            },
          },
        ]
      : []),
    {
      // Live Artifacts (published shares) are the product's lead-gen surface -
      // a first-class destination instead of Profile -> Live Artifacts (3 clicks deep).
      key: 'published',
      priority: 2,
      label: t('sidenav.published', 'Live Artifacts'),
      icon: (
        <NavIcon>
          <PublicOutlinedIcon sx={{ fontSize: '18px' }} />
        </NavIcon>
      ),
      isActive: location.pathname === '/profile' && (location.search as { tab?: string }).tab === 'published',
      onClick: () => {
        closeOnMobile();
        navigate({ to: '/profile', search: { tab: 'published' } });
      },
    },
    {
      // A discovery surface, so it sits in the nav rather than behind Profile -> Skills.
      key: 'skill-market',
      priority: 2,
      label: t('sidenav.skillMarket', 'Skill Market'),
      icon: (
        <NavIcon>
          <StorefrontOutlinedIcon sx={{ fontSize: '18px' }} />
        </NavIcon>
      ),
      isActive: location.pathname.startsWith('/skills/market'),
      onClick: () => {
        closeOnMobile();
        navigate({ to: '/skills/market' });
      },
    },
    ...(isFeatureEnabled('enableQuestMaster')
      ? [
          {
            key: 'quests',
            priority: 0,
            label: t('sidenav.questMaster', 'Quest Master'),
            icon: (
              <NavIcon>
                <AutoAwesomeOutlinedIcon sx={{ fontSize: '18px' }} />
              </NavIcon>
            ),
            isActive: location.pathname === '/quests' || location.pathname.startsWith('/quests/'),
            onClick: () => {
              closeOnMobile();
              navigate({ to: '/quests' });
            },
          },
        ]
      : []),
    // Single-gated on the experimental flag:
    // v5 has no gear, and the flag is opt-in-only, so anyone who turned it on
    // asked for the surface and needs a way to reach it.
    ...(isFeatureEnabled('enableQuestMasterV5')
      ? [
          {
            key: 'quests-v5',
            priority: 3,
            label: t('sidenav.questsV5', 'Quests v5'),
            icon: (
              <NavIcon>
                <AccountTreeOutlinedIcon sx={{ fontSize: '18px' }} />
              </NavIcon>
            ),
            isActive: location.pathname.startsWith('/quests-v5'),
            onClick: () => {
              closeOnMobile();
              navigate({ to: '/quests-v5' });
            },
          },
        ]
      : []),
    ...(isTavernEnabled
      ? [
          {
            key: 'tavern',
            priority: 3,
            label: 'Tavern',
            icon: (
              <NavIcon>
                <CastleOutlinedIcon sx={{ fontSize: '18px' }} />
              </NavIcon>
            ),
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
      // Permanent: the discovery surface for what the app can do, and where rewards are claimed.
      // Also the only nav-level way into the Help Center, which it links out to -
      // the rail no longer carries a row of its own.
      key: 'gears',
      priority: 0,
      label: t('sidenav.gears', 'Gears'),
      icon: (
        <NavIcon>
          <SettingsOutlinedIcon sx={{ fontSize: '18px' }} />
        </NavIcon>
      ),
      isActive: location.pathname === '/gears',
      // One tag at a time: a waiting reward outranks the nudge to explore, and the
      // row is too narrow to carry both.
      trailing:
        gearsSignal.claimableCount > 0 ? (
          <Chip
            size="sm"
            variant="soft"
            color="success"
            data-testid="sidenav-gears-rewards"
            sx={{
              ...navTagSx,
              // The Gears page's claimable chip, so the two read as one signal.
              color: rewardGreen(theme).ink,
              backgroundColor: rewardGreen(theme).fill,
              border: `1px solid ${rewardGreen(theme).stroke}`,
            }}
          >
            {t('sidenav.gearsClaim', 'Claim {{count}}', { count: gearsSignal.claimableCount })}
          </Chip>
        ) : gearsSignal.startHere ? (
          <Chip
            size="sm"
            variant="soft"
            color="neutral"
            data-testid="sidenav-gears-start-here"
            sx={{
              ...navTagSx,
              // An invitation, kept quiet so the green Claim tag stays the only
              // one asking for something.
              ...startHereTagSx(theme),
            }}
          >
            {gearsSignal.startHereCredits > 0
              ? t('sidenav.gearsStartHereCredits', {
                  count: gearsSignal.startHereCredits,
                  credits: gearsSignal.startHereCredits.toLocaleString(i18n.language),
                  defaultValue: 'Start here, +{{credits}} credits',
                  defaultValue_one: 'Start here, +{{credits}} credit',
                  defaultValue_other: 'Start here, +{{credits}} credits',
                })
              : t('sidenav.gearsStartHere', 'Start here')}
          </Chip>
        ) : undefined,
      onClick: () => {
        if (gearsSignal.startHere && gearsSignal.claimableCount === 0) {
          logEvent({ type: FirstRunEvents.START_HERE_CHIP_CLICKED });
        }
        closeOnMobile();
        navigate({ to: '/gears' });
      },
    },
  ];

  // Pinned vs scroll split for the unified-scroll sidebar: the first two items stay
  // pinned at the top. items[0] is always New Chat; items[1] is the first core row
  // present for this user - one of the conditional rows above Files Manager, each
  // elided when absent, else Files Manager itself, which is always present.
  // Overlay-contributed rows sit after Files Manager, so they can never be items[1].
  // The split is purely positional, so it holds regardless of which entries are present.
  const pinnedItems = items.slice(0, PINNED_COUNT);
  const restItems = items.slice(PINNED_COUNT);
  // Counted after gating, so a user who sees fewer rows keeps them all rather than losing some
  // to a fixed More list. The fold always takes at least two rows: More never replaces just one.
  const keepCount = MAX_NAV_ROWS - 1 - PINNED_COUNT;
  const foldedKeys = new Set(
    items.length > MAX_NAV_ROWS
      ? [...restItems]
          .sort((a, b) => a.priority - b.priority)
          .slice(keepCount)
          .map(item => item.key)
      : []
  );
  const moreItems = restItems.filter(item => foldedKeys.has(item.key));
  const scrollItems = restItems.filter(item => !foldedKeys.has(item.key));
  const shownItems =
    section === 'pinned' ? pinnedItems : section === 'scroll' ? scrollItems : [...pinnedItems, ...scrollItems];
  const showMore = section !== 'pinned' && moreItems.length > 0;
  const moreActive = moreItems.some(item => item.isActive);

  return (
    <SidenavNavStack>
      {shownItems.map(item => (
        <Fragment key={item.key}>
          {item.dividerAbove && <Divider sx={{ my: '4px', opacity: 0.6 }} />}
          <SidenavNavRow
            data-testid={`sidenav-nav-${item.key}`}
            icon={item.icon}
            label={item.label}
            active={item.isActive}
            trailing={item.trailing}
            onClick={item.onClick}
          />
        </Fragment>
      ))}
      {showMore && (
        <Dropdown open={moreOpen} onOpenChange={(_, open) => setMoreOpen(open)}>
          <MenuButton
            slots={{ root: Box }}
            slotProps={{
              root: {
                'data-testid': 'sidenav-nav-more',
                role: 'button',
                tabIndex: 0,
                'aria-current': moreActive ? 'page' : undefined,
                sx: navRowSx(theme, moreActive),
              },
            }}
          >
            <NavIcon>
              <FormatListBulletedIcon sx={{ fontSize: '18px' }} />
            </NavIcon>
            <Typography level="body-sm" sx={navLabelSx} noWrap>
              {t('common.more', 'More')}
            </Typography>
            <ChevronLeftIcon
              sx={{
                ml: 'auto',
                fontSize: '18px',
                color: 'text.tertiary',
                transition: 'transform 0.2s ease',
                transform: moreOpen ? 'rotate(0deg)' : 'rotate(180deg)',
              }}
            />
          </MenuButton>
          <Menu
            placement="right-start"
            modifiers={[{ name: 'offset', options: { offset: [0, 18] } }]}
            sx={menuTheme => ({
              ...menuSurfaceSx(menuTheme, '12px'),
              ...menuItemListSx(menuTheme, { gap: '2px', radius: '12px' }),
              minWidth: 220,
              // Portals to body, so it has to clear the sidebar's own floating layers.
              zIndex: 10001,
            })}
          >
            {moreItems.map(item => (
              <MenuItem
                key={item.key}
                data-testid={`sidenav-more-${item.key}`}
                selected={item.isActive}
                onClick={item.onClick}
                sx={menuTheme => menuRowSx(menuTheme)}
              >
                {item.icon}
                <Typography level="body-sm" sx={navLabelSx} noWrap>
                  {item.label}
                </Typography>
              </MenuItem>
            ))}
          </Menu>
        </Dropdown>
      )}
    </SidenavNavStack>
  );
};

export default SidenavNav;
