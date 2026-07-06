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
import SettingsIcon from '@mui/icons-material/Settings';
import DangerousIcon from '@mui/icons-material/Dangerous';
import AccessTimeIcon from '@mui/icons-material/AccessTime';
import SubscriptionsIcon from '@mui/icons-material/Subscriptions';
import AdminProfile from '../../AdminProfile';
import Bike4MindUserDetails from '../Details/Bike4MindUserDetails';
import LoginDetails from '../Details/LoginDetails';
import UserDetails from '../Details/UserDetails';
import UserSubscriptionStatus from '../Details/UserSubscriptionStatus';
import SpicyUserActions from '../SpicyUserActions';
import { useComplianceModal } from '../ComplianceModal';
import UserPermissions from '../UserPermissions';
import SystemMessageModal from '../SystemMessageModal';
import { useFullUserViewModal } from '@client/app/components/admin/Users/Views/FullUserViewModal';
import { useDeleteUser, useUpdateUser, useLoginAsUser } from '@client/app/hooks/data/user';
import { IUserDocument, UserLevelType, WithOrgRef } from '@bike4mind/common';
import { useUser } from '@client/app/contexts/UserContext';
import { useShallow } from 'zustand/shallow';
import { api } from '@client/app/contexts/ApiContext';
import ContextHelpButton from '@client/app/components/help/ContextHelpButton';
import { useNavigate } from '@tanstack/react-router';
import { useAdminSettings } from '@client/app/contexts/AdminSettingsContext';

interface UsersViewProps {
  user: WithOrgRef<IUserDocument>;
  index: number;
  inModal?: boolean;
}

export type EditedFieldsState = {
  [key in keyof Partial<IUserDocument>]: boolean;
};

