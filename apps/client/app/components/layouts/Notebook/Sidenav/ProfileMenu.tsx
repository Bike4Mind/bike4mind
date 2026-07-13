import { ReactNode, useEffect, useRef, useState } from 'react';
import { Avatar, Box, Chip, CircularProgress, Divider, IconButton, Radio, Stack, Typography } from '@mui/joy';
import { useColorScheme, useTheme } from '@mui/joy/styles';
import { useNavigate } from '@tanstack/react-router';
import { useTranslation } from 'react-i18next';
import { UiNavigationEvents } from '@bike4mind/common';
import Bike4MindIcon from '@client/app/components/svgs/icons/Bike4MindIcon';
import InboxBadge from '@client/app/components/inbox/Badge';
import { useReferralModal } from '@client/app/components/referrals/ReferralModal';
import CreditsModal from '@client/app/components/subscription/CreditsModal';
import SubscriptionModal from '@client/app/components/subscription/SubscriptionModal';
import { useInbox } from '@client/app/contexts/InboxContext';
import { useUser } from '@client/app/contexts/UserContext';
import { useLogEvent } from '@client/app/hooks/data/analytics';
import { useGetSettingsValue } from '@client/app/hooks/data/settings';
import { useGetFriendRequests, useReturnToAdmin, useUserLogout } from '@client/app/hooks/data/user';
import { useAccessToken } from '@client/app/hooks/useAccessToken';
import { useAppVersion } from '@client/app/hooks/useAppVersion';
import { useFeatureEnabled } from '@client/app/hooks/useFeatureEnabled';
import { useEntitlements } from '@client/app/hooks/data/entitlements';
import { filterVisiblePremiumNavItems } from '@client/app/utils/premiumNav';
import { premiumNavItems } from '@client/app/premium-generated/premiumNavItems.generated';
import { openExternalLinkByKey } from '@client/app/utils/externalLinks';
import { greenAlpha } from '@client/app/utils/themes/colors';
import { useAccounts } from '@client/app/components/Credits/AccountSelector';
import KeyboardArrowUpIcon from '@mui/icons-material/KeyboardArrowUp';
import KeyboardArrowDownIcon from '@mui/icons-material/KeyboardArrowDown';
import ChevronLeftIcon from '@mui/icons-material/ChevronLeft';
import ManageAccountsIcon from '@mui/icons-material/ManageAccountsOutlined';
import MailOutlineIcon from '@mui/icons-material/MailOutline';
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
import ExtensionIcon from '@mui/icons-material/ExtensionOutlined';
import KeyOutlinedIcon from '@mui/icons-material/KeyOutlined';
import AutoAwesomeIcon from '@mui/icons-material/AutoAwesomeOutlined';
import LogoDevIcon from '@mui/icons-material/LogoDev';
import LogoutIcon from '@mui/icons-material/LogoutOutlined';
import RefreshIcon from '@mui/icons-material/RefreshOutlined';

// Strip the trailing " (Personal)" suffix that useAccounts appends to the personal account name.
const stripPersonalSuffix = (name: string) => name.replace(/ \(Personal\)$/, '');

type MenuRowProps = {
  icon: ReactNode;
  label: string;
  onClick: () => void;
  endDecorator?: ReactNode;
  testId?: string;
  danger?: boolean;
};

/** A single icon + label row used throughout the profile menu and its "More" flyout. */
const MenuRow = ({ icon, label, onClick, endDecorator, testId, danger }: MenuRowProps) => (
  <Box
    data-testid={testId}
    role="menuitem"
    tabIndex={0}
    onClick={onClick}
    // Keyboard parity: Enter/Space activate the row like a real menuitem.
    onKeyDown={e => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        onClick?.();
      }
    }}
    sx={theme => ({
      display: 'flex',
      alignItems: 'center',
      gap: '12px',
      px: '10px',
      height: '40px',
      borderRadius: '8px',
      cursor: 'pointer',
      color: danger ? theme.palette.danger[500] : theme.palette.sidenav?.navItemText,
      // Joy icons - and the Credits Bike4MindIcon, which fills with var(--Icon-color) -
      // read --Icon-color, not `color`. Tint them brand light-blue @50% (text.tertiary).
      '--Icon-color': danger ? theme.palette.danger[500] : theme.palette.text.tertiary,
      transition: 'background 0.15s',
      '&:hover': { backgroundColor: theme.palette.notebooklist.hoverBg },
      '&:focus-visible': { outline: `2px solid ${theme.palette.primary[500]}`, outlineOffset: '-2px' },
    })}
  >
    <Box
      sx={{
        width: 22,
        height: 22,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        flexShrink: 0,
      }}
    >
      {icon}
    </Box>
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
    onClick={onSelect}
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
          slotProps={{ input: { 'aria-label': name } }}
        />
      )}
    </Box>
    {showCredits && (
      <Chip
        size="sm"
        variant="plain"
        startDecorator={<Bike4MindIcon size="12" />}
        sx={theme => ({
          alignSelf: 'flex-start',
          backgroundColor: 'transparent',
          border: 'none',
          px: 0,
          fontSize: '13px',
          gap: '6px',
          // Bike4MindIcon fills with var(--Icon-color); tint it tertiary.
          '--Icon-color': theme.palette.text.tertiary,
        })}
      >
        {credits.toLocaleString()}
      </Chip>
    )}
  </Box>
);

