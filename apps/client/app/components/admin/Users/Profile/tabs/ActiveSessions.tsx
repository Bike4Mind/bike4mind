import React, { useState } from 'react';
import { Box, Button, Stack, Typography } from '@mui/joy';
import { toast } from 'sonner';
import type { AdminUserSession, AuthSessionCreatedVia } from '@bike4mind/common';
import { useRevokeUserSessions, useUserSessions } from '@client/app/hooks/data/adminUserSessions';
import { describeUserAgent } from '@client/app/utils/describeUserAgent';
import {
  ActionDialog,
  ADMIN_REASON_PRESETS,
  DataTable,
  RelativeTime,
  SectionCard,
  StatusChip,
  type DataColumn,
} from '../../../shared';
import { adminUpdateErrorMessage } from '../actions/useAdminUserUpdate';
import { displayName, type AdminUserProfile } from '../userProfileModel';
import { SupportAccessHistory } from './SupportAccessHistory';

const CREATED_VIA_LABELS: Readonly<Record<AuthSessionCreatedVia, string>> = {
  otc: 'One-time code',
  'otc-registration': 'Signup code',
  mfa: 'Two-factor',
  'mfa-setup': 'Two-factor setup',
  oauth: 'Social sign-in',
  okta: 'Okta',
  saml: 'SSO (SAML)',
  impersonation: 'Admin sign-in as user',
  emergency: 'Emergency access',
  identify: 'Identity link',
  'oauth-token': 'OAuth app',
  device: 'Device code',
  'legacy-migration': 'Carried over',
};

/** "Browser on OS" from the stored fields, else parsed from the user agent (most sessions store only that); '-' when unknown. */
export const sessionDevice = ({ device }: Pick<AdminUserSession, 'device'>): string => {
  const stored = [device?.browser, device?.os].filter(Boolean).join(' on ');
  if (stored) return stored;
  const { label } = describeUserAgent(device?.userAgent);
  return label === 'Unknown device' ? '-' : label;
};

const oneSessionSubject = (session: AdminUserSession): string => {
  const device = sessionDevice(session);
  return device === '-' ? 'This session' : device;
};

type RevokeTarget = { kind: 'one'; session: AdminUserSession } | { kind: 'all' };

/**
 * The user's live sessions with per-session and "everywhere" sign-out. One session clears its
 * refresh token (its access token lapses within its short TTL); everywhere also bumps the token
 * version and drops trusted devices, so it takes effect on the next request.
 */
export const ActiveSessions: React.FC<{ user: AdminUserProfile }> = ({ user }) => {
  const sessions = useUserSessions(user.id);
  const revoke = useRevokeUserSessions(user.id);
  const [target, setTarget] = useState<RevokeTarget | null>(null);
  const name = displayName(user);

  const columns: readonly DataColumn<AdminUserSession>[] = [
    { id: 'signedIn', label: 'Signed in', render: row => <RelativeTime at={new Date(row.createdAt)} /> },
    { id: 'lastActive', label: 'Last active', render: row => <RelativeTime at={new Date(row.lastUsedAt)} /> },
    {
      id: 'method',
      label: 'Method',
      render: row =>
        row.impersonated ? (
          <StatusChip tone="warn" label="Admin sign-in as user" />
        ) : (
          (CREATED_VIA_LABELS[row.createdVia] ?? row.createdVia)
        ),
    },
    { id: 'device', label: 'Device', render: sessionDevice },
    {
      id: 'ip',
      label: 'IP address',
      render: row => (
        <Box component="span" sx={{ fontFamily: 'code', fontSize: 12 }}>
          {row.device?.ip || '-'}
        </Box>
      ),
    },
    { id: 'location', label: 'Location', render: row => row.device?.location || '-' },
    {
      id: 'actions',
      label: 'Actions',
      render: row =>
        row.current ? (
          <Typography level="body-xs" sx={{ color: 'admin.inkMuted' }} data-testid="user-sessions-current-label">
            This session
          </Typography>
        ) : (
          <Button
            size="sm"
            variant="plain"
            color="danger"
            onClick={() => setTarget({ kind: 'one', session: row })}
            data-testid="user-sessions-revoke-btn"
          >
            Sign out
          </Button>
        ),
    },
  ];

  const handleConfirm = async (reason: string) => {
    if (!target) return;
    try {
      await revoke.mutateAsync({ sid: target.kind === 'one' ? target.session.sid : undefined, reason });
    } catch (error) {
      toast.error(adminUpdateErrorMessage(error, 'The session was not signed out.'));
      throw error;
    }
    setTarget(null);
    toast.success(target.kind === 'one' ? 'Session signed out' : `${name} was signed out everywhere`);
  };

  return (
    <>
      <SupportAccessHistory userId={user.id} />
      <SectionCard
        title="Active sessions"
        body="custom"
        action={
          <Button
            size="sm"
            variant="outlined"
            color="danger"
            onClick={() => setTarget({ kind: 'all' })}
            data-testid="user-sessions-revoke-all-btn"
          >
            Sign out everywhere
          </Button>
        }
        data-testid="user-profile-sessions"
      >
        <DataTable
          rows={sessions.data ?? []}
          columns={columns}
          getRowId={row => row.sid}
          label="Active sessions"
          loading={sessions.isLoading}
          error={sessions.isError ? 'Sessions could not be loaded.' : undefined}
          onRetry={() => void sessions.refetch()}
          empty={
            <Typography level="body-sm" sx={{ p: 2, color: 'admin.inkMuted' }}>
              No active sessions.
            </Typography>
          }
          testId="user-sessions-table"
          rowTestId={() => 'user-sessions-row'}
        />
        <Stack sx={{ px: 2, py: 1.5, borderTop: '1px solid', borderColor: 'admin.border' }}>
          <Typography level="body-xs" sx={{ color: 'admin.inkMuted' }}>
            Signing out one session ends it within minutes; signing out everywhere also forgets trusted devices and
            takes effect immediately.
          </Typography>
        </Stack>
        {target && (
          <ActionDialog
            open
            onClose={() => setTarget(null)}
            title={target.kind === 'one' ? `Sign out this session?` : `Sign ${name} out everywhere?`}
            description={
              target.kind === 'one'
                ? `${oneSessionSubject(target.session)} will need to sign in again. Other sessions stay signed in.`
                : 'Every session ends and trusted devices are forgotten, so the next sign-in asks for two-factor again.'
            }
            reasonPresets={ADMIN_REASON_PRESETS.sessionRevoke}
            confirmLabel={target.kind === 'one' ? 'Sign out session' : 'Sign out everywhere'}
            tone="danger"
            pending={revoke.isPending}
            onConfirm={handleConfirm}
            data-testid="user-sessions-revoke-dialog"
          />
        )}
      </SectionCard>
    </>
  );
};
