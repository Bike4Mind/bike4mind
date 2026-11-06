import React from 'react';
import { ApiKeyStatus } from '@bike4mind/common';
import { useAdminGetUserApiKeys } from '@client/app/hooks/data/userApiKeys';
import { useUserCreditHistory } from '@client/app/hooks/data/adminUserActivity';
import { RelativeTime, StatSparkline, StatStrip, StatTile } from '../../shared';
import { formatCredits } from './actions/creditAdjustment';
import { creditSpendFromHistory } from './creditSpend';
import { LEVEL_LABELS, latestSignIn, type AdminUserProfile } from './userProfileModel';

const SPEND_WINDOW_DAYS = 30;

const Pending = () => <span aria-label="Loading">-</span>;

/** Five numbers an admin checks first; each comes from data the page already loads. */
export const UserProfileStats: React.FC<{ user: AdminUserProfile }> = ({ user }) => {
  const creditHistory = useUserCreditHistory(user.id);
  const apiKeys = useAdminGetUserApiKeys(user.id);
  const spend = creditHistory.data ? creditSpendFromHistory(creditHistory.data, SPEND_WINDOW_DAYS) : null;
  const activeKeys = apiKeys.data?.apiKeys.filter(key => key.status === ApiKeyStatus.ACTIVE) ?? [];
  const lastKeyUse = activeKeys
    .map(key => key.lastUsedAt)
    .filter((at): at is Date => !!at)
    .sort((a, b) => new Date(b).getTime() - new Date(a).getTime())[0];
  const signIn = latestSignIn(user);
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
          creditHistory.isError
            ? 'History unavailable'
            : spend?.estimated
              ? 'Estimate: early history is incomplete'
              : 'From the daily balance'
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
        value={signIn ? <RelativeTime at={signIn.loginTime} /> : 'Never'}
        comparison={signIn ? [signIn.location, signIn.browser].filter(Boolean).join(' \u00b7 ') : undefined}
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
