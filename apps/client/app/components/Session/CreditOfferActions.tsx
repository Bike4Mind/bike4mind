import { useEffect, useState } from 'react';
import { Box, Button } from '@mui/joy';
import { useSelectedAccount } from '@client/app/components/Credits/AccountSelector';
import { useUser } from '@client/app/contexts/UserContext';
import { useGetOrganization } from '@client/app/hooks/data/organizations';
import { useGetSubscriptions } from '@client/app/hooks/data/subscriptions';
import { isCancellableSubscriptionStatus } from '@bike4mind/server-utils/lib/subscriptions/types';
import { getBrandName } from '@client/config/general';
import { trackUpsell, type UpsellSurface } from '@client/app/utils/funnelEvents';
import { SubscribeButton, SessionCreditsButton, SECONDARY_CREDIT_BUTTON_PROPS } from './SessionCreditsButtons';

/** GA4 `surface` ids for the prompts that carry these actions; stable, they are report dimensions. */
export const CREDIT_OFFER_SURFACES = {
  lowCreditsWarning: 'low_credits_warning',
  outOfCreditsBanner: 'out_of_credits_banner',
  insufficientCreditsNotice: 'insufficient_credits_notice',
  affordableModelOffer: 'affordable_model_offer',
} as const satisfies Record<string, UpsellSurface>;

export const CREDIT_OFFER_TRIGGERS = { low: 'low_balance', out: 'insufficient_credits' } as const;

// The `plan` an action offers; Professional matches the plan name begin_checkout reports.
const PRO_PLAN = 'Professional';
const CREDIT_PACK = 'credit_pack';

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
  /**
   * `low` is a heads-up under the copy: a single action stays secondary and Subscribe leads on the
   * left. `out` blocks sending and its actions sit at the right edge: they are primary, with
   * Subscribe last, on the far right.
   */
  moment: 'low' | 'out';
  /** Reports clicks as `upsell_click` under this surface. Omitted (e.g. a preview), nothing is sent. */
  surface?: UpsellSurface;
}

/** Which remediation the account gets; see CreditOfferActions for how it is decided. */
export type CreditOfferKind =
  { kind: 'org'; organizationId: string } | { kind: 'subscriber' } | { kind: 'unsubscribed' };

/**
 * The actions for one kind of account, with no data of its own beyond the org lookup inside Ask
 * your admin - so a preview can render every kind side by side.
 */
export function CreditOfferActionsView({
  moment,
  surface,
  account,
}: CreditOfferActionsProps & { account: CreditOfferKind }) {
  const trackClick = (plan: string) =>
    surface ? () => trackUpsell('click', { surface, trigger: CREDIT_OFFER_TRIGGERS[moment], plan }) : undefined;

  if (account.kind === 'org') {
    // Low is a heads-up, so its one action stays secondary; out of credits makes it the primary one.
    return <AskAdminButton organizationId={account.organizationId} secondary={moment === 'low'} />;
  }

  if (account.kind === 'subscriber') {
    return (
      <Box data-testid="credit-offer-actions" sx={{ display: 'flex', gap: 1, flexWrap: 'wrap' }}>
        <SessionCreditsButton label="Top up" secondary={moment === 'low'} onClick={trackClick(CREDIT_PACK)} />
      </Box>
    );
  }

  return (
    <Box data-testid="credit-offer-actions" sx={{ display: 'flex', gap: 1, flexWrap: 'wrap' }}>
      {moment === 'low' && <SubscribeButton label="Get Pro" onClick={trackClick(PRO_PLAN)} />}
      <SessionCreditsButton label="Top up" secondary onClick={trackClick(CREDIT_PACK)} />
      {moment === 'out' && <SubscribeButton label="Get Pro" onClick={trackClick(PRO_PLAN)} />}
    </Box>
  );
}

/**
 * Remediation actions for the low-credit and out-of-credits moments. Personal accounts get the
 * Pro plan as the one primary action and a credit pack as the quieter alternative (subscribers
 * get only the pack); org members cannot self-purchase (see CreditsSection's canPurchaseCredits), so they get an Ask your admin action.
 */
export function CreditOfferActions({ moment, surface }: CreditOfferActionsProps & { surface: UpsellSurface }) {
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
  // Wait for the subscription lookup, or a subscriber would first be counted as seeing the Pro offer.
  const accountResolved = isOrgAccount || !subscriptions.isPending;

  useEffect(() => {
    // Ask your admin sells nothing, so an org member's prompt is not an upsell impression.
    if (!accountResolved || account.kind === 'org') return;
    trackUpsell('impression', {
      surface,
      trigger: CREDIT_OFFER_TRIGGERS[moment],
      plan: account.kind === 'unsubscribed' ? PRO_PLAN : CREDIT_PACK,
    });
  }, [accountResolved, account.kind, surface, moment]);

  return <CreditOfferActionsView moment={moment} surface={surface} account={account} />;
}
