import { useMemo } from 'react';
import { Link as RouterLink } from '@tanstack/react-router';
import { Button, Chip, Link, Stack, Typography } from '@mui/joy';
import { CreditHolderType, type SpendAccountRow } from '@bike4mind/common';
import { ChartSection, InlineBar, SectionCard } from '../shared';
import { adminOrganizationHref } from '../organizationsTabSearch';
import { UserFeaturesPanel } from './FeatureCostSection';
import { SpendBucketTable } from './SpendBucketTable';
import { SpendChart } from './SpendChart';
import { formatShare, formatUsd, type SpendRange } from './spendExplorerModel';
import { SEGMENT_LABELS } from './seriesLabels';
import { useSpendTimeline } from './useSpendExplorer';

const ACCOUNT_CHART_ID = 'spend-account-chart';

type AccountSpendPanelProps = {
  account: SpendAccountRow;
  range: SpendRange;
  onClose: () => void;
};

/**
 * One user's spend over the range - every call they ran, whoever paid - split by model,
 * with their model mix and links to the orgs that were billed.
 */
export function AccountSpendPanel({ account, range, onClose }: AccountSpendPanelProps) {
  const timeline = useSpendTimeline({ range, splitBy: 'model', userId: account.accountId });

  const modelMix = useMemo(() => {
    const totals = new Map<string, number>();
    for (const bucket of timeline.data?.buckets ?? []) {
      for (const [model, cost] of Object.entries(bucket.series ?? {}))
        totals.set(model, (totals.get(model) ?? 0) + cost);
    }
    const rows = [...totals.entries()].sort((a, b) => b[1] - a[1]);
    return { rows, total: rows.reduce((sum, [, cost]) => sum + cost, 0) };
  }, [timeline.data]);

  const profileLink = (
    <RouterLink
      to="/admin/users/$userId"
      params={{ userId: account.accountId }}
      data-testid="spend-account-profile-link"
      style={{ textDecoration: 'none' }}
    >
      <Typography level="body-sm" sx={{ color: 'admin.link' }}>
        Open user
      </Typography>
    </RouterLink>
  );
  const orgPayers = account.payers.filter(payer => payer.ownerType === CreditHolderType.Organization);

  return (
    <Stack gap={2} data-testid="spend-account-panel">
      <Stack direction="row" gap={1.5} alignItems="center" flexWrap="wrap">
        <Typography level="title-lg">{account.name}</Typography>
        {account.segment !== 'customer' && (
          <Chip size="sm" variant="soft">
            {SEGMENT_LABELS[account.segment]}
          </Chip>
        )}
        {profileLink}
        {orgPayers.map(payer => (
          <Link
            key={payer.ownerId}
            href={adminOrganizationHref(payer.ownerId)}
            level="body-sm"
            sx={{ color: 'admin.link' }}
            data-testid={`spend-account-payer-link-${payer.ownerId}`}
          >
            Billed to {payer.name}
          </Link>
        ))}
        <Button size="sm" variant="plain" onClick={onClose} data-testid="spend-account-close-btn">
          Back to all accounts
        </Button>
      </Stack>
      <Box2Columns>
        <ChartSection
          title="Account spend by model"
          testId={ACCOUNT_CHART_ID}
          body={
            timeline.isLoading || !timeline.data
              ? timeline.isError
                ? {
                    kind: 'notice',
                    content: (
                      <Typography level="body-sm">Could not load the spend for this account. Try again.</Typography>
                    ),
                  }
                : { kind: 'loading' }
              : {
                  kind: 'ready',
                  caption: `${formatUsd(modelMix.total)} in this range`,
                  chart: (
                    <SpendChart
                      testId={`${ACCOUNT_CHART_ID}-plot`}
                      data={timeline.data}
                      showPrevious={false}
                      selectedStart={null}
                      onSelectBucket={() => undefined}
                    />
                  ),
                  table: (
                    <SpendBucketTable
                      testId={`${ACCOUNT_CHART_ID}-table`}
                      label="Account spend by bucket"
                      buckets={timeline.data.buckets}
                      bucketSize={timeline.data.bucket}
                    />
                  ),
                }
          }
        />
        <SectionCard title="Model mix" body="custom" data-testid="spend-account-model-mix">
          <Stack gap={1} sx={{ p: 2 }}>
            {modelMix.rows.length === 0 && <Typography level="body-sm">No recorded spend in this range.</Typography>}
            {modelMix.rows.map(([model, cost]) => (
              <Stack key={model} gap={0.5}>
                <Stack direction="row" justifyContent="space-between" gap={2}>
                  <Typography level="body-sm" noWrap>
                    {model === 'other' ? 'Other' : model}
                  </Typography>
                  <Typography level="body-sm" sx={{ fontVariantNumeric: 'tabular-nums' }}>
                    {formatUsd(cost)} ({formatShare(modelMix.total > 0 ? cost / modelMix.total : 0)})
                  </Typography>
                </Stack>
                <InlineBar value={cost} max={modelMix.rows[0][1]} />
              </Stack>
            ))}
          </Stack>
        </SectionCard>
      </Box2Columns>
      <UserFeaturesPanel
        range={range}
        userId={account.accountId}
        userName={account.name}
        // The panel header already links to the user.
        showProfileLink={false}
        testId="account-spend-features"
      />
    </Stack>
  );
}

function Box2Columns({ children }: { children: React.ReactNode }) {
  return (
    <Stack sx={{ display: 'grid', gap: 3, gridTemplateColumns: { xs: '1fr', md: 'minmax(0, 2fr) minmax(0, 1fr)' } }}>
      {children}
    </Stack>
  );
}
