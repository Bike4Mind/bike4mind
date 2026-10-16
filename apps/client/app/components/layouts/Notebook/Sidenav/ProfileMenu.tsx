import { KeyboardEvent as ReactKeyboardEvent, ReactNode, useEffect, useRef, useState } from 'react';
import { Avatar, Box, Chip, CircularProgress, Divider, IconButton, Radio, Stack, Tooltip, Typography } from '@mui/joy';
import { useColorScheme, useTheme } from '@mui/joy/styles';
import { useLocation, useNavigate } from '@tanstack/react-router';
import { useTranslation } from 'react-i18next';
import { UiNavigationEvents } from '@bike4mind/common';
import CreditIcon from '@client/app/components/svgs/icons/CreditIcon';
import { useReferralModal } from '@client/app/components/referrals/ReferralModal';
import { useBillingView } from '@client/app/components/subscription/BillingDeepLinkModals';
import { useUser } from '@client/app/contexts/UserContext';
import { useLogEvent } from '@client/app/hooks/data/analytics';
import { useGetSettingsValue } from '@client/app/hooks/data/settings';
import { useGetFriendRequests, useReturnToAdmin, useUserLogout } from '@client/app/hooks/data/user';
import { useAccessToken } from '@client/app/hooks/useAccessToken';
import { useAppVersion } from '@client/app/hooks/useAppVersion';
import { useFeatureEnabled } from '@client/app/hooks/useFeatureEnabled';
import { useIsTablet } from '@client/app/hooks/useIsMobile';
import { useEntitlements } from '@client/app/hooks/data/entitlements';
import { filterVisiblePremiumNavItems } from '@client/app/utils/premiumNav';
import { premiumNavItems } from '@client/app/premium-generated/premiumNavItems.generated';
import { openExternalLinkByKey } from '@client/app/utils/externalLinks';
import { useCookieSettings } from '@client/app/components/CookieConsentBanner';
import { greenAlpha } from '@client/app/utils/themes/colors';
import { formatCreditAmount } from '@client/app/utils/formatCredits';
import { useAccounts } from '@client/app/components/Credits/AccountSelector';
import KeyboardArrowUpIcon from '@mui/icons-material/KeyboardArrowUp';
import KeyboardArrowDownIcon from '@mui/icons-material/KeyboardArrowDown';
import ChevronLeftIcon from '@mui/icons-material/ChevronLeft';
import ManageAccountsIcon from '@mui/icons-material/ManageAccountsOutlined';
import BusinessIcon from '@mui/icons-material/BusinessOutlined';
import MonetizationOnIcon from '@mui/icons-material/MonetizationOnOutlined';
import Brightness4Icon from '@mui/icons-material/Brightness4Outlined';
import DarkModeIcon from '@mui/icons-material/DarkModeOutlined';
import LightModeIcon from '@mui/icons-material/LightModeOutlined';
import FormatListBulletedIcon from '@mui/icons-material/FormatListBulleted';
import PersonAddIcon from '@mui/icons-material/PersonAddOutlined';
import AdminPanelSettingsIcon from '@mui/icons-material/AdminPanelSettingsOutlined';
import InfoOutlinedIcon from '@mui/icons-material/InfoOutlined';
import GavelIcon from '@mui/icons-material/GavelOutlined';
import CookieOutlinedIcon from '@mui/icons-material/CookieOutlined';
import ExtensionIcon from '@mui/icons-material/ExtensionOutlined';
import KeyOutlinedIcon from '@mui/icons-material/KeyOutlined';
import PowerOutlinedIcon from '@mui/icons-material/PowerOutlined';
import AutoAwesomeIcon from '@mui/icons-material/AutoAwesomeOutlined';
import LocalFireDepartmentOutlinedIcon from '@mui/icons-material/LocalFireDepartmentOutlined';
import LogoDevIcon from '@mui/icons-material/LogoDev';
import ApiIcon from '@mui/icons-material/Api';
import LogoutIcon from '@mui/icons-material/LogoutOutlined';
import RefreshIcon from '@mui/icons-material/RefreshOutlined';
import { useNotebookLayout } from '..';
import { MENU_ROW_ICON_SX, menuRowSx, menuSurfaceSx } from './menuSurfaceSx';

