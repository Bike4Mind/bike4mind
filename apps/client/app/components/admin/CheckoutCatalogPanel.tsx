import { Sheet, Stack, Typography } from '@mui/joy';
import { formatUsdAmount, type TeamPlanSettings } from '@bike4mind/common';
import {
  listCatalogPacks,
  listCatalogPlans,
  type CatalogPack,
  type CatalogPlan,
  type CatalogPlanGrant,
} from '@client/lib/checkoutCatalog';
import { DataTable, StatusChip, type DataColumn } from './shared';
import { adminSurface } from './shared/adminStyles';

const formatCredits = (credits: number) => credits.toLocaleString('en-US');

const describeGrant = (grant: CatalogPlanGrant): string => {
  switch (grant.kind) {
    case 'credits':
      return `${formatCredits(grant.credits)} credits`;
    case 'perSeat':
      return `${formatCredits(grant.creditsPerSeat)} credits per seat, ${grant.minSeats}-${grant.maxSeats} seats`;
    case 'unavailable':
      return 'Settings could not be loaded';
  }
};

// The catalog is static, so the tables never reach their error state.
const noRetry = () => undefined;

const PACK_COLUMNS: readonly DataColumn<CatalogPack>[] = [
  { id: 'description', label: 'Pack', render: pack => pack.description },
  {
    id: 'price',
    label: 'Price (USD)',
    numeric: true,
    render: pack => formatUsdAmount(pack.priceUsd),
    sortValue: pack => pack.priceUsd,
  },
  {
    id: 'credits',
    label: 'Credits granted',
    numeric: true,
    render: pack => formatCredits(pack.credits),
    sortValue: pack => pack.credits,
  },
];

const PLAN_COLUMNS: readonly DataColumn<CatalogPlan>[] = [
  { id: 'name', label: 'Plan', render: plan => plan.name },
  {
    id: 'priceId',
    label: 'Stripe price id',
    render: plan =>
      plan.priceId ? (
        <Typography level="body-xs" sx={{ fontFamily: 'code', wordBreak: 'break-all' }}>
          {plan.priceId}
        </Typography>
      ) : (
        <StatusChip tone="warn" label="Not configured" />
      ),
  },
  { id: 'interval', label: 'Billed', render: plan => plan.interval },
  { id: 'grant', label: 'Grant', render: plan => describeGrant(plan.grant) },
  { id: 'availability', label: 'Availability', render: plan => plan.availability ?? 'Always' },
];

/**
 * Read-only view of every credit pack and plan checkout sells, from the constants checkout charges
 * from (see lib/checkoutCatalog). Packs are charged as an ad-hoc amount, so they have no price id.
 * Not a SectionCard: its body is a definition list, and these are tables.
 */
export const CheckoutCatalogPanel = ({ teamPlan }: { teamPlan: TeamPlanSettings | undefined }) => (
  <Sheet variant="outlined" sx={{ ...adminSurface, p: 2 }} data-testid="admin-growth-pricing-section-catalog">
    <Stack spacing={2}>
      <Stack spacing={0.5}>
        <Typography level="title-md" sx={{ color: 'admin.ink' }}>
          What checkout sells
        </Typography>
        <Typography level="body-sm" sx={{ color: 'text.secondary' }}>
          Credit packs and plans as checkout in this build charges and grants them. Prices and price ids are set in code
          and deploy environment variables, so they cannot be edited here. Custom credit amounts sell at Price Per
          Credit above.
        </Typography>
      </Stack>
      <DataTable
        rows={listCatalogPacks()}
        columns={PACK_COLUMNS}
        getRowId={pack => pack.id}
        label="Credit packs"
        onRetry={noRetry}
        testId="admin-catalog-packs-table"
        rowTestId={pack => `admin-catalog-pack-row-${pack.id}`}
      />
      <DataTable
        rows={listCatalogPlans(teamPlan)}
        columns={PLAN_COLUMNS}
        getRowId={plan => plan.name}
        label="Plans"
        onRetry={noRetry}
        testId="admin-catalog-plans-table"
        rowTestId={plan => `admin-catalog-plan-row-${plan.name}`}
      />
    </Stack>
  </Sheet>
);
