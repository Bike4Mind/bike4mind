import React, { useMemo, useState } from 'react';
import { Box, Button, Link, Stack, Typography } from '@mui/joy';
import { useNavigate } from '@tanstack/react-router';
import { authMethodLabel, type UserSignIn, type UserSignInResult } from '@bike4mind/common';
import { useUserSignIns, useUserSignupCluster } from '@client/app/hooks/data/adminUserTimeline';
import type { AdminStatusTone } from '@client/app/utils/themes/admin';
import { DataTable, Fact, RelativeTime, SectionCard, StatusChip, type DataColumn } from '../../../shared';
import { BlockIpDialog } from '../../../BlockedIPs/IpBlockDialogs';
import { useOpenUserProfile } from '../useOpenUserProfile';
import { RowAction } from './cardActions';
import { ActiveSessions } from './ActiveSessions';
import type { AdminUserProfile } from '../userProfileModel';

const Muted: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <Typography level="body-sm" sx={{ p: 2, color: 'admin.inkMuted' }}>
    {children}
  </Typography>
);

const Mono: React.FC<{ value?: string | null }> = ({ value }) => (
  <Box component="span" sx={{ fontFamily: 'code', fontSize: 12 }}>
    {value || '-'}
  </Box>
);

const RESULT_CHIPS: Readonly<Record<UserSignInResult, { label: string; tone: AdminStatusTone }>> = {
  success: { label: 'Success', tone: 'good' },
  failed: { label: 'Failed', tone: 'bad' },
  blocked: { label: 'Blocked', tone: 'bad' },
};

// Why a refused attempt was refused, in the chip itself so the status never rests on color.
const REFUSAL_REASONS: Readonly<Record<string, string>> = {
  step_up_failed: '2FA failed',
  session_reuse_revoked: 'session reuse',
  refresh_replay_capped: 'token replay',
  refresh_recovery_capped: 'token replay',
  oauth_refresh_reuse_revoked: 'token reuse',
};

export const signInResultLabel = (signIn: Pick<UserSignIn, 'result' | 'event'>): string => {
  const base = RESULT_CHIPS[signIn.result].label;
  const reason = signIn.result === 'success' ? undefined : REFUSAL_REASONS[signIn.event];
  return reason ? `${base}: ${reason}` : base;
};

export const signInDevice = (signIn: Pick<UserSignIn, 'browser' | 'operatingSystem' | 'deviceType'>): string => {
  const software = [signIn.browser, signIn.operatingSystem].filter(Boolean).join(' on ');
  return [software, signIn.deviceType].filter(Boolean).join(' \u00b7 ') || '-';
};

const SIGN_IN_COLUMNS: readonly DataColumn<UserSignIn>[] = [
  { id: 'when', label: 'When', render: row => <RelativeTime at={row.at} /> },
  { id: 'method', label: 'Method', render: row => authMethodLabel(row.method) ?? '-' },
  { id: 'ip', label: 'IP address', render: row => <Mono value={row.ip} /> },
  { id: 'location', label: 'Location', render: row => row.location || '-' },
  { id: 'device', label: 'Device', render: signInDevice },
  {
    id: 'result',
    label: 'Result',
    render: row => (
      <StatusChip
        tone={RESULT_CHIPS[row.result].tone}
        label={signInResultLabel(row)}
        data-testid="user-signin-result"
      />
    ),
  },
];

const emailDomain = (email?: string | null) => email?.split('@')[1]?.toLowerCase();

const networkLabel = (meta: NonNullable<AdminUserProfile['signupMeta']>): string | undefined => {
  if (meta.asn === null) return undefined;
  const operator = meta.asnOrg ? ` ${meta.asnOrg}` : '';
  const kind =
    meta.isDatacenter === true ? ' (hosting network)' : meta.isDatacenter === false ? ' (consumer network)' : '';
  return `AS${meta.asn}${operator}${kind}`;
};

const SignupCluster: React.FC<{ userId: string }> = ({ userId }) => {
  const cluster = useUserSignupCluster(userId);
  const openProfile = useOpenUserProfile();
  if (cluster.isLoading) return <>Checking...</>;
  if (cluster.isError || !cluster.data) return <>Could not be checked</>;
  const { fingerprintAvailable, matches, truncated, windowDays } = cluster.data;
  if (!fingerprintAvailable) return <>No signup fingerprint recorded</>;
  if (matches.length === 0) return <>No other account from this client within {windowDays} days</>;
  return (
    <Stack gap={0.5} data-testid="user-signup-cluster">
      <StatusChip
        tone="warn"
        label={`${matches.length}${truncated ? '+' : ''} other account${matches.length === 1 ? '' : 's'} from this client within ${windowDays} days`}
      />
      {matches.map(match => (
        <Link
          key={match.id}
          component="button"
          type="button"
          level="body-sm"
          onClick={() => void openProfile(match.id)}
          sx={{ alignSelf: 'flex-start', textAlign: 'left' }}
          data-testid="user-signup-cluster-link"
        >
          {match.name}
        </Link>
      ))}
    </Stack>
  );
};

