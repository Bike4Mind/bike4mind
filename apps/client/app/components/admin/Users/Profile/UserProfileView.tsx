import React, { useMemo, useState } from 'react';
import { Box, Button, Link, Stack, Typography } from '@mui/joy';
import { useQueryClient } from '@tanstack/react-query';
import BlockIcon from '@mui/icons-material/Block';
import { useComplianceModal } from '../ComplianceModal';
import GrantSubscriptionModal from '../Details/GrantSubscriptionModal';
import BulkAbuseResponseModal from '../BulkAbuseResponseModal';
import { openHelpPanel } from '@client/app/hooks/useHelpPanel';
import { AdminCommandPalette, type AdminCommand } from '../../shared/AdminCommandPalette';
import { Kbd } from '../../shared';
import { AdjustCreditsDialog } from './actions/AdjustCreditsDialog';
import { ReinstateDialog, SuspendDialog } from './actions/SuspendDialog';
import { EditProfileDialog } from './actions/EditProfileDialog';
import { ChangeRoleDialog, ManageTagsDialog, ProductAccessDialog } from './actions/accessDialogs';
import {
  ApiKeyTrustDialog,
  NewAccountSpendCapDialog,
  DeleteUserDialog,
  EmailVerificationDialog,
  LoginAsDialog,
  ResetMfaDialog,
  RestrictDialog,
  SendMessageDialog,
} from './actions/accountDialogs';
import type { ProfileAction, ProfileDialogProps } from './actions/profileActions';
import { UserProfileHeader } from './UserProfileHeader';
import { UserProfileStats } from './UserProfileStats';
import { UserProfileTabs } from './UserProfileTabs';
import { UserRiskBadges } from './UserRiskBadges';
import { OverviewTab } from './tabs/OverviewTab';
import { CreditsTab } from './tabs/credits/CreditsTab';
import { ApiKeysTab } from './tabs/keys/ApiKeysTab';
import { ActivityTab } from './tabs/ActivityTab';
import { AdminLogTab } from './tabs/AdminLogTab';
import { SignInsTab } from './tabs/SignInsTab';
import { USER_PROFILE_TAB_LABELS, type UserProfileTab } from './userProfileSearch';
import { displayName, type AdminUserProfile } from './userProfileModel';

type UserProfileViewProps = {
  user: AdminUserProfile;
  tab: UserProfileTab;
  onTabChange: (tab: UserProfileTab) => void;
  onBack: () => void;
};

/** The dialog for one action; `subscription` reuses the grant modal, which keeps its own `open`. */
const ActionHost: React.FC<ProfileDialogProps & { action: ProfileAction; onDeleted: () => void }> = ({
  action,
  onDeleted,
  ...props
}) => {
  switch (action) {
    case 'editProfile':
      return <EditProfileDialog {...props} />;
    case 'credits':
      return <AdjustCreditsDialog {...props} />;
    case 'suspend':
      return <SuspendDialog {...props} />;
    case 'reinstate':
      return <ReinstateDialog {...props} />;
    case 'restrict':
      return <RestrictDialog {...props} />;
    case 'role':
      return <ChangeRoleDialog {...props} />;
    case 'productAccess':
      return <ProductAccessDialog {...props} />;
    case 'tags':
      return <ManageTagsDialog {...props} />;
    case 'mfaReset':
      return <ResetMfaDialog {...props} />;
    case 'emailVerification':
      return <EmailVerificationDialog {...props} />;
    case 'apiKeyTrust':
      return <ApiKeyTrustDialog {...props} />;
    case 'newAccountSpendCap':
      return <NewAccountSpendCapDialog {...props} />;
    case 'subscription':
      return <GrantSubscriptionModal user={props.user} open onClose={props.onClose} />;
    case 'loginAs':
      return <LoginAsDialog {...props} />;
    case 'message':
      return <SendMessageDialog {...props} />;
    case 'delete':
      return <DeleteUserDialog {...props} onDeleted={onDeleted} />;
  }
};

const Breadcrumb: React.FC<{ name: string; onBack: () => void }> = ({ name, onBack }) => (
  <Stack
    component="nav"
    aria-label="Breadcrumb"
    direction="row"
    alignItems="center"
    gap={1}
    flexWrap="wrap"
    sx={{ fontSize: 13 }}
  >
    <Link component="button" type="button" onClick={onBack} sx={{ fontSize: 13 }} data-testid="user-profile-back-btn">
      Users
    </Link>
    <Typography level="body-sm" aria-hidden sx={{ color: 'admin.inkMuted' }}>
      /
    </Typography>
    <Typography level="body-sm" aria-current="page" sx={{ color: 'admin.inkMuted', overflowWrap: 'anywhere' }}>
      {name}
    </Typography>
    <Typography
      level="body-sm"
      sx={{ ml: 'auto', color: 'admin.inkMuted', display: { xs: 'none', sm: 'block' } }}
      data-testid="user-profile-shortcut-hints"
    >
      Press <Kbd>C</Kbd> adjust credits {'\u00b7'} <Kbd>S</Kbd> suspend
    </Typography>
  </Stack>
);

