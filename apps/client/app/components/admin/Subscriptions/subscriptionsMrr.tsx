import { Stack, Typography } from '@mui/joy';
import { MRR_CURRENCY, type AdminSubscriptionsMrrTotal } from '@client/app/utils/adminSubscriptionsFilter';
import { AnalyticsTermHelp } from '../EventMetrics/components/AnalyticsTermHelp';
import { formatMoney } from '../shared/formatMoney';

// Must stay in sync with the MRR definition in docs/admin-subscriptions-spec.md section 5.3 and
// server/admin/subscriptionsList/subscriptionMrr.ts.
const MRR_DEFINITION = [
  'Monthly recurring revenue: what Stripe bills each active or past due subscription, the price per seat times the seats, converted to a month (a yearly price counts one twelfth). Before discounts.',
  'Not counted: comps, trials, and canceled, unpaid, incomplete or paused subscriptions.',
  'Past due subscriptions count, and the Past due tile shows their share as MRR at risk.',
  `Totals are in ${MRR_CURRENCY.toUpperCase()}. A subscription billed in another currency, or with no amount from Stripe yet, is left out of the total and counted under it.`,
];

export function MrrDefinitionHelp() {
  return (
    <AnalyticsTermHelp
      term="MRR"
      testId="admin-subscriptions-mrr-help-btn"
      description={
        <Stack gap={0.75} data-testid="admin-subscriptions-mrr-definition">
          {MRR_DEFINITION.map(line => (
            <Typography key={line} level="body-xs" sx={{ color: 'inherit' }}>
              {line}
            </Typography>
          ))}
        </Stack>
      }
    />
  );
}

/** "Not in total: 3 with no amount yet, 1 in another currency", or null when every counted row is summed. */
export function mrrExclusionNote({
  unpriced,
  otherCurrency,
}: Pick<AdminSubscriptionsMrrTotal, 'unpriced' | 'otherCurrency'>): string | null {
  const parts: string[] = [];
  if (unpriced > 0) parts.push(`${unpriced.toLocaleString()} with no amount yet`);
  if (otherCurrency > 0) {
    parts.push(`${otherCurrency.toLocaleString()} in ${otherCurrency === 1 ? 'another currency' : 'other currencies'}`);
  }
  return parts.length > 0 ? `Not in total: ${parts.join(', ')}` : null;
}

/** "$38.00 MRR at risk", plus how many past due rows the amount leaves out. */
export function atRiskNote(total: AdminSubscriptionsMrrTotal): string {
  const atRisk = `${formatMoney(total.amount, total.currency)} MRR at risk`;
  const left = total.unpriced + total.otherCurrency;
  return left > 0 ? `${atRisk}, ${left.toLocaleString()} not in total` : atRisk;
}