export const FullUsersView: React.FC<UsersViewProps> = ({ user, index, inModal }) => {
  const deleteUser = useDeleteUser();
  const updateUser = useUpdateUser();
  const loginAsUser = useLoginAsUser();
  const setFullUserViewUserId = useFullUserViewModal(state => state.setUserId);
  const setComplianceUserId = useComplianceModal(state => state.setUserId);
  const { currentUser, setCurrentUser } = useUser(
    useShallow(s => ({ currentUser: s.currentUser, setCurrentUser: s.setCurrentUser }))
  );
  const navigate = useNavigate();
  const { settings: adminSettings } = useAdminSettings();
  const enforceMFA = adminSettings?.enforceMFA === 'true';

  const [editedFields, setEditedFields] = useState<EditedFieldsState>({});
  const [formState, setFormState] = useState<WithOrgRef<IUserDocument>>({ ...user });
  const [tempUserLevel, setTempUserLevel] = useState<UserLevelType>(user.level);
  const [systemMessageModalOpen, setSystemMessageModalOpen] = useState(false);
  const [loginAsMfaModalOpen, setLoginAsMfaModalOpen] = useState(false);
  const [loginAsMfaToken, setLoginAsMfaToken] = useState('');
  const [loginAsMfaRequiredOpen, setLoginAsMfaRequiredOpen] = useState(false);
  const [mobileExpanded, setMobileExpanded] = useState(false);

  useEffect(() => {
    setFormState({ ...user });
    setTempUserLevel(user.level);
  }, [user]);

  const handleFormFieldChange = (key: keyof IUserDocument, value: unknown) => {
    setFormState(prev => ({ ...prev, [key]: value }));
    setEditedFields(prev => ({ ...prev, [key]: true }));
  };

  const handleDeleteUser = async (userId: string) => {
    deleteUser.mutate({ id: userId });
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

  const handleSaveChanges = async () => {
    const data = Object.entries(editedFields).reduce<Partial<IUserDocument>>((acc, [key, value]) => {
      if (value) {
        acc[key as keyof IUserDocument] = formState[key as keyof IUserDocument] as any;
      }
      return acc;
    }, {});

    updateUser.mutate(
      { id: user.id, data },
      {
        onSuccess: async () => {
          // Check if the updated user is the current logged-in user
          if (currentUser && user.id === currentUser.id) {
            try {
              const { data: updatedUser } = await api.get<IUserDocument>(`/api/users/${user.id}`);
              setCurrentUser(updatedUser);
            } catch (error) {
              console.error('Failed to refresh current user data:', error);
            }
          }
          setFullUserViewUserId(null);
        },
      }
    );
  };

  return (
    <Card variant="outlined" key={user.id} sx={{ mb: { xs: 1, sm: 3 }, width: '100%', bgcolor: 'background.level1' }}>
      {/* Mobile compact summary - visible only on xs, hidden when in modal */}
      {!inModal && (
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

      {/* Full content - always visible on sm+ or in modal, conditionally on xs */}
      <Box sx={{ display: inModal ? 'block' : { xs: mobileExpanded ? 'block' : 'none', sm: 'block' } }}>
        {/* Header with user name and quick actions */}
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
            <Stack
              direction={{ xs: 'column', sm: 'row' }}
              spacing={1}
              sx={{ width: { xs: '100%', sm: 'auto' }, mt: { xs: 2, sm: 0 } }}
            >
              <ContextHelpButton helpId="admin/user-management" tooltipText="User Management Help" />
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
              {Object.values(editedFields).some(changed => changed) && (
                <Button
                  size="sm"
                  color="success"
                  startDecorator={<SaveIcon />}
                  onClick={handleSaveChanges}
                  loading={updateUser.isPending}
                  sx={{ width: { xs: '100%', sm: 'auto' } }}
                >
                  Update
                </Button>
              )}
            </Stack>
          </Stack>
        </Box>

        {/* Main content */}
        <Box sx={{ p: { xs: 1, sm: 2 } }}>
          <Grid container spacing={3}>
            {/* User Details Section */}
            <Grid xs={12} sm={6} md={2.4}>
              <Stack spacing={2}>
                <Stack direction="row" alignItems="center" spacing={1}>
                  <PersonIcon fontSize="small" color="primary" />
                  <Typography level="title-sm" fontWeight="bold">
                    User Details
                  </Typography>
                </Stack>
                <Divider />
                <UserDetails
                  user={formState}
                  key={`user-details-${user.id}`}
                  editedFields={editedFields}
                  onFieldChange={handleFormFieldChange}
                />
              </Stack>
            </Grid>

            {/* User Permissions Section */}
            <Grid xs={12} sm={6} md={2.4}>
              <Stack spacing={2}>
                <Stack direction="row" alignItems="center" spacing={1}>
                  <SecurityIcon fontSize="small" color="primary" />
                  <Typography level="title-sm" fontWeight="bold">
                    Permissions
                  </Typography>
                </Stack>
                <Divider />
                <UserPermissions
                  user={{ ...formState, level: tempUserLevel }}
                  key={`user-permissions-${user.id}`}
                  editedFields={editedFields}
                  onFieldChange={handleFormFieldChange}
                  handleUserLevelButtonChange={handleUserLevelButtonChange}
                />
              </Stack>
            </Grid>

            {/* Subscription Section */}
            <Grid xs={12} sm={6} md={2.4}>
              <Stack spacing={2}>
                <Stack direction="row" alignItems="center" spacing={1}>
                  <SubscriptionsIcon fontSize="small" color="primary" />
                  <Typography level="title-sm" fontWeight="bold">
                    Subscription
                  </Typography>
                </Stack>
                <Divider />
                <UserSubscriptionStatus user={user} />
              </Stack>
            </Grid>

            {/* B4M Settings Section */}
            <Grid xs={12} sm={6} md={2.4}>
              <Stack spacing={2}>
                <Stack direction="row" alignItems="center" spacing={1}>
                  <SettingsIcon fontSize="small" color="primary" />
                  <Typography level="title-sm" fontWeight="bold">
                    B4M Settings
                  </Typography>
                </Stack>
                <Divider />
                <Bike4MindUserDetails
                  user={formState}
                  userKey={user.id}
                  editedFields={editedFields}
                  onFieldChange={handleFormFieldChange}
                />
              </Stack>

              {/* Admin Actions Section */}
              <Stack spacing={2} mt={3} ml={0.5}>
                <Stack direction="row" alignItems="center" spacing={1}>
                  <DangerousIcon fontSize="small" color="warning" />
                  <Typography level="title-sm" fontWeight="bold">
                    Admin Actions
                  </Typography>
                </Stack>
                <Divider />
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
              </Stack>
            </Grid>

            {/* Activity & Profile Section */}
            <Grid xs={12} sm={6} md={2.4}>
              <Stack spacing={2}>
                <Stack direction="row" alignItems="center" spacing={1}>
                  <AccessTimeIcon fontSize="small" color="primary" />
                  <Typography level="title-sm" fontWeight="bold">
                    Activity & Profile
                  </Typography>
                </Stack>
                <Divider />
                <Stack spacing={2}>
                  <LoginDetails user={user} />
                  <AdminProfile userId={user.id} />
                </Stack>
              </Stack>
            </Grid>
          </Grid>
        </Box>
      </Box>

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

      {/* MFA verification modal for loginAs */}
      <Modal open={loginAsMfaModalOpen} onClose={() => setLoginAsMfaModalOpen(false)}>
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
                if (e.key === 'Enter' && loginAsMfaToken.trim()) {
                  setLoginAsMfaModalOpen(false);
                  loginAsUser.mutate({ id: user.id, mfaToken: loginAsMfaToken.trim() });
                }
              }}
              data-testid="login-as-mfa-input"
              slotProps={{ input: { maxLength: 10 } }}
            />
          </FormControl>
          <Stack direction="row" spacing={1} justifyContent="flex-end" sx={{ mt: 1 }}>
            <Button variant="plain" color="neutral" onClick={() => setLoginAsMfaModalOpen(false)}>
              Cancel
            </Button>
            <Button
              color="primary"
              disabled={!loginAsMfaToken.trim()}
              loading={loginAsUser.isPending}
              onClick={() => {
                setLoginAsMfaModalOpen(false);
                loginAsUser.mutate({ id: user.id, mfaToken: loginAsMfaToken.trim() });
              }}
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
