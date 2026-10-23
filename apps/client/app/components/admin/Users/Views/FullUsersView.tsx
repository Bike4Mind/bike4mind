import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  Card,
  Chip,
  Grid,
  IconButton,
  Stack,
  Tooltip,
  Button,
  Typography,
  Divider,
  Box,
  Modal,
  ModalDialog,
  ModalClose,
  FormControl,
  FormLabel,
  Input,
} from '@mui/joy';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import ExpandLessIcon from '@mui/icons-material/ExpandLess';
import SaveIcon from '@mui/icons-material/Save';
import LoginIcon from '@mui/icons-material/Login';
import EmailIcon from '@mui/icons-material/Email';
import PersonIcon from '@mui/icons-material/Person';
import SecurityIcon from '@mui/icons-material/Security';
import VerifiedUserIcon from '@mui/icons-material/VerifiedUser';
import SettingsIcon from '@mui/icons-material/Settings';
import DangerousIcon from '@mui/icons-material/Dangerous';
import AccessTimeIcon from '@mui/icons-material/AccessTime';
import SubscriptionsIcon from '@mui/icons-material/Subscriptions';
import OpenInNewIcon from '@mui/icons-material/OpenInNew';
import CardGiftcardIcon from '@mui/icons-material/CardGiftcard';
import AdminProfile from '../../AdminProfile';
import Bike4MindUserDetails from '../Details/Bike4MindUserDetails';
import LoginDetails from '../Details/LoginDetails';
import UserDetails from '../Details/UserDetails';
import UserSubscriptionStatus from '../Details/UserSubscriptionStatus';
import GrantSubscriptionModal from '../Details/GrantSubscriptionModal';
import { UserActivityTabPanel, UserViewTabs } from '../Activity/UserViewTabs';
import { USER_PROFILE_TABS, type UserProfileTab } from '../Profile/userProfileSearch';
import { UserProfileHeader, type AdminUserProfile } from '../Profile/UserProfileHeader';
import { useOpenUserProfile } from '../Profile/useOpenUserProfile';
import SpicyUserActions from '../SpicyUserActions';
import { useComplianceModal } from '../ComplianceModal';
import UserPermissions from '../UserPermissions';
import ProductAccess from '../ProductAccess';
import SystemMessageModal from '../SystemMessageModal';
import { useDeleteUser, useUpdateUser, useLoginAsUser } from '@client/app/hooks/data/user';
import { IUserDocument, UserLevelType, isValidAdminActionReason } from '@bike4mind/common';
import { AdminReasonField } from '@client/app/components/admin/shared/AdminReasonField';
import type { AdminUserListItem } from '@client/app/utils/adminUserProjection';
import { useUser } from '@client/app/contexts/UserContext';
import { useShallow } from 'zustand/shallow';
import { useQueryClient } from '@tanstack/react-query';
import { api } from '@client/app/contexts/ApiContext';
import ContextHelpButton from '@client/app/components/help/ContextHelpButton';
import { useNavigate } from '@tanstack/react-router';
import { useAdminSettings } from '@client/app/contexts/AdminSettingsContext';
import { unsavedFieldKeys } from '../unsavedFieldLabels';
import { stageFieldEdit } from '../stageFieldEdit';

interface UsersViewProps {
  user: AdminUserProfile;
  index: number;
  /**
   * `card` is a row of the Users list. `page` is the /admin/users/$userId profile: a richer
   * header, Overview as a two-column grid of cards, and the destructive actions on their own tab.
   */
  variant?: 'card' | 'page';
  /** The open tab, when the host owns it (the page keeps it in `?tab=`); the card keeps its own. */
  tab?: UserProfileTab;
  onTabChange?: (tab: UserProfileTab) => void;
  /**
   * Reports which fields are staged-but-unsaved, so a host that can navigate away
   * from the card (UserProfilePage) can warn before the edits are lost. Called only
   * when the set of unsaved fields actually changes, and safe to pass inline.
   */
  onUnsavedFieldsChange?: (fieldKeys: string[]) => void;
  /** Called once the user is deleted, so a host showing only this user can leave. */
  onUserDeleted?: () => void;
}

const CARD_TABS: readonly UserProfileTab[] = ['overview', 'activity'];