export const closeSideNavOnOverlay = (isOverlay: boolean, setOpenSideNav: (open: boolean) => void) => {
  if (isOverlay) setOpenSideNav(false);
};

// Strip the trailing " (Personal)" suffix that useAccounts appends to the personal account name.
const stripPersonalSuffix = (name: string) => name.replace(/ \(Personal\)$/, '');

const trimTrailingSlash = (path: string) => (path.length > 1 ? path.replace(/\/+$/, '') : path);

/** A menu's own items, excluding those of a menu nested inside it (the More flyout). */
const ownMenuItems = (menu: HTMLElement | null) =>
  menu
    ? Array.from(menu.querySelectorAll<HTMLElement>('[role^="menuitem"]')).filter(
        el => el.closest('[role="menu"]') === menu
      )
    : [];

const focusMenuItem = (menu: HTMLElement | null, which: 'first' | 'last') => {
  const items = ownMenuItems(menu);
  (which === 'first' ? items[0] : items[items.length - 1])?.focus();
};

/** Roving focus for Arrow/Home/End within one menu; returns whether the key moved focus. */
const moveMenuFocus = (menu: HTMLElement, key: string) => {
  const items = ownMenuItems(menu);
  if (items.length === 0) return false;
  const current = items.indexOf(document.activeElement as HTMLElement);
  const next =
    key === 'ArrowDown'
      ? (current + 1) % items.length
      : key === 'ArrowUp'
        ? (Math.max(current, 0) - 1 + items.length) % items.length
        : key === 'Home'
          ? 0
          : key === 'End'
            ? items.length - 1
            : -1;
  if (next === -1) return false;
  items[next].focus();
  return true;
};

type MenuRowProps = {
  icon: ReactNode;
  label: string;
  onClick: () => void;
  endDecorator?: ReactNode;
  testId?: string;
  danger?: boolean;
  /** Set on a row that opens a nested menu; carries its expanded state. */
  submenuOpen?: boolean;
};

/** A single icon + label row used throughout the profile menu and its "More" flyout. */
const MenuRow = ({ icon, label, onClick, endDecorator, testId, danger, submenuOpen }: MenuRowProps) => (
  <Box
    data-testid={testId}
    role="menuitem"
    // Focus moves by arrow key (see moveMenuFocus), so Tab never walks the rows.
    tabIndex={-1}
    aria-haspopup={submenuOpen === undefined ? undefined : 'menu'}
    aria-expanded={submenuOpen}
    onClick={onClick}
    // Keyboard parity: Enter/Space activate the row like a real menuitem.
    onKeyDown={e => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        onClick?.();
      }
    }}
    sx={theme => menuRowSx(theme, danger)}
  >
    <Box sx={MENU_ROW_ICON_SX}>{icon}</Box>
    <Typography level="body-sm" sx={{ flex: 1, color: 'inherit', fontSize: '14px', fontWeight: 400 }} noWrap>
      {label}
    </Typography>
    {endDecorator}
  </Box>
);

type AccountCardProps = {
  name: string;
  typeLabel: string | null;
  credits: number;
  selected: boolean;
  onSelect: () => void;
  // Sole account (no team/other accounts to switch to): hide the radio, it's not a choice.
  bare?: boolean;
  // Nothing decrements while enforceCredits is off, so the balance is misleading - hide it.
  showCredits: boolean;
};