const StatusBanner: React.FC<{ user: AdminUserProfile; onReinstate: () => void; onLiftRestriction: () => void }> = ({
  user,
  onReinstate,
  onLiftRestriction,
}) => {
  if (!user.isBanned && !user.isModerated) return null;
  const tone = user.isBanned ? 'bad' : 'warn';
  return (
    <Stack
      role="status"
      direction="row"
      alignItems="center"
      gap={1.5}
      flexWrap="wrap"
      sx={{
        px: 2,
        py: 1.5,
        borderRadius: 12,
        border: '1px solid',
        borderColor: `admin.status.${tone}.foreground`,
        bgcolor: `admin.status.${tone}.background`,
        color: `admin.status.${tone}.foreground`,
      }}
      data-testid="user-profile-status-banner"
    >
      <BlockIcon sx={{ fontSize: 16 }} />
      <Typography level="body-sm" sx={{ flex: '1 1 300px', color: 'inherit' }}>
        {user.isBanned ? (
          <>
            <strong>Suspended.</strong> They cannot sign in until reinstated.
          </>
        ) : (
          <>
            <strong>Restricted.</strong> They can sign in but cannot use AI features.
          </>
        )}
      </Typography>
      <Button
        size="sm"
        variant="outlined"
        color="neutral"
        onClick={user.isBanned ? onReinstate : onLiftRestriction}
        sx={{ bgcolor: 'admin.surface' }}
        data-testid="user-profile-reinstate-btn"
      >
        {user.isBanned ? 'Reinstate' : 'Lift restriction'}
      </Button>
    </Stack>
  );
};

/** The profile of one user: every write is a named action that opens its own dialog. */
export const UserProfileView: React.FC<UserProfileViewProps> = ({ user, tab, onTabChange, onBack }) => {
  const [action, setAction] = useState<ProfileAction | null>(null);
  // Revoking keys has no profile dialog of its own; it reuses the audited bulk flow for this one user.
  const [revokeKeysOpen, setRevokeKeysOpen] = useState(false);
  const queryClient = useQueryClient();
  const setComplianceUserId = useComplianceModal(state => state.setUserId);
  const openAdminLog = () => onTabChange('admin');

  // The palette ignores its single-key shortcuts while any dialog is open, so `c` never fires behind one.
  const profileCommands = useMemo<AdminCommand[]>(
    () => [
      // The header already shows Adjust credits and Suspend, so only the palette and shortcuts carry them.
      { id: 'credits', label: 'Adjust credits', shortcut: 'c', paletteOnly: true, run: () => setAction('credits') },
      {
        id: 'suspend',
        label: 'Suspend account',
        shortcut: 's',
        disabled: !!user.isBanned,
        paletteOnly: true,
        run: () => setAction('suspend'),
      },
      { id: 'revoke', label: 'Revoke API keys', run: () => setRevokeKeysOpen(true) },
    ],
    [user.isBanned]
  );

  const panel = () => {
    switch (tab) {
      case 'overview':
        return (
          <OverviewTab
            user={user}
            onAction={setAction}
            onViewActivity={() => onTabChange('activity')}
            onViewCredits={() => onTabChange('credits')}
            onAudit={openAdminLog}
          />
        );
      case 'activity':
        return <ActivityTab userId={user.id} onOpenCredits={() => onTabChange('credits')} />;
      case 'credits':
        return <CreditsTab user={user} onAdjust={() => setAction('credits')} />;
      case 'keys':
        return <ApiKeysTab user={user} />;
      case 'signins':
        return <SignInsTab user={user} />;
      case 'admin':
        return <AdminLogTab user={user} />;
    }
  };

  return (
    <Stack gap={2.5} data-testid="user-profile-view">
      <Breadcrumb name={displayName(user)} onBack={onBack} />
      <AdminCommandPalette commands={profileCommands} onOpenHelp={openHelpPanel} />
      <StatusBanner
        user={user}
        onReinstate={() => setAction('reinstate')}
        onLiftRestriction={() => setAction('restrict')}
      />
      <UserProfileHeader user={user} onAction={setAction} onCompliance={() => setComplianceUserId(user.id)} />
      <UserProfileStats user={user} />
      <UserRiskBadges userId={user.id} onOpenCompliance={() => setComplianceUserId(user.id)} />
      <Box>
        <UserProfileTabs value={tab} onChange={onTabChange} />
        <Box
          role="tabpanel"
          aria-label={USER_PROFILE_TAB_LABELS[tab]}
          sx={{ pt: 2.5 }}
          data-testid={`user-profile-panel-${tab}`}
        >
          {panel()}
        </Box>
      </Box>
      {action && (
        <ActionHost
          action={action}
          user={user}
          onClose={() => setAction(null)}
          onAudit={openAdminLog}
          onDeleted={onBack}
        />
      )}
      {revokeKeysOpen && (
        <BulkAbuseResponseModal
          selectedUserIds={[user.id]}
          recordAction="revoke"
          onClose={() => setRevokeKeysOpen(false)}
          onExecuted={() => {
            void queryClient.invalidateQueries({ queryKey: ['users'] });
            void queryClient.invalidateQueries({ queryKey: ['admin', 'users', user.id] });
            void queryClient.invalidateQueries({ queryKey: ['admin', 'user-api-keys', user.id] });
          }}
        />
      )}
    </Stack>
  );
};