/** How the account was made: the record written once at signup plus accounts that share its client. */
const SignupRecord: React.FC<{ user: AdminUserProfile }> = ({ user }) => {
  const navigate = useNavigate();
  const meta = user.signupMeta ?? undefined;
  const domain = emailDomain(user.email);
  const method = authMethodLabel(user.acquisition?.signupMethod);
  const [blockingIp, setBlockingIp] = useState(false);
  return (
    <SectionCard title="Signup" data-testid="user-profile-signup">
      <Fact label="Signed up">{user.createdAt && <RelativeTime at={user.createdAt} />}</Fact>
      <Fact label="Method">
        {method && <StatusChip tone="neutral" label={method} data-testid="user-signup-method-badge" />}
      </Fact>
      <Fact label="Email domain">
        {domain && (
          <Link
            component="button"
            type="button"
            onClick={() => void navigate({ to: '/admin', search: { tab: 'users', groupBy: 'emailDomain' } })}
            data-testid="user-signup-domain-link"
          >
            {domain}
          </Link>
        )}
      </Fact>
      <Fact label="Email">
        {user.emailVerified ? (
          <StatusChip tone="good" label="Verified" data-testid="user-signup-verification" />
        ) : (
          <StatusChip tone="warn" label="Not verified" data-testid="user-signup-verification" />
        )}
      </Fact>
      <Fact label="IP address">
        {meta?.ip && (
          <Stack direction="row" alignItems="center" gap={1}>
            <Mono value={meta.ip} />
            <RowAction onClick={() => setBlockingIp(true)} data-testid="user-signup-block-ip-btn">
              Block this IP
            </RowAction>
          </Stack>
        )}
        {blockingIp && meta?.ip && <BlockIpDialog initialIp={meta.ip} onClose={() => setBlockingIp(false)} />}
      </Fact>
      <Fact label="Country">{meta?.country}</Fact>
      <Fact label="Network">{meta && networkLabel(meta)}</Fact>
      <Fact label="User agent">
        {meta?.userAgent && (
          <Box component="span" sx={{ fontFamily: 'code', fontSize: 12 }}>
            {meta.userAgent}
          </Box>
        )}
      </Fact>
      <Fact label="Signup cluster">
        <SignupCluster userId={user.id} />
      </Fact>
    </SectionCard>
  );
};

/** Sign-in attempts from the auth audit (kept 12 months), newest first, the live sessions, then the signup record. */
export const SignInsTab: React.FC<{ user: AdminUserProfile }> = ({ user }) => {
  const signIns = useUserSignIns(user.id);
  const rows = useMemo(() => signIns.data?.pages.flatMap(page => page.entries) ?? [], [signIns.data]);
  return (
    <Stack gap={2}>
      <SectionCard
        title="Sign-ins"
        body="custom"
        action={
          <Typography level="body-xs" sx={{ color: 'admin.inkMuted' }}>
            Last 12 months
          </Typography>
        }
        data-testid="user-profile-sign-ins"
      >
        <DataTable
          rows={rows}
          columns={SIGN_IN_COLUMNS}
          getRowId={row => row.id}
          label="Sign-ins"
          loading={signIns.isLoading}
          error={signIns.isError ? 'Sign-ins could not be loaded.' : undefined}
          onRetry={() => void signIns.refetch()}
          empty={<Muted>No sign-ins recorded in the last 12 months.</Muted>}
          testId="user-signins-table"
          rowTestId={() => 'user-signins-row'}
        />
        <Stack
          direction="row"
          flexWrap="wrap"
          gap={1}
          alignItems="center"
          sx={{ px: 2, py: 1.5, borderTop: '1px solid', borderColor: 'admin.border' }}
        >
          <Typography level="body-xs" sx={{ color: 'admin.inkMuted', mr: 'auto' }}>
            Location and device come from the browser at sign-in; the network is recorded only at signup.
          </Typography>
          {signIns.hasNextPage && (
            <Button
              size="sm"
              variant="outlined"
              color="neutral"
              loading={signIns.isFetchingNextPage}
              onClick={() => void signIns.fetchNextPage()}
              data-testid="user-signins-load-more-btn"
            >
              Load more
            </Button>
          )}
        </Stack>
      </SectionCard>
      <ActiveSessions user={user} />
      <SignupRecord user={user} />
    </Stack>
  );
};
