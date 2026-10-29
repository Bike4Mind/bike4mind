import React, { useEffect, useState } from 'react';
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
import AdminProfile from '../../AdminProfile';
import Bike4MindUserDetails from '../Details/Bike4MindUserDetails';
import LoginDetails from '../Details/LoginDetails';
import UserDetails from '../Details/UserDetails';
import UserSubscriptionStatus from '../Details/UserSubscriptionStatus';
import { UserActivityTabPanel, UserViewTabs } from '../Activity/UserViewTabs';
import type { UserProfileTab } from '../Profile/userProfileSearch';
import type { AdminUserProfile } from '../Profile/userProfileModel';
import { useOpenUserProfile } from '../Profile/useOpenUserProfile';
import SpicyUserActions from '../SpicyUserActions';
import { useComplianceModal } from '../ComplianceModal';
import UserPermissions from '../UserPermissions';
import ProductAccess from '../ProductAccess';
import SystemMessageModal from '../SystemMessageModal';
import { useDeleteUser, useUpdateUser, useLoginAsUser } from '@client/app/hooks/data/user';
import { IUserDocument, UserLevelType } from '@bike4mind/common';
import { ActionDialog } from '@client/app/components/admin/shared/ActionDialog';
import { ADMIN_REASON_PRESETS } from '@client/app/components/admin/shared/adminReason';
import type { AdminUserListItem } from '@client/app/utils/adminUserProjection';
import { useUser } from '@client/app/contexts/UserContext';
import { useShallow } from 'zustand/shallow';
import { useQueryClient } from '@tanstack/react-query';
import { api } from '@client/app/contexts/ApiContext';
import ContextHelpButton from '@client/app/components/help/ContextHelpButton';
import { useNavigate } from '@tanstack/react-router';
import { useAdminSettings } from '@client/app/contexts/AdminSettingsContext';
import { stageFieldEdit } from '../stageFieldEdit';

