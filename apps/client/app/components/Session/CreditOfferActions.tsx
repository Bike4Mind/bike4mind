import { useState } from 'react';
import { Box, Button } from '@mui/joy';
import { useSelectedAccount } from '@client/app/components/Credits/AccountSelector';
import { useUser } from '@client/app/contexts/UserContext';
import { useGetOrganization } from '@client/app/hooks/data/organizations';
import { useGetSubscriptions } from '@client/app/hooks/data/subscriptions';
import { isCancellableSubscriptionStatus } from '@client/lib/subscriptions/types';
import { getBrandName } from '@client/config/general';
import { SubscribeButton, SessionCreditsButton, SECONDARY_CREDIT_BUTTON_PROPS } from './SessionCreditsButtons';

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Plain-text request a member can send an org admin. */
export function buildAdminRequestMessage(orgName: string, memberName: string): string {
  return `Hi, ${orgName} has run out of ${getBrandName()} credits and I can't continue my work. Could you add more credits to the organization? Thanks, ${memberName}`;
}

/** No member-facing notify endpoint exists yet, so this opens a mailto to the billing contact or copies the message. */
function AskAdminButton({ organizationId, secondary = false }: { organizationId: string; secondary?: boolean }) {
  const { currentUser } = useUser();
  const { data: organization } = useGetOrganization(organizationId);
  const [copied, setCopied] = useState(false);

  const message = buildAdminRequestMessage(
    organization?.name ?? 'our organization',
    currentUser?.name || currentUser?.username || 'a teammate'
  );
  const contact = organization?.billingContact?.trim();
  const mailto =
    contact && EMAIL_PATTERN.test(contact)
      ? `mailto:${contact}?subject=${encodeURIComponent('Request for more credits')}&body=${encodeURIComponent(message)}`
      : null;

  const handleClick = async () => {
    if (mailto) {
      window.location.href = mailto;
      return;
    }
    try {
      await navigator.clipboard.writeText(message);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };

  return (
    <Button
      onClick={handleClick}
      data-testid="credit-offer-ask-admin-btn"
      {...(secondary && SECONDARY_CREDIT_BUTTON_PROPS)}
    >
      {copied ? 'Message copied' : 'Ask your admin'}
    </Button>
  );
}

interface CreditOfferActionsProps {
  /** Only changes the pack button's wording: `low` is a top-up, `out` is buying a pack. */
  moment: 'low' | 'out';
}

/** Which remediation the account gets; see CreditOfferActions for how it is decided. */
export type CreditOfferKind =
  { kind: 'org'; organizationId: string } | { kind: 'subscriber' } | { kind: 'unsubscribed' };

/**
 * The actions for one kind of account, with no data of its own beyond the org lookup inside Ask
 * your admin - so a preview can render every kind side by side.
 */
export function CreditOfferActionsView({ moment, account }: CreditOfferActionsProps & { account: CreditOfferKind }) {
  if (account.kind === 'org') {
    // Low is a heads-up, so its one action stays secondary; out of credits makes it the primary one.
    return <AskAdminButton organizationId={account.organizationId} secondary={moment === 'low'} />;
  }

  if (account.kind === 'subscriber') {
    return (
      <Box data-testid="credit-offer-actions" sx={{ display: 'flex', gap: 1, flexWrap: 'wrap' }}>
        <SessionCreditsButton
          secondary={moment === 'low'}
          label={moment === 'low' ? 'Add Credits' : 'Buy a credit pack'}
        />
      </Box>
    );
  }

  return (
    <Box data-testid="credit-offer-actions" sx={{ display: 'flex', gap: 1, flexWrap: 'wrap' }}>
      <SubscribeButton label="Subscribe" />
      <SessionCreditsButton secondary label={moment === 'low' ? 'Add Credits' : 'Buy a credit pack'} />
    </Box>
  );
}

/**
 * Remediation actions for the low-credit and out-of-credits moments. Personal accounts get the
 * Pro plan as the one primary action and a credit pack as the quieter alternative (subscribers
 * get only the pack); org members cannot self-purchase (see CreditsModal's canPurchaseCredits), so they get an Ask your admin action.
 */
export function CreditOfferActions({ moment }: CreditOfferActionsProps) {
  const selectedAccount = useSelectedAccount(s => s.selectedAccount);
  const isOrgAccount = !!selectedAccount && !selectedAccount.personal;
  const subscriptions = useGetSubscriptions({ enabled: !isOrgAccount });
  // Same "has a plan" test CreditsModal uses; a subscriber is offered a top-up, never the plan they hold.
  const hasPlan = (subscriptions.data ?? []).some(sub => isCancellableSubscriptionStatus(sub.status));

  const account: CreditOfferKind = isOrgAccount
    ? { kind: 'org', organizationId: selectedAccount.id }
    : hasPlan
      ? { kind: 'subscriber' }
      : { kind: 'unsubscribed' };
  return <CreditOfferActionsView moment={moment} account={account} />;
}