/** Account switcher card (Personal / Team) shown at the top of the expanded profile menu. */
export const AccountCard = ({ name, typeLabel, credits, selected, onSelect, bare, showCredits }: AccountCardProps) => (
  <Box
    data-testid="profile-account-option"
    role="menuitemradio"
    aria-checked={selected}
    tabIndex={-1}
    onClick={onSelect}
    onKeyDown={e => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        onSelect();
      }
    }}
    sx={theme => ({
      display: 'flex',
      flexDirection: 'column',
      gap: '6px',
      p: '8px 12px',
      borderRadius: '8px',
      cursor: 'pointer',
      boxSizing: 'border-box',
      border: `1px solid ${selected ? greenAlpha[800][50] : (theme.palette.credits?.accountOption.borderColor ?? theme.palette.neutral.outlinedBorder)}`,
      background: selected
        ? (theme.palette.credits?.accountOption.selectedBackground ?? theme.palette.background.level2)
        : (theme.palette.credits?.accountOption.backgroundColor ?? theme.palette.background.level1),
      transition: 'background 0.15s',
      ...(!selected && { '&:hover': { background: theme.palette.notebooklist.hoverBg } }),
      '&:focus-visible': { outline: `2px solid ${theme.palette.primary[500]}`, outlineOffset: '-2px' },
    })}
  >
    <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 1 }}>
      <Box sx={{ display: 'flex', alignItems: 'baseline', gap: 0.5, minWidth: 0 }}>
        <Typography
          level="body-sm"
          sx={theme => ({
            fontWeight: theme.palette.mode === 'light' ? 400 : 500,
            color: theme.palette.sidenav?.navItemText,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          })}
        >
          {name}
        </Typography>
        {typeLabel && (
          <Typography level="body-xs" sx={{ color: 'text.tertiary', flexShrink: 0 }}>
            {typeLabel}
          </Typography>
        )}
      </Box>
      {!bare && (
        <Radio
          checked={selected}
          color="success"
          size="sm"
          onChange={onSelect}
          // The card itself is the menuitemradio; this is only its visual state.
          aria-hidden
          slotProps={{ input: { 'aria-label': name, tabIndex: -1 } }}
        />
      )}
    </Box>
    {showCredits && (
      <Chip
        size="sm"
        variant="plain"
        // margin: 0 cancels Joy's decorator nudge so the icon lines up under the account name (px: 0).
        startDecorator={<CreditIcon sx={{ fontSize: 12, color: 'var(--Icon-color)', margin: 0 }} />}
        sx={theme => ({
          alignSelf: 'flex-start',
          backgroundColor: 'transparent',
          border: 'none',
          px: 0,
          fontSize: '13px',
          gap: '6px',
          // CreditIcon reads var(--Icon-color); tint it tertiary.
          '--Icon-color': theme.palette.text.tertiary,
        })}
      >
        {formatCreditAmount(credits)}
      </Chip>
    )}
  </Box>
);

/**
 * Bottom-of-sidebar profile control: an always-visible card (avatar + name + account type) that
 * expands upward into the account switcher and account menu (Profile, Teams, Invite, Billing,
 * Help Center, Theme toggle, a "More" flyout, and Log Out). Replaces the old
 * footer icon row + the top AccountSelector dropdown.
 */