type OverviewSection = { key: string; title: string; icon: React.ReactNode; content: React.ReactNode };

const SectionBody: React.FC<{ section: OverviewSection }> = ({ section }) => (
  <Stack spacing={2} sx={{ minWidth: 0 }}>
    <Stack direction="row" alignItems="center" spacing={1}>
      {section.icon}
      <Typography level="title-sm" fontWeight="bold">
        {section.title}
      </Typography>
    </Stack>
    <Divider />
    {section.content}
  </Stack>
);

/** The verbs for the staged ban/moderation changes, for the confirm dialog that guards them. */
const describeDangerChanges = (editedFields: EditedFieldsState, formState: AdminUserListItem): string[] => {
  const changes: string[] = [];
  if (editedFields.isBanned) changes.push(formState.isBanned ? 'ban' : 'unban');
  if (editedFields.isModerated) changes.push(formState.isModerated ? 'moderate' : 'remove moderation from');
  return changes;
};

// Keyed by IUserDocument, not the narrower list-projection row: admins edit fields the
// list endpoint does not read back (e.g. emailVerifiedAt), and the PATCH body is a
// Partial<IUserDocument>.
export type EditedFieldsState = {
  [key in keyof Partial<IUserDocument>]: boolean;
};

export const FullUsersView: React.FC<UsersViewProps> = ({
  user,
  index,
  variant = 'card',
  tab,
  onTabChange,
  onUnsavedFieldsChange,
  onUserDeleted,
}) => {
  const isPage = variant === 'page';
  const deleteUser = useDeleteUser();
  const updateUser = useUpdateUser();
  const loginAsUser = useLoginAsUser();
  const queryClient = useQueryClient();
  const openUserProfile = useOpenUserProfile();
  const setComplianceUserId = useComplianceModal(state => state.setUserId);
  const { currentUser, setCurrentUser } = useUser(
    useShallow(s => ({ currentUser: s.currentUser, setCurrentUser: s.setCurrentUser }))
  );
  const navigate = useNavigate();
  const { settings: adminSettings } = useAdminSettings();
  const enforceMFA = adminSettings?.enforceMFA === 'true';

  const [editedFields, setEditedFields] = useState<EditedFieldsState>({});
  const [formState, setFormState] = useState<AdminUserListItem>({ ...user });
  // Required reason for a manual credit change; persisted on the audit record
  // (see adminUpdateUser) only when currentCredits is actually edited.
  const [creditReason, setCreditReason] = useState('');
  const [roleConfirmOpen, setRoleConfirmOpen] = useState(false);
  const [roleChangeReason, setRoleChangeReason] = useState('');
  const [loginAsReason, setLoginAsReason] = useState('');
  const [tempUserLevel, setTempUserLevel] = useState<UserLevelType>(user.level);
  const [systemMessageModalOpen, setSystemMessageModalOpen] = useState(false);
  const [loginAsMfaModalOpen, setLoginAsMfaModalOpen] = useState(false);
  const [loginAsMfaToken, setLoginAsMfaToken] = useState('');
  const [loginAsMfaRequiredOpen, setLoginAsMfaRequiredOpen] = useState(false);
  const [mobileExpanded, setMobileExpanded] = useState(false);
  const [dangerConfirmOpen, setDangerConfirmOpen] = useState(false);
  const [grantSubscriptionOpen, setGrantSubscriptionOpen] = useState(false);
  const [localTab, setLocalTab] = useState<UserProfileTab>('overview');
  const activeTab = tab ?? localTab;
  const setActiveTab = onTabChange ?? setLocalTab;

  useEffect(() => {
    setFormState({ ...user });
    setTempUserLevel(user.level);
    setCreditReason('');
    // The staged values are being replaced by this snapshot, so the flags that described
    // them have to go too. Without this they survive an action that already saved (Verify
    // Email writes through its own mutation, then syncs the card via onFieldChange) and
    // the card keeps claiming an unsaved edit that no longer exists.
    setEditedFields({});
  }, [user]);

  // Latest-callback ref: keeps the report effect off the callback's identity, so a caller
  // passing an inline arrow cannot turn it into a re-render loop.
  const reportUnsavedFields = useRef(onUnsavedFieldsChange);
  useEffect(() => {
    reportUnsavedFields.current = onUnsavedFieldsChange;
  });

  // Keyed on a signature rather than the array, so a keystroke that leaves the same set of
  // fields unsaved does not re-notify the host. Field keys are identifiers, so no key can
  // contain the separator.
  const unsavedSignature = unsavedFieldKeys(editedFields).join('|');
  const unsavedKeys = useMemo(() => (unsavedSignature ? unsavedSignature.split('|') : []), [unsavedSignature]);

  useEffect(() => {
    // Runs whenever that set changes, and on unmount - the case that motivates the reset:
    // the card is gone, so its staged edits are too, and the host must stop guarding them.
    reportUnsavedFields.current?.(unsavedKeys);
    return () => reportUnsavedFields.current?.([]);
  }, [unsavedKeys]);

  const handleFormFieldChange = (key: keyof IUserDocument, value: unknown) => {
    setFormState(prev => ({ ...prev, [key]: value }));
    setEditedFields(prev => stageFieldEdit(prev, key, value, user));
  };

  const handleDeleteUser = async (userId: string, reason: string) => {
    deleteUser.mutate({ id: userId, reason }, { onSuccess: () => onUserDeleted?.() });
  };

  const closeRoleConfirm = () => {
    setRoleConfirmOpen(false);
    setRoleChangeReason('');
  };

  const closeLoginAsModal = () => {
    setLoginAsMfaModalOpen(false);
    setLoginAsReason('');
  };

  const submitLoginAs = () => {
    loginAsUser.mutate({ id: user.id, mfaToken: loginAsMfaToken.trim(), reason: loginAsReason.trim() });
    closeLoginAsModal();
  };

  const canSubmitLoginAs = !!loginAsMfaToken.trim() && isValidAdminActionReason(loginAsReason);
  const creditReasonMissing = !!editedFields.currentCredits && !isValidAdminActionReason(creditReason);

  const getNextLevel = (currentLevel: string) => {
    switch (currentLevel) {
      case 'DemoUser':
        return 'PaidUser';
      case 'PaidUser':
        return 'VIPUser';
      case 'VIPUser':
        return 'ManagerUser';
      case 'ManagerUser':
        return 'AdminUser';
      case 'AdminUser':
        return 'DemoUser';
      default:
        return currentLevel as UserLevelType;
    }
  };

  const handleUserLevelButtonChange = () => {
    const newLevelValue = getNextLevel(tempUserLevel);
    setTempUserLevel(newLevelValue);
    handleFormFieldChange('level', newLevelValue);
  };

  // A role change is routed through a confirm dialog that collects the reason first.
  const requestSave = () => {
    if (editedFields.isAdmin) {
      setRoleConfirmOpen(true);
      return;
    }
    handleSaveChanges();
  };

  // Ban and moderation are staged like any field, so they are confirmed on Update, before the role step.
  const dangerChanges = describeDangerChanges(editedFields, formState);
  const handleUpdateClick = () => {
    if (dangerChanges.length > 0) {
      setDangerConfirmOpen(true);
      return;
    }
    requestSave();
  };

  const confirmDangerChanges = () => {
    setDangerConfirmOpen(false);
    requestSave();
  };

  const handleSaveChanges = async (roleReason?: string) => {
    const data = Object.entries(editedFields).reduce<
      Partial<IUserDocument> & { creditReason?: string; roleChangeReason?: string }
    >((acc, [key, value]) => {
      if (value) {
        // formState carries admin-editable fields beyond the list projection, so index it
        // structurally rather than through AdminUserListItem's narrower keys.
        (acc as Record<string, unknown>)[key] = (formState as Record<string, unknown>)[key];
      }
      return acc;
    }, {});

    // Attach the reason only when credits actually changed - the server ignores
    // it otherwise, and it should never leak onto an unrelated profile edit.
    if (editedFields.currentCredits && creditReason.trim()) {
      data.creditReason = creditReason.trim();
    }
    if (editedFields.isAdmin && roleReason) {
      data.roleChangeReason = roleReason.trim();
    }

    updateUser.mutate(
      { id: user.id, data },
      {
        onSuccess: async () => {
          // Product Access reads server-resolved sources (bypass follows the Role/isAdmin
          // just saved); refresh them so its chips aren't stale after a save.
          queryClient.invalidateQueries({ queryKey: ['admin', 'user-entitlements', user.id] });
          setCreditReason('');
          closeRoleConfirm();
          // Surface the just-written adjustment in the Credit Analysis audit views.
          queryClient.invalidateQueries({ queryKey: ['admin', 'credit-adjustments'] });
          queryClient.invalidateQueries({ queryKey: ['admin', 'user-credit-adjustments', user.id] });
          // Check if the updated user is the current logged-in user
          if (currentUser && user.id === currentUser.id) {
            try {
              const { data: updatedUser } = await api.get<IUserDocument>(`/api/users/${user.id}`);
              setCurrentUser(updatedUser);
            } catch (error) {
              console.error('Failed to refresh current user data:', error);
            }
          }
        },
      }
    );
  };

  const hasUnsavedChanges = Object.values(editedFields).some(changed => changed);

  const overviewSections: OverviewSection[] = [
    {
      key: 'details',
      title: 'User Details',
      icon: <PersonIcon fontSize="small" color="primary" />,
      content: (
        <UserDetails
          user={formState}
          key={`user-details-${user.id}`}
          editedFields={editedFields}
          onFieldChange={handleFormFieldChange}
        />
      ),
    },
    {
      key: 'roles',
      title: 'Roles',
      icon: <SecurityIcon fontSize="small" color="primary" />,
      content: (
        <UserPermissions
          user={{ ...formState, level: tempUserLevel }}
          key={`user-permissions-${user.id}`}
          editedFields={editedFields}
          onFieldChange={handleFormFieldChange}
          handleUserLevelButtonChange={handleUserLevelButtonChange}
          isSelf={currentUser?.id === user.id}
        />
      ),
    },
    // Product Access is a separate axis from Role: what they ARE vs which products they can use,
    // and where that access comes from.
    {
      key: 'product-access',
      title: 'Product Access',
      icon: <VerifiedUserIcon fontSize="small" color="primary" />,
      content: (
        <ProductAccess user={formState} key={`product-access-${user.id}`} onFieldChange={handleFormFieldChange} />
      ),
    },
    {
      key: 'subscription',
      title: 'Subscription',
      icon: <SubscriptionsIcon fontSize="small" color="primary" />,
      content: <UserSubscriptionStatus user={user} />,
    },
    {
      key: 'b4m-settings',
      title: 'B4M Settings',
      icon: <SettingsIcon fontSize="small" color="primary" />,
      content: (
        <Bike4MindUserDetails
          user={formState}
          userKey={user.id}
          editedFields={editedFields}
          onFieldChange={handleFormFieldChange}
          creditReason={creditReason}
          onCreditReasonChange={setCreditReason}
        />
      ),
    },
    {
      key: 'activity-profile',
      title: 'Activity & Profile',
      icon: <AccessTimeIcon fontSize="small" color="primary" />,
      content: (
        <Stack spacing={2}>
          <LoginDetails user={user} />
          <AdminProfile userId={user.id} />
        </Stack>
      ),
    },
  ];

  const adminActionsSection: OverviewSection = {
    key: 'admin-actions',
    title: isPage ? 'Danger zone' : 'Admin Actions',
    icon: <DangerousIcon fontSize="small" color="warning" />,
    content: (
      <>
        <SpicyUserActions
          user={formState}
          editedFields={editedFields}
          onFieldChange={handleFormFieldChange}
          handleDeleteUser={handleDeleteUser}
        />
        <Button
          data-testid="compliance-btn"
          size="sm"
          variant="outlined"
          color="neutral"
          onClick={() => setComplianceUserId(formState.id)}
        >
          Compliance
        </Button>
      </>
    ),
  };

  const quickActions = (
    <Stack
      direction={{ xs: 'column', sm: 'row' }}
      spacing={1}
      useFlexGap
      flexWrap="wrap"
      sx={{ width: { xs: '100%', sm: 'auto' }, mt: { xs: 2, sm: 0 } }}
    >
      <ContextHelpButton helpId="admin/user-management" tooltipText="User Management Help" />
      {!isPage && (
        <Button
          size="sm"
          variant="outlined"
          color="neutral"
          startDecorator={<OpenInNewIcon />}
          onClick={() => openUserProfile(user.id)}
          sx={{ width: { xs: '100%', sm: 'auto' } }}
          data-testid="user-card-open-profile-btn"
        >
          Open profile
        </Button>
      )}
      <Button
        size="sm"
        color="primary"
        startDecorator={<LoginIcon />}
        onClick={() => {
          if (!currentUser?.mfa?.totpEnabled) {
            setLoginAsMfaRequiredOpen(true);
            return;
          }
          setLoginAsMfaToken('');
          setLoginAsReason('');
          setLoginAsMfaModalOpen(true);
        }}
        loading={loginAsUser.isPending}
        sx={{ width: { xs: '100%', sm: 'auto' } }}
        data-testid="login-as-user-btn"
      >
        Login as User
      </Button>
      <Tooltip title="Send system message to this user">
        <Button
          size="sm"
          color="neutral"
          startDecorator={<EmailIcon />}
          onClick={() => setSystemMessageModalOpen(true)}
          sx={{ width: { xs: '100%', sm: 'auto' } }}
        >
          Send Message
        </Button>
      </Tooltip>
      {isPage && (
        <Button
          size="sm"
          variant="outlined"
          color="neutral"
          startDecorator={<CardGiftcardIcon />}
          onClick={() => setGrantSubscriptionOpen(true)}
          sx={{ width: { xs: '100%', sm: 'auto' } }}
          data-testid="user-profile-grant-subscription-btn"
        >
          Grant Subscription
        </Button>
      )}
      {hasUnsavedChanges && (
        <Button
          size="sm"
          color="success"
          startDecorator={<SaveIcon />}
          onClick={handleUpdateClick}
          loading={updateUser.isPending}
          disabled={creditReasonMissing}
          data-testid="user-update-btn"
          sx={{ width: { xs: '100%', sm: 'auto' } }}
        >
          Update
        </Button>
      )}
    </Stack>
  );

  const cardHeader = (
    <Box sx={{ p: 2, borderBottom: '1px solid', borderColor: 'divider' }}>
      <Stack direction={{ xs: 'column', sm: 'row' }} justifyContent="space-between" alignItems="center">
        <Stack direction={{ xs: 'column', sm: 'row' }} alignItems={{ xs: 'flex-start', sm: 'center' }} spacing={2}>
          <Stack direction="row" alignItems="center" spacing={1}>
            <PersonIcon color="primary" />
            <Typography level="h4" fontWeight="bold">
              {user.name} ({user.username})
            </Typography>
          </Stack>
          <Typography level="body-sm" color="neutral">
            {user.email}
          </Typography>
        </Stack>
        {quickActions}
      </Stack>
    </Box>
  );

  // The card packs the sections into narrow columns with Admin Actions under B4M Settings; the page
  // lays them out as cards two to a row, collapsing to one on narrow widths.
  const cardOverview = (
    <Grid container spacing={3}>
      {overviewSections.map(section => (
        <Grid key={section.key} xs={12} sm={6} md={2}>
          <SectionBody section={section} />
          {section.key === 'b4m-settings' && (
            <Box mt={3} ml={0.5}>
              <SectionBody section={adminActionsSection} />
            </Box>
          )}
        </Grid>
      ))}
    </Grid>
  );

  const pageOverview = (
    <Grid container spacing={2}>
      {overviewSections.map(section => (
        <Grid key={section.key} xs={12} md={6}>
          <Card variant="outlined" data-testid={`user-profile-section-${section.key}`} sx={{ height: '100%' }}>
            <SectionBody section={section} />
          </Card>
        </Grid>
      ))}
    </Grid>
  );

  return (
    <Card
      variant="outlined"
      key={user.id}
      sx={{ mb: isPage ? 0 : { xs: 1, sm: 3 }, width: '100%', bgcolor: 'background.level1' }}
    >
      {/* Mobile compact summary - visible only on xs, and only for a card in the list */}
      {!isPage && (
        <Box
          data-testid={`user-card-mobile-summary-${index}`}
          role="button"
          tabIndex={0}
          aria-expanded={mobileExpanded}
          onClick={() => setMobileExpanded(prev => !prev)}
          sx={{
            display: { xs: 'flex', sm: 'none' },
            alignItems: 'center',
            justifyContent: 'space-between',
            p: 1,
            cursor: 'pointer',
          }}
        >
          <Stack direction="column" sx={{ flex: 1, minWidth: 0 }}>
            <Typography level="body-sm" fontWeight={600} noWrap>
              {user.name}
            </Typography>
            <Typography level="body-xs" color="neutral" noWrap>
              {user.email}
            </Typography>
          </Stack>
          <Stack direction="row" spacing={0.5} alignItems="center" sx={{ flexShrink: 0 }}>
            <Chip size="sm" variant="soft" color={user.isAdmin ? 'primary' : 'neutral'}>
              {user.level}
            </Chip>
            <IconButton size="sm" variant="plain">
              {mobileExpanded ? <ExpandLessIcon /> : <ExpandMoreIcon />}
            </IconButton>
          </Stack>
        </Box>
      )}

      {/* Full content - always visible on sm+ or on the page, conditionally on xs */}
      <Box sx={{ display: isPage ? 'block' : { xs: mobileExpanded ? 'block' : 'none', sm: 'block' } }}>
        {isPage ? <UserProfileHeader user={user} actions={quickActions} /> : cardHeader}

        <UserViewTabs tabs={isPage ? USER_PROFILE_TABS : CARD_TABS} value={activeTab} onChange={setActiveTab} />

        {/* Overview and Admin stay mounted while hidden, so staged edits survive a tab switch. */}
        <Box sx={{ p: { xs: 1, sm: 2 }, display: activeTab === 'overview' ? 'block' : 'none' }}>
          {isPage ? pageOverview : cardOverview}
        </Box>
        {isPage && (
          <Box sx={{ p: { xs: 1, sm: 2 }, display: activeTab === 'admin' ? 'block' : 'none' }}>
            <Card variant="outlined" color="danger" data-testid="user-profile-danger-zone" sx={{ maxWidth: 640 }}>
              <SectionBody section={adminActionsSection} />
            </Card>
          </Box>
        )}
        {activeTab === 'activity' && <UserActivityTabPanel userId={user.id} />}
      </Box>

      {isPage && (
        <GrantSubscriptionModal
          user={user}
          open={grantSubscriptionOpen}
          onClose={() => setGrantSubscriptionOpen(false)}
        />
      )}

      {/* Ban / moderation confirmation: both are staged, so this guards the save that applies them */}
      <Modal open={dangerConfirmOpen} onClose={() => setDangerConfirmOpen(false)}>
        <ModalDialog data-testid="user-profile-danger-confirm-modal">
          <ModalClose />
          <Typography level="title-md" startDecorator={<DangerousIcon />}>
            Confirm account restriction change
          </Typography>
          <Typography level="body-sm" sx={{ mb: 1 }}>
            You are about to {dangerChanges.join(' and ')} <strong>{user.name || user.email}</strong>.
          </Typography>
          <Stack direction="row" spacing={1} justifyContent="flex-end" sx={{ mt: 1 }}>
            <Button variant="plain" color="neutral" onClick={() => setDangerConfirmOpen(false)}>
              Cancel
            </Button>
            <Button color="danger" onClick={confirmDangerChanges} data-testid="user-profile-danger-confirm-btn">
              Confirm
            </Button>
          </Stack>
        </ModalDialog>
      </Modal>

      {/* System Message Modal */}
      <SystemMessageModal
        open={systemMessageModalOpen}
        onClose={() => setSystemMessageModalOpen(false)}
        receiverId={user.id}
      />

      {/* MFA required modal - shown when admin has no MFA configured */}
      <Modal open={loginAsMfaRequiredOpen} onClose={() => setLoginAsMfaRequiredOpen(false)}>
        <ModalDialog data-testid="login-as-mfa-required-modal">
          <ModalClose />
          <Typography level="title-md" startDecorator={<SecurityIcon />}>
            MFA Required
          </Typography>
          <Typography level="body-sm" sx={{ mb: 1 }}>
            {enforceMFA ? (
              <>
                Your organization requires Multi-Factor Authentication (MFA) for all users. Setting up MFA will allow
                you to access the app and use <strong>Login as User</strong>.
              </>
            ) : (
              <>
                Multi-Factor Authentication (MFA) is required to use <strong>Login as User</strong>. This is a security
                requirement for impersonation only — MFA is not required for your normal account login.
              </>
            )}
          </Typography>
          <Stack direction="row" spacing={1} justifyContent="flex-end" sx={{ mt: 1 }}>
            <Button variant="plain" color="neutral" onClick={() => setLoginAsMfaRequiredOpen(false)}>
              Cancel
            </Button>
            <Button
              color="primary"
              startDecorator={<SecurityIcon />}
              onClick={() => {
                setLoginAsMfaRequiredOpen(false);
                navigate({ to: '/profile', search: { tab: 'settings', section: 'security' } });
              }}
              data-testid="login-as-mfa-required-setup-btn"
            >
              Set Up MFA
            </Button>
          </Stack>
        </ModalDialog>
      </Modal>

      {/* Role change confirmation: the reason is required and audited */}
      <Modal open={roleConfirmOpen} onClose={closeRoleConfirm}>
        <ModalDialog data-testid="role-change-confirm-modal">
          <ModalClose />
          <Typography level="title-md" startDecorator={<SecurityIcon />}>
            Confirm Role Change
          </Typography>
          <Typography level="body-sm" sx={{ mb: 1 }}>
            {formState.isAdmin ? (
              <>
                You are about to grant <strong>Super Admin</strong> to <strong>{user.name || user.email}</strong>. They
                will have full administrative access.
              </>
            ) : (
              <>
                You are about to remove <strong>Super Admin</strong> from <strong>{user.name || user.email}</strong>.
                They will lose administrative access.
              </>
            )}
          </Typography>
          <AdminReasonField
            value={roleChangeReason}
            onChange={setRoleChangeReason}
            data-testid="role-change-reason-input"
          />
          <Stack direction="row" spacing={1} justifyContent="flex-end" sx={{ mt: 1 }}>
            <Button variant="plain" color="neutral" onClick={closeRoleConfirm}>
              Cancel
            </Button>
            <Button
              color="danger"
              disabled={!isValidAdminActionReason(roleChangeReason)}
              loading={updateUser.isPending}
              onClick={() => handleSaveChanges(roleChangeReason)}
              data-testid="role-change-confirm-btn"
            >
              Confirm Role Change
            </Button>
          </Stack>
        </ModalDialog>
      </Modal>

      {/* MFA verification modal for loginAs */}
      <Modal open={loginAsMfaModalOpen} onClose={closeLoginAsModal}>
        <ModalDialog data-testid="login-as-mfa-modal">
          <ModalClose />
          <Typography level="title-md" startDecorator={<SecurityIcon />}>
            Verify Your Identity
          </Typography>
          <Typography level="body-sm" sx={{ mb: 1 }}>
            Enter your authenticator code to login as <strong>{user.name || user.email}</strong>.
          </Typography>
          <FormControl>
            <FormLabel>TOTP Code</FormLabel>
            <Input
              autoFocus
              placeholder="6-digit code"
              value={loginAsMfaToken}
              onChange={e => setLoginAsMfaToken(e.target.value)}
              onKeyDown={e => {
                if (e.key === 'Enter' && canSubmitLoginAs) {
                  submitLoginAs();
                }
              }}
              data-testid="login-as-mfa-input"
              slotProps={{ input: { maxLength: 10 } }}
            />
          </FormControl>
          <AdminReasonField value={loginAsReason} onChange={setLoginAsReason} data-testid="login-as-reason-input" />
          <Stack direction="row" spacing={1} justifyContent="flex-end" sx={{ mt: 1 }}>
            <Button variant="plain" color="neutral" onClick={closeLoginAsModal}>
              Cancel
            </Button>
            <Button
              color="primary"
              disabled={!canSubmitLoginAs}
              loading={loginAsUser.isPending}
              onClick={submitLoginAs}
              data-testid="login-as-mfa-confirm-btn"
            >
              Confirm
            </Button>
          </Stack>
        </ModalDialog>
      </Modal>
    </Card>
  );
};
