import React from 'react';
import { ApiKeyStatus } from '@bike4mind/common';
import { useAdminGetUserApiKeys } from '@client/app/hooks/data/userApiKeys';
import { useAdminCreditSummary } from '@client/app/hooks/data/adminUserCredits';
import { useUserSignIns } from '@client/app/hooks/data/adminUserTimeline';
import { RelativeTime, StatSparkline, StatStrip, StatTile } from '../../shared';
import { formatCredits } from './actions/creditAdjustment';
import { LEVEL_LABELS, latestSignIn, type AdminUserProfile } from './userProfileModel';

const SPEND_WINDOW_DAYS = 30;

const Pending = () => <span aria-label="Loading">-</span>;

/** Five numbers an admin checks first; each comes from data the page already loads. */
export const UserProfileStats: React.FC<{ user: AdminUserProfile }> = ({ user }) => {
  // The same charged-credits figure as the Credits tab's "Spent, 30 days", so the two never disagree.
  const creditSummary = useAdminCreditSummary(user.id);
  const apiKeys = useAdminGetUserApiKeys(user.id);
  // Shares the Sign-ins tab's query. GET /api/users/:id strips loginRecords, so the auth audit is the source.
  const signIns = useUserSignIns(user.id);
  const spend = creditSummary.data
    ? {
        total: creditSummary.data.spent.last30d,
        writtenOff: creditSummary.data.writtenOff.last30d,
        daily: creditSummary.data.daily.slice(-SPEND_WINDOW_DAYS).map(day => day.credits),
      }
    : null;
  const activeKeys = apiKeys.data?.apiKeys.filter(key => key.status === ApiKeyStatus.ACTIVE) ?? [];
  const lastKeyUse = activeKeys
    .map(key => key.lastUsedAt)
    .filter((at): at is Date => !!at)
    .sort((a, b) => new Date(b).getTime() - new Date(a).getTime())[0];
  const signIn = latestSignIn(signIns.data?.pages ?? []);
  const network = user.signupMeta;
  const level = user.level ? (LEVEL_LABELS[user.level] ?? user.level) : null;

  return (
    <StatStrip aria-label="Account at a glance">
      <StatTile
        label="Credit balance"
        value={formatCredits(user.currentCredits ?? 0)}
        comparison={level ? `${level} account` : undefined}
      />
      <StatTile
        label={`Spend, last ${SPEND_WINDOW_DAYS} days`}
        value={spend ? formatCredits(spend.total) : <Pending />}
        sparkline={
          spend && spend.daily.length > 1 ? (
            <StatSparkline values={spend.daily} label={`Daily credit spend, last ${SPEND_WINDOW_DAYS} days`} />
          ) : undefined
        }
        comparison={
          creditSummary.isError
            ? 'Spend unavailable'
            : spend && spend.writtenOff > 0
              ? `Credits charged; ${formatCredits(spend.writtenOff)} more written off`
              : 'Credits charged'
        }
      />
      <StatTile
        label="Active API keys"
        value={apiKeys.data ? activeKeys.length : apiKeys.isError ? '-' : <Pending />}
        comparison={
          lastKeyUse ? <RelativeTime prefix="Last used" at={lastKeyUse} /> : apiKeys.data ? 'Never used' : undefined
        }
      />
      <StatTile
        label="Last sign-in"
        value={
          signIn ? <RelativeTime at={signIn.at} /> : signIns.data ? 'Unknown' : signIns.isError ? '-' : <Pending />
        }
        comparison={
          signIn
            ? [signIn.location, signIn.browser].filter(Boolean).join(' \u00b7 ')
            : signIns.data
              ? 'No successful sign-in in loaded history'
              : signIns.isError
                ? 'Sign-in history unavailable'
                : undefined
        }
      />
      <StatTile
        label="Signup network"
        value={network?.isDatacenter ? 'Datacenter' : (network?.country ?? 'Unknown')}
        valueColor={network?.isDatacenter ? 'admin.status.bad.foreground' : undefined}
        comparison={network?.asnOrg ?? (network?.asn ? `AS${network.asn}` : 'No network recorded')}
      />
    </StatStrip>
  );
};