const ProfileMenu = () => {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const pathname = useLocation({ select: location => location.pathname });
  const isOverlay = useIsTablet();
  const setOpenSideNav = useNotebookLayout(s => s.setOpenSideNav);
  const theme = useTheme();
  const { setMode } = useColorScheme();
  const mode = theme.palette.mode;
  const modeToggleEnabled = theme.branding.modeToggleEnabled;

  const currentUser = useUser(s => s.currentUser);
  const isAdmin = useUser(s => s.isAdmin);
  const { accounts, selectedAccount, setSelectedAccount, showAccountType } = useAccounts();

  const { isFeatureEnabled } = useFeatureEnabled();
  const isQuestMasterEnabled = isFeatureEnabled('enableQuestMaster');
  const isHearthEnabled = isFeatureEnabled('enableHearth');
  // Premium-overlay launch points (codegen glue - empty array in the open-core
  // fork). Visibility semantics (STRICT - no admin/developer bypass, hidden
  // while entitlements load, hidden-not-redirected on denial) live in
  // filterVisiblePremiumNavItems - see its doc comment and unit tests.
  const { data: entitlements } = useEntitlements();
  const visiblePremiumNavItems = filterVisiblePremiumNavItems(premiumNavItems, entitlements, currentUser?.tags);
  const isCreditsEnabled = !!useGetSettingsValue('enforceCredits');

  const toggleReferralModal = useReferralModal(s => s.toggle);
  const openCookieSettings = useCookieSettings(s => s.open);
  const logEvent = useLogEvent();
  const { data: friendRequests } = useGetFriendRequests(currentUser?.id);
  const returnToAdmin = useReturnToAdmin();
  const hasReturnToken = useAccessToken(s => s.impersonating);
  const { mutate: logout, isPending: isPendingLogout } = useUserLogout();
  const appVersion = useAppVersion();

  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const flyoutRef = useRef<HTMLDivElement>(null);
  const focusOnOpenRef = useRef<'first' | 'last'>('first');
  const [open, setOpen] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  const { openView: openBillingView } = useBillingView();

  const closeAll = () => {
    setOpen(false);
    setMoreOpen(false);
  };

  // Rows that open a dialog or a new tab hand focus back to the trigger BEFORE acting: the panel
  // unmounts with the focused row, and a dialog restores focus to whatever held it when it opened.
  const closeToTrigger = () => {
    triggerRef.current?.focus();
    closeAll();
  };

  const openMenu = (focus: 'first' | 'last') => {
    if (open) {
      focusMenuItem(panelRef.current, focus);
      return;
    }
    focusOnOpenRef.current = focus;
    setOpen(true);
  };

  const closeNavigation = () => {
    closeSideNavOnOverlay(isOverlay, setOpenSideNav);
    closeAll();
  };

  // The focused row unmounts on close. A real route change lets the layout focus the new heading
  // (it only acts when focus is on body), so focus is rescued here only when the pathname stays put
  // (e.g. Profile -> API Keys search change), where that fallback would never fire.
  const navigateFromMenu = (targetPathname: string, go: () => void) => {
    if (trimTrailingSlash(targetPathname) === trimTrailingSlash(pathname)) triggerRef.current?.focus();
    go();
    closeNavigation();
  };

  // Dismiss the menu on any pointer-down outside the whole profile control, or on Escape.
  // A DOM-level listener is used instead of a fixed-position overlay: the sidebar wrapper
  // carries a `transform` (see Sidenav index.tsx), which traps `position: fixed` to the
  // sidebar box, so an overlay would only cover the sidebar and leave clicks in the main
  // content area unable to close the menu.
  useEffect(() => {
    if (!open) return;
    const handlePointerDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        closeAll();
      }
    };
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (rootRef.current?.contains(document.activeElement)) triggerRef.current?.focus();
      closeAll();
    };
    document.addEventListener('mousedown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('mousedown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [open]);

  // Collapse the "More" flyout whenever the panel closes, so it doesn't reopen
  // already-expanded next time. Covers every close path (card toggle, Escape,
  // outside click, navigation) uniformly, not just the closeAll() ones.
  useEffect(() => {
    if (!open) setMoreOpen(false);
  }, [open]);

  useEffect(() => {
    if (open) focusMenuItem(panelRef.current, focusOnOpenRef.current);
  }, [open]);

  useEffect(() => {
    if (moreOpen) focusMenuItem(flyoutRef.current, 'first');
  }, [moreOpen]);

  const handlePanelKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    // Tab leaves a menu rather than walking it, so it closes and returns to the trigger.
    if (e.key === 'Tab') {
      e.preventDefault();
      closeToTrigger();
      return;
    }
    if (e.key === 'ArrowRight' && (e.target as HTMLElement).getAttribute('aria-haspopup') === 'menu') {
      e.preventDefault();
      // Already open: setMoreOpen(true) is a no-op and the [moreOpen] effect does not re-run.
      if (moreOpen) focusMenuItem(flyoutRef.current, 'first');
      else setMoreOpen(true);
      return;
    }
    if (panelRef.current && moveMenuFocus(panelRef.current, e.key)) e.preventDefault();
  };

  const handleFlyoutKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    // Handled keys stop here so the outer panel (and the document Escape listener) never see them.
    if (e.key === 'Escape' || e.key === 'ArrowLeft') {
      e.preventDefault();
      e.stopPropagation();
      setMoreOpen(false);
      panelRef.current?.querySelector<HTMLElement>('[aria-haspopup="menu"]')?.focus();
      return;
    }
    if (flyoutRef.current && moveMenuFocus(flyoutRef.current, e.key)) {
      e.preventDefault();
      e.stopPropagation();
    }
  };

  const planLabel =
    selectedAccount && !selectedAccount.personal ? t('account.team', 'Team') : t('account.personal', 'Personal');

  return (
    <Box ref={rootRef} sx={{ position: 'relative' }}>
      {open && (
        <Box
          ref={panelRef}
          data-testid="profile-menu-panel"
          role="menu"
          aria-label={t('account.menu', 'Account menu')}
          onKeyDown={handlePanelKeyDown}
          sx={theme2 => ({
            ...menuSurfaceSx(theme2),
            position: 'absolute',
            bottom: 'calc(100% + 8px)',
            left: 0,
            right: 0,
            zIndex: 10001,
          })}
        >
          <Stack sx={{ gap: 1, p: 0.5 }}>
            {accounts.map(account => (
              <AccountCard
                key={account.id}
                name={stripPersonalSuffix(account.name)}
                typeLabel={showAccountType ? (account.personal ? '(Personal)' : '(Team)') : null}
                credits={account.credits}
                selected={selectedAccount?.id === account.id}
                onSelect={() => setSelectedAccount(account)}
                bare={accounts.length === 1}
                showCredits={isCreditsEnabled}
              />
            ))}
          </Stack>

          <Divider sx={{ my: 1 }} />

          {isAdmin && (
            <MenuRow
              testId="profile-menu-admin"
              icon={<AdminPanelSettingsIcon sx={{ fontSize: '18px' }} />}
              label={t('admin.title', 'Admin')}
              onClick={() => {
                navigateFromMenu('/admin', () => navigate({ to: '/admin' }));
              }}
            />
          )}
          <MenuRow
            testId="profile-menu-profile"
            icon={<ManageAccountsIcon sx={{ fontSize: '18px' }} />}
            label={t('profile.title', 'Profile')}
            endDecorator={
              friendRequests?.length ? (
                <Chip size="sm" color="danger" variant="solid">
                  {friendRequests.length}
                </Chip>
              ) : undefined
            }
            onClick={() => {
              navigateFromMenu('/profile', () => navigate({ to: '/profile' }));
            }}
          />
          <MenuRow
            testId="profile-menu-skills"
            icon={<ExtensionIcon sx={{ fontSize: '18px' }} />}
            label={t('skills.title', 'Skills')}
            onClick={() => {
              navigateFromMenu('/skills', () => navigate({ to: '/skills' }));
            }}
          />
          <Tooltip
            placement="right"
            title={t(
              'connections.menuTooltip',
              'Integrations like Google Drive and Slack, plus API keys for your own code'
            )}
          >
            <Box>
              <MenuRow
                testId="profile-menu-connections"
                icon={<PowerOutlinedIcon sx={{ fontSize: '18px' }} />}
                label={t('connections.title', 'Connections')}
                onClick={() => {
                  navigateFromMenu('/integrations', () =>
                    navigate({ to: '/integrations', search: { source: 'profile_menu' } })
                  );
                }}
              />
            </Box>
          </Tooltip>
          <MenuRow
            testId="profile-menu-teams"
            icon={<BusinessIcon sx={{ fontSize: '18px' }} />}
            label={t('organization.teams', 'Teams')}
            onClick={() => {
              navigateFromMenu('/organizations', () => navigate({ to: '/organizations' }));
            }}
          />
          <MenuRow
            testId="profile-menu-invite"
            icon={<PersonAddIcon sx={{ fontSize: '18px' }} />}
            label={t('inviteLong', 'Invite a friend')}
            onClick={() => {
              closeToTrigger();
              toggleReferralModal();
            }}
          />
          {isCreditsEnabled && (
            <MenuRow
              testId="profile-menu-billing"
              icon={<MonetizationOnIcon sx={{ fontSize: '18px' }} />}
              label={t('billing.title', 'Billing')}
              onClick={() => {
                logEvent.mutate({ type: UiNavigationEvents.MORE_CREDITS_CLICKED });
                closeToTrigger();
                openBillingView('credits');
              }}
            />
          )}
          {modeToggleEnabled && (
            <Box
              role="group"
              aria-label={t('theme.title', 'Theme')}
              sx={theme2 => ({
                display: 'flex',
                alignItems: 'center',
                gap: '12px',
                px: '10px',
                height: '40px',
                color: theme2.palette.sidenav?.navItemText,
              })}
            >
              <Box
                sx={theme2 => ({
                  width: 22,
                  height: 22,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  '--Icon-color': theme2.palette.text.tertiary,
                })}
              >
                <Brightness4Icon sx={{ fontSize: '18px' }} />
              </Box>
              <Typography level="body-sm" sx={{ flex: 1, color: 'inherit', fontSize: '14px', fontWeight: 400 }}>
                {t('theme.title', 'Theme')}
              </Typography>
              <Box
                sx={theme2 => ({
                  display: 'flex',
                  gap: '2px',
                  p: '2px',
                  border: `1px solid ${theme2.palette.neutral.outlinedBorder}`,
                  borderRadius: '999px',
                })}
              >
                <IconButton
                  size="sm"
                  variant="plain"
                  color="neutral"
                  role="menuitemradio"
                  aria-checked={mode === 'dark'}
                  tabIndex={-1}
                  onClick={() => setMode('dark')}
                  // Selected circle matches a selected notebook/project; non-selected uses the same
                  // hover background as a notebook row.
                  sx={theme2 => ({
                    borderRadius: '999px',
                    minHeight: 26,
                    minWidth: 26,
                    ...(mode === 'dark'
                      ? {
                          backgroundColor: theme2.palette.notebooklist.focusedBackground,
                          '&:hover': { backgroundColor: theme2.palette.notebooklist.focusedBackground },
                        }
                      : {
                          '&:hover': { backgroundColor: theme2.palette.notebooklist.hoverBg },
                        }),
                  })}
                  aria-label="Dark mode"
                >
                  <DarkModeIcon sx={{ fontSize: '15px' }} />
                </IconButton>
                <IconButton
                  size="sm"
                  variant="plain"
                  color="neutral"
                  role="menuitemradio"
                  aria-checked={mode === 'light'}
                  tabIndex={-1}
                  onClick={() => setMode('light')}
                  // Selected circle matches a selected notebook/project; non-selected uses the same
                  // hover background as a notebook row.
                  sx={theme2 => ({
                    borderRadius: '999px',
                    minHeight: 26,
                    minWidth: 26,
                    ...(mode === 'light'
                      ? {
                          backgroundColor: theme2.palette.notebooklist.focusedBackground,
                          '&:hover': { backgroundColor: theme2.palette.notebooklist.focusedBackground },
                        }
                      : {
                          '&:hover': { backgroundColor: theme2.palette.notebooklist.hoverBg },
                        }),
                  })}
                  aria-label="Light mode"
                >
                  <LightModeIcon sx={{ fontSize: '15px' }} />
                </IconButton>
              </Box>
            </Box>
          )}

          <Box sx={{ position: 'relative' }}>
            <MenuRow
              testId="profile-menu-more"
              icon={<FormatListBulletedIcon sx={{ fontSize: '18px' }} />}
              label={t('common.more', 'More')}
              endDecorator={
                <ChevronLeftIcon
                  sx={{
                    fontSize: '18px',
                    color: 'text.tertiary',
                    transition: 'transform 0.2s ease',
                    // Points right when closed; rotates to the open (left) state on expand.
                    transform: moreOpen ? 'rotate(0deg)' : 'rotate(180deg)',
                  }}
                />
              }
              submenuOpen={moreOpen}
              onClick={() => setMoreOpen(v => !v)}
            />
            {moreOpen && (
              <Box
                ref={flyoutRef}
                data-testid="profile-menu-more-flyout"
                role="menu"
                aria-label={t('common.more', 'More')}
                onKeyDown={handleFlyoutKeyDown}
                sx={theme2 => ({
                  // 12px, one step softer than the main panel's 8px: the flyout floats clear of
                  // the panel rather than reading as part of it.
                  ...menuSurfaceSx(theme2, '12px'),
                  position: 'absolute',
                  left: 'calc(100% + 16px)',
                  bottom: 0,
                  minWidth: 220,
                  zIndex: 10002,
                })}
              >
                <MenuRow
                  testId="profile-more-about"
                  icon={<InfoOutlinedIcon sx={{ fontSize: '18px' }} />}
                  label={t('intro.title', 'About Us')}
                  onClick={() => {
                    closeToTrigger();
                    openExternalLinkByKey('about');
                  }}
                />
                <MenuRow
                  testId="profile-more-terms"
                  icon={<GavelIcon sx={{ fontSize: '18px' }} />}
                  label={t('terms_policies', 'Terms & Policies')}
                  onClick={() => {
                    closeToTrigger();
                    openExternalLinkByKey('terms');
                  }}
                />
                <MenuRow
                  testId="profile-more-cookie-settings"
                  icon={<CookieOutlinedIcon sx={{ fontSize: '18px' }} />}
                  label={t('cookie_settings', 'Cookie settings')}
                  onClick={() => {
                    closeToTrigger();
                    openCookieSettings();
                  }}
                />
                {isQuestMasterEnabled && (
                  <MenuRow
                    testId="profile-more-quests"
                    icon={<AutoAwesomeIcon sx={{ fontSize: '18px' }} />}
                    label={t('quests.my_quests', 'My Quests')}
                    onClick={() => {
                      navigateFromMenu('/quests', () => navigate({ to: '/quests' }));
                    }}
                  />
                )}
                {isHearthEnabled && (
                  <MenuRow
                    testId="profile-more-hearth"
                    icon={<LocalFireDepartmentOutlinedIcon sx={{ fontSize: '18px' }} />}
                    label={t('sidenav.hearth', 'Hearth')}
                    onClick={() => {
                      navigateFromMenu('/hearth', () => navigate({ to: '/hearth' }));
                    }}
                  />
                )}
                {visiblePremiumNavItems.map(item => (
                  <MenuRow
                    key={item.path}
                    testId={item.testId}
                    icon={item.icon ? <item.icon /> : undefined}
                    label={item.label}
                    onClick={() => {
                      // Premium routes are registered at runtime via the codegen
                      // glue, so their paths can't appear in the static route-tree
                      // union - erase the typed `to` here.
                      navigateFromMenu(item.path, () => navigate({ to: item.path as never }));
                    }}
                  />
                ))}
                <MenuRow
                  testId="profile-more-api-keys"
                  icon={<KeyOutlinedIcon sx={{ fontSize: '18px' }} />}
                  label={t('apiKeys.title', 'API Keys')}
                  onClick={() => {
                    navigateFromMenu('/integrations', () =>
                      navigate({ to: '/integrations', search: { tab: 'api-keys', source: 'profile_menu' } })
                    );
                  }}
                />
                <MenuRow
                  testId="profile-more-api-docs"
                  icon={<ApiIcon sx={{ fontSize: '18px' }} />}
                  label={t('api_docs', 'API Docs')}
                  onClick={() => {
                    closeToTrigger();
                    openExternalLinkByKey('apiDocs');
                  }}
                />
                <MenuRow
                  testId="profile-more-changelog"
                  icon={<LogoDevIcon sx={{ fontSize: '18px' }} />}
                  label={t('changelog.title', 'Changelog')}
                  onClick={() => {
                    closeToTrigger();
                    openExternalLinkByKey('changelog');
                  }}
                />
              </Box>
            )}
          </Box>

          <Divider sx={{ my: 1 }} />

          {hasReturnToken && (
            <MenuRow
              testId="profile-menu-return"
              danger
              icon={<RefreshIcon sx={{ fontSize: '18px' }} />}
              label={t('return_to_safety', 'Return to safety')}
              onClick={() => {
                closeToTrigger();
                returnToAdmin.mutate();
              }}
            />
          )}
          {/* Hide Log Out while impersonating: logout now revokes sessions server-side, and doing
              that from an impersonated session would force-log-out the real customer on every device.
              The admin exits via "Return to safety" above instead. */}
          {!hasReturnToken && (
            <MenuRow
              testId="logout-btn"
              icon={isPendingLogout ? <CircularProgress size="sm" /> : <LogoutIcon sx={{ fontSize: '18px' }} />}
              label={t('logout', 'Log Out')}
              // Version sits opposite the Logout label (trimmed to major.minor.patch, e.g. v0.7.25).
              endDecorator={
                <Typography level="body-xs" sx={{ color: 'text.tertiary', fontSize: '11px' }}>
                  v{appVersion.data?.version?.split('.').slice(0, 3).join('.')}
                </Typography>
              }
              // Guard against re-firing the logout mutation while one is already in flight
              // (the old footer used disabled={isPendingLogout}; MenuRow has no disabled prop).
              onClick={() => {
                if (!isPendingLogout) logout();
              }}
            />
          )}
        </Box>
      )}

      <Box
        ref={triggerRef}
        data-testid="profile-menu-card"
        role="button"
        tabIndex={0}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={t('account.menu', 'Account menu')}
        onClick={() => (open ? closeAll() : openMenu('first'))}
        onKeyDown={e => {
          if (e.key === 'Enter' || e.key === ' ' || e.key === 'ArrowDown') {
            e.preventDefault();
            if (open && e.key !== 'ArrowDown') closeAll();
            else openMenu('first');
          } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            openMenu('last');
          }
        }}
        sx={theme2 => ({
          display: 'flex',
          alignItems: 'center',
          gap: '12px',
          height: '56px',
          px: '10px',
          borderRadius: '12px',
          cursor: 'pointer',
          border: `1px solid ${theme2.palette.neutral.outlinedBorder}`,
          // Light: body bg (#FBFCFE / gray[10]); dark: surface (#0E1214).
          backgroundColor:
            theme2.palette.mode === 'light' ? theme2.palette.background.body : theme2.palette.background.surface,
          transition: 'background 0.15s',
          '&:hover': { backgroundColor: theme2.palette.notebooklist.hoverBg },
          '&:focus-visible': { outline: `2px solid ${theme2.palette.primary[500]}`, outlineOffset: '2px' },
        })}
      >
        <Avatar
          size="md"
          src={currentUser?.photoUrl ?? undefined}
          sx={{ '--Avatar-size': '36px', width: '36px', height: '36px', borderRadius: '8px' }}
        >
          {currentUser?.name?.charAt(0)?.toUpperCase()}
        </Avatar>
        <Box sx={{ flex: 1, minWidth: 0 }}>
          <Typography level="title-sm" sx={{ fontWeight: 700 }} noWrap>
            {currentUser?.name}
          </Typography>
          <Typography level="body-xs" sx={{ color: 'text.tertiary' }} noWrap>
            {planLabel}
          </Typography>
        </Box>
        {open ? (
          <KeyboardArrowUpIcon sx={{ fontSize: '20px', color: 'text.tertiary' }} />
        ) : (
          <KeyboardArrowDownIcon sx={{ fontSize: '20px', color: 'text.tertiary' }} />
        )}
      </Box>
    </Box>
  );
};

export default ProfileMenu;