interface UsersViewProps {
  user: AdminUserProfile;
  index: number;
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

/** Presets for the staged change that leads the sentence above: ban first, then moderation. */
const dangerReasonPresets = (editedFields: EditedFieldsState, formState: AdminUserListItem): readonly string[] => {
  if (editedFields.isBanned) {
    return formState.isBanned ? ADMIN_REASON_PRESETS.suspension : ADMIN_REASON_PRESETS.reinstatement;
  }
  return formState.isModerated ? ADMIN_REASON_PRESETS.restriction : ADMIN_REASON_PRESETS.reinstatement;
};

// Keyed by IUserDocument, not the narrower list-projection row: admins edit fields the
// list endpoint does not read back (e.g. emailVerifiedAt), and the PATCH body is a
// Partial<IUserDocument>.
export type EditedFieldsState = {
  [key in keyof Partial<IUserDocument>]: boolean;
};

export const FullUsersView: React.FC<UsersViewProps> = ({ user, index }) => {
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
  const [roleConfirmOpen, setRoleConfirmOpen] = useState(false);
  const [tempUserLevel, setTempUserLevel] = useState<UserLevelType>(user.level);
  const [systemMessageModalOpen, setSystemMessageModalOpen] = useState(false);
  const [loginAsMfaModalOpen, setLoginAsMfaModalOpen] = useState(false);
  const [loginAsMfaToken, setLoginAsMfaToken] = useState('');
  const [loginAsMfaRequiredOpen, setLoginAsMfaRequiredOpen] = useState(false);
  const [mobileExpanded, setMobileExpanded] = useState(false);
  const [dangerConfirmOpen, setDangerConfirmOpen] = useState(false);
  // Collected by the ban/moderation confirm, held so the role step that may follow still sends it.
  const [statusReason, setStatusReason] = useState<string | undefined>(undefined);
  const [activeTab, setActiveTab] = useState<UserProfileTab>('overview');

  useEffect(() => {
    setFormState({ ...user });
    setTempUserLevel(user.level);
    // The staged values are being replaced by this snapshot, so the flags that described
    // them have to go too. Without this they survive an action that already saved (Verify
    // Email writes through its own mutation, then syncs the card via onFieldChange) and
    // the card keeps claiming an unsaved edit that no longer exists.
    setEditedFields({});
  }, [user]);

  const handleFormFieldChange = (key: keyof IUserDocument, value: unknown) => {
    setFormState(prev => ({ ...prev, [key]: value }));
    setEditedFields(prev => stageFieldEdit(prev, key, value, user));
  };

  const handleDeleteUser = async (userId: string, reason: string) => {
    deleteUser.mutate({ id: userId, reason });
  };

  const closeRoleConfirm = () => setRoleConfirmOpen(false);

  const closeLoginAsModal = () => setLoginAsMfaModalOpen(false);

  const submitLoginAs = (reason: string) => {
    loginAsUser.mutate({ id: user.id, mfaToken: loginAsMfaToken.trim(), reason });
    closeLoginAsModal();
  };

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
  const requestSave = (statusChangeReason?: string) => {
    if (editedFields.isAdmin) {
      setRoleConfirmOpen(true);
      return;
    }
    handleSaveChanges(undefined, statusChangeReason);
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

  const confirmDangerChanges = (reason: string) => {
    setStatusReason(reason);
    setDangerConfirmOpen(false);
    requestSave(reason);
  };

  const handleSaveChanges = async (roleReason?: string, statusChangeReason?: string) => {
    const data = Object.entries(editedFields).reduce<
      Partial<IUserDocument> & { roleChangeReason?: string; statusChangeReason?: string }
    >((acc, [key, value]) => {
      if (value) {
        // formState carries admin-editable fields beyond the list projection, so index it
        // structurally rather than through AdminUserListItem's narrower keys.
        (acc as Record<string, unknown>)[key] = (formState as Record<string, unknown>)[key];
      }
      return acc;
    }, {});

    if (editedFields.isAdmin && roleReason) {
      data.roleChangeReason = roleReason.trim();
    }
    if ((editedFields.isBanned || editedFields.isModerated) && statusChangeReason) {
      data.statusChangeReason = statusChangeReason;
    }

    updateUser.mutate(
      { id: user.id, data },
      {
        onSuccess: async () => {
          // Product Access reads server-resolved sources (bypass follows the Role/isAdmin
          // just saved); refresh them so its chips aren't stale after a save.
          queryClient.invalidateQueries({ queryKey: ['admin', 'user-entitlements', user.id] });
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
    title: 'Admin Actions',
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
      {/* The card has no leave guard, so it cannot be left while it holds staged edits. */}
      <Tooltip title={hasUnsavedChanges ? 'Update or undo your changes first' : ''}>
        <span>
          <Button
            size="sm"
            variant="outlined"
            color="neutral"
            startDecorator={<OpenInNewIcon />}
            onClick={() => openUserProfile(user.id)}
            disabled={hasUnsavedChanges}
            sx={{ width: { xs: '100%', sm: 'auto' } }}
            data-testid="user-card-open-profile-btn"
          >
            Open profile
          </Button>
        </span>
      </Tooltip>
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
      {hasUnsavedChanges && (
        <Button
          size="sm"
          color="success"
          startDecorator={<SaveIcon />}
          onClick={handleUpdateClick}
          loading={updateUser.isPending}
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

  // Narrow columns, with Admin Actions under B4M Settings.
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

  return (
    <Card
      variant="outlined"
      key={user.id}
      sx={{
        mb: { xs: 1, sm: 3 },
        width: '100%',
        bgcolor: 'background.level1',
      }}
    >
      {/* Mobile compact summary - visible only on xs */}
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

      {/* Full content - always visible on sm+, conditionally on xs */}
      <Box sx={{ display: { xs: mobileExpanded ? 'block' : 'none', sm: 'block' } }}>
        {cardHeader}

        <UserViewTabs tabs={CARD_TABS} value={activeTab} onChange={setActiveTab} />

        {/* Overview and Admin stay mounted while hidden, so staged edits survive a tab switch. */}
        <Box sx={{ p: { xs: 1, sm: 2 }, display: activeTab === 'overview' ? 'block' : 'none' }}>{cardOverview}</Box>
        {activeTab === 'activity' && <UserActivityTabPanel userId={user.id} />}
      </Box>

      {/* Ban / moderation confirmation: both are staged, so this guards the save that applies them */}
      <ActionDialog
        open={dangerConfirmOpen}
        onClose={() => setDangerConfirmOpen(false)}
        title="Confirm account restriction change"
        description={
          <>
            You are about to {dangerChanges.join(' and ')} <strong>{user.name || user.email}</strong>.
          </>
        }
        reasonPresets={dangerReasonPresets(editedFields, formState)}
        confirmLabel="Confirm"
        tone="danger"
        onConfirm={confirmDangerChanges}
        data-testid="user-profile-danger-confirm-modal"
        testIds={{ confirm: 'user-profile-danger-confirm-btn' }}
      />

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

      <ActionDialog
        open={roleConfirmOpen}
        onClose={closeRoleConfirm}
        title={formState.isAdmin ? 'Grant Super Admin' : 'Remove Super Admin'}
        description={
          formState.isAdmin ? (
            <>
              <strong>{user.name || user.email}</strong> gets full administrative access.
            </>
          ) : (
            <>
              <strong>{user.name || user.email}</strong> loses administrative access.
            </>
          )
        }
        reasonPresets={ADMIN_REASON_PRESETS.roleChange}
        confirmLabel={formState.isAdmin ? 'Grant Super Admin' : 'Remove Super Admin'}
        tone="danger"
        pending={updateUser.isPending}
        onConfirm={roleReason => handleSaveChanges(roleReason, statusReason)}
        data-testid="role-change-confirm-modal"
        testIds={{ reason: 'role-change-reason-input', confirm: 'role-change-confirm-btn' }}
      />

      <ActionDialog
        open={loginAsMfaModalOpen}
        onClose={closeLoginAsModal}
        title="Log in as user"
        description={
          <>
            Starts an audited session as <strong>{user.name || user.email}</strong>. Enter your own authenticator code
            to continue.
          </>
        }
        reasonPresets={ADMIN_REASON_PRESETS.impersonation}
        confirmLabel={`Log in as ${user.name || user.email}`}
        blockedReason={loginAsMfaToken.trim() ? null : 'Enter your 6-digit authenticator code.'}
        pending={loginAsUser.isPending}
        onConfirm={submitLoginAs}
        data-testid="login-as-mfa-modal"
        testIds={{ reason: 'login-as-reason-input', confirm: 'login-as-mfa-confirm-btn' }}
      >
        <FormControl>
          <FormLabel>Authenticator code</FormLabel>
          <Input
            autoFocus
            placeholder="6-digit code"
            value={loginAsMfaToken}
            onChange={e => setLoginAsMfaToken(e.target.value)}
            data-testid="login-as-mfa-input"
            slotProps={{ input: { maxLength: 10, autoComplete: 'one-time-code' } }}
          />
        </FormControl>
      </ActionDialog>
    </Card>
  );
};