/**
 * Bottom-of-sidebar profile control: an always-visible card (avatar + name + account type) that
 * expands upward into the account switcher and account menu (Profile, Inbox, Teams, Credits,
 * Subscriptions, Help Center, Theme toggle, a "More" flyout, and Log Out). Replaces the old
 * footer icon row + the top AccountSelector dropdown.
 */
const ProfileMenu = () => {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const theme = useTheme();
  const { setMode } = useColorScheme();
  const mode = theme.palette.mode;
  const modeToggleEnabled = theme.branding.modeToggleEnabled;

  const currentUser = useUser(s => s.currentUser);
  const isAdmin = useUser(s => s.isAdmin);
  const { accounts, selectedAccount, setSelectedAccount, showAccountType } = useAccounts();

  const { isFeatureEnabled } = useFeatureEnabled();
  const isQuestMasterEnabled = isFeatureEnabled('enableQuestMaster');
  // Premium-overlay launch points (codegen glue - empty array in the open-core
  // fork). Visibility semantics (STRICT - no admin/developer bypass, hidden
  // while entitlements load, hidden-not-redirected on denial) live in
  // filterVisiblePremiumNavItems - see its doc comment and unit tests.
  const { data: entitlements } = useEntitlements();
  const visiblePremiumNavItems = filterVisiblePremiumNavItems(premiumNavItems, entitlements, currentUser?.tags);
  const isCreditsEnabled = !!useGetSettingsValue('enforceCredits');

  const { setOpen: setInboxOpen } = useInbox.getState();
  const toggleReferralModal = useReferralModal(s => s.toggle);
  const logEvent = useLogEvent();
  const { data: friendRequests } = useGetFriendRequests(currentUser?.id);
  const returnToAdmin = useReturnToAdmin();
  const hasReturnToken = useAccessToken(s => s.returnToken);
  const { mutate: logout, isPending: isPendingLogout } = useUserLogout();
  const appVersion = useAppVersion();

  const rootRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  const [isCreditsModalOpen, setIsCreditsModalOpen] = useState(false);
  const [isSubscriptionModalOpen, setIsSubscriptionModalOpen] = useState(false);

  const closeAll = () => {
    setOpen(false);
    setMoreOpen(false);
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
      if (e.key === 'Escape') closeAll();
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

  const planLabel =
    selectedAccount && !selectedAccount.personal ? t('account.team', 'Team') : t('account.personal', 'Personal');

  const panelSx = (t2: typeof theme) => ({
    backgroundColor: t2.palette.background.popup,
    border: `1px solid ${t2.palette.divider}`,
    borderRadius: '12px',
    // Soft, diffuse lift (same recipe as the tutorial frame): a wide low-opacity ambient layer
    // plus a tighter contact layer, stronger in dark mode where light shadows disappear.
    boxShadow:
      t2.palette.mode === 'dark'
        ? '0 24px 70px rgba(0, 0, 0, 0.28), 0 8px 20px rgba(0, 0, 0, 0.14)'
        : '0 24px 30px rgba(0, 0, 0, 0.03), 0 8px 20px rgba(0, 0, 0, 0.02)',
    p: 1,
  });

  return (
    <Box ref={rootRef} sx={{ position: 'relative' }}>
      {open && (
        <Box
          data-testid="profile-menu-panel"
          role="menu"
          sx={theme2 => ({
            ...panelSx(theme2),
            backgroundColor: theme2.palette.background.surface, // #0E1214 in dark
            borderRadius: '8px',
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
                navigate({ to: '/admin' });
                setOpen(false);
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
              navigate({ to: '/profile' });
              setOpen(false);
            }}
          />
          <MenuRow
            testId="profile-menu-skills"
            icon={<ExtensionIcon sx={{ fontSize: '18px' }} />}
            label={t('skills.title', 'Skills')}
            onClick={() => {
              navigate({ to: '/skills' });
              setOpen(false);
            }}
          />
          <MenuRow
            testId="profile-menu-api-keys"
            icon={<KeyOutlinedIcon sx={{ fontSize: '18px' }} />}
            label={t('apiKeys.title', 'API Keys')}
            onClick={() => {
              navigate({ to: '/profile', search: { tab: 'api-keys' } });
              setOpen(false);
            }}
          />
          <MenuRow
            testId="profile-menu-teams"
            icon={<BusinessIcon sx={{ fontSize: '18px' }} />}
            label={t('organization.teams', 'Teams')}
            onClick={() => {
              navigate({ to: '/organizations' });
              setOpen(false);
            }}
          />
          {isCreditsEnabled && (
            <MenuRow
              testId="profile-menu-credits"
              icon={<Bike4MindIcon size="18" />}
              label={t('credits.title', 'Credits')}
              onClick={() => {
                logEvent.mutate({ type: UiNavigationEvents.MORE_CREDITS_CLICKED });
                setIsCreditsModalOpen(true);
                setOpen(false);
              }}
            />
          )}
          {isCreditsEnabled && (
            <MenuRow
              testId="profile-menu-subscriptions"
              icon={<MonetizationOnIcon sx={{ fontSize: '18px' }} />}
              label={t('subscriptions.title', 'Subscriptions')}
              onClick={() => {
                setIsSubscriptionModalOpen(true);
                setOpen(false);
              }}
            />
          )}
          {modeToggleEnabled && (
            <Box
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
                <InboxBadge>
                  <ChevronLeftIcon
                    sx={{
                      fontSize: '18px',
                      color: 'text.tertiary',
                      transition: 'transform 0.2s ease',
                      // Points right when closed; rotates to the open (left) state on expand.
                      transform: moreOpen ? 'rotate(0deg)' : 'rotate(180deg)',
                    }}
                  />
                </InboxBadge>
              }
              onClick={() => setMoreOpen(v => !v)}
            />
            {moreOpen && (
              <Box
                data-testid="profile-menu-more-flyout"
                role="menu"
                sx={theme2 => ({
                  ...panelSx(theme2),
                  backgroundColor: theme2.palette.background.surface, // match the panel surface (#0E1214 in dark)
                  position: 'absolute',
                  left: 'calc(100% + 16px)',
                  bottom: 0,
                  minWidth: 220,
                  zIndex: 10002,
                })}
              >
                <MenuRow
                  testId="profile-more-inbox"
                  icon={
                    <InboxBadge>
                      <MailOutlineIcon sx={{ fontSize: '18px' }} />
                    </InboxBadge>
                  }
                  label={t('inbox.title', 'Inbox')}
                  onClick={() => {
                    setInboxOpen(true);
                    closeAll();
                  }}
                />
                <MenuRow
                  testId="profile-more-invite"
                  icon={<PersonAddIcon sx={{ fontSize: '18px' }} />}
                  label={t('inviteShort', 'Invite')}
                  onClick={() => {
                    toggleReferralModal();
                    closeAll();
                  }}
                />
                <MenuRow
                  testId="profile-more-about"
                  icon={<InfoOutlinedIcon sx={{ fontSize: '18px' }} />}
                  label={t('intro.title', 'About Us')}
                  onClick={() => {
                    openExternalLinkByKey('about');
                    closeAll();
                  }}
                />
                <MenuRow
                  testId="profile-more-terms"
                  icon={<GavelIcon sx={{ fontSize: '18px' }} />}
                  label={t('terms_policies', 'Terms & Policies')}
                  onClick={() => {
                    openExternalLinkByKey('terms');
                    closeAll();
                  }}
                />
                {isQuestMasterEnabled && (
                  <MenuRow
                    testId="profile-more-quests"
                    icon={<AutoAwesomeIcon sx={{ fontSize: '18px' }} />}
                    label={t('quests.my_quests', 'My Quests')}
                    onClick={() => {
                      navigate({ to: '/quests' });
                      closeAll();
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
                      navigate({ to: item.path as never });
                      closeAll();
                    }}
                  />
                ))}
                <MenuRow
                  testId="profile-more-changelog"
                  icon={<LogoDevIcon sx={{ fontSize: '18px' }} />}
                  label={t('changelog.title', 'Changelog')}
                  onClick={() => {
                    openExternalLinkByKey('changelog');
                    closeAll();
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
                returnToAdmin.mutate();
                setOpen(false);
              }}
            />
          )}
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
        </Box>
      )}

      <Box
        data-testid="profile-menu-card"
        role="button"
        tabIndex={0}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={t('account.menu', 'Account menu')}
        onClick={() => setOpen(v => !v)}
        onKeyDown={e => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            setOpen(v => !v);
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
        {/* InboxBadge keeps the unread indicator visible on the always-mounted card (parity with
            the old footer, where the collapsed menu button carried it) — not just inside the panel. */}
        <InboxBadge>
          <Avatar
            size="md"
            src={currentUser?.photoUrl ?? undefined}
            sx={{ '--Avatar-size': '36px', width: '36px', height: '36px', borderRadius: '8px' }}
          >
            {currentUser?.name?.charAt(0)?.toUpperCase()}
          </Avatar>
        </InboxBadge>
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

      <CreditsModal open={isCreditsModalOpen} onClose={() => setIsCreditsModalOpen(false)} />
      <SubscriptionModal open={isSubscriptionModalOpen} onClose={() => setIsSubscriptionModalOpen(false)} />
    </Box>
  );
};

export default ProfileMenu;
