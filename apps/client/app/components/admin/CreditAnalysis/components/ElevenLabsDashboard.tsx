import { useMemo, useState } from 'react';
import { Alert, Button, Stack } from '@mui/joy';
import RefreshIcon from '@mui/icons-material/Refresh';
import SettingsIcon from '@mui/icons-material/Settings';
import { useNavigate } from '@tanstack/react-router';
import {
  ELEVENLABS_MAX_CYCLES_BACK,
  SETTING_TABS,
  type ElevenLabsDayUsage,
  type ElevenLabsModelUsage,
  type ElevenLabsPlanUsage,
  type ElevenLabsProduct,
  type ElevenLabsUsageTotals,
} from '@bike4mind/common';
import {
  AdminPageHeader,
  ChartDataTable,
  ChartSection,
  DataTable,
  EmptyState,
  ErrorState,
  FilterBar,
  InlineBar,
  LoadingState,
  SectionCard,
  StatStrip,
  StatTile,
  type DataColumn,
} from '../../shared';
import {
  ADMIN_SETTINGS_SEARCH_PARAM,
  ADMIN_SETTINGS_SECTION_PARAM,
  ADMIN_SETTINGS_TAB_SLUG,
  adminSearchForTab,
  type AdminSearch,
} from '../../adminTabParams';
import { useElevenLabsUsage } from '../hooks/useElevenLabsUsage';
import { formatCredits } from '../utils/format';
import { DailyAreaChart } from './DailyAreaChart';

export const PRODUCT_LABELS: Record<ElevenLabsProduct, string> = {
  text_to_speech: 'Text to speech',
  sound_effects: 'Sound effects',
  music_generation: 'Music',
  agents: 'Agents',
};

const UNIT_LABELS: Record<ElevenLabsProduct, string> = {
  text_to_speech: 'characters',
  sound_effects: 'seconds',
  music_generation: 'seconds',
  agents: 'seconds',
};

// Admin Settings search that narrows the list to the plan settings; a substring of every plan setting key.
const PLAN_SETTINGS_SEARCH = 'elevenLabsPlan';

const formatMinutes = (minutes: number) => Math.round(minutes).toLocaleString();

const countOf = (count: number, noun: string) => `${count.toLocaleString()} ${noun}${count === 1 ? '' : 's'}`;

const formatShare = (used: number, allowance: number | null) =>
  allowance === null ? 'No allowance set' : `${Math.round((used / allowance) * 100)}% of ${allowance.toLocaleString()}`;

const formatDay = (iso: string) => iso.slice(0, 10);

/** The cycle's end is exclusive, so the last day shown is the day before it. */
const describeCycle = (cycle: ElevenLabsPlanUsage['cycle']) =>
  `${formatDay(cycle.from)} to ${formatDay(new Date(new Date(cycle.to).getTime() - 1).toISOString())} (UTC)`;

/** Every day of the cycle up to today, so idle days chart as zero instead of being skipped. */
export const fillCycleDays = (
  cycle: ElevenLabsPlanUsage['cycle'],
  days: readonly ElevenLabsDayUsage[],
  now: Date = new Date()
): { day: string; value: number }[] => {
  const creditsByDay = new Map(days.map(day => [day.day, day.credits]));
  const end = Math.min(new Date(cycle.to).getTime(), now.getTime());
  const filled: { day: string; value: number }[] = [];
  for (let t = new Date(cycle.from).getTime(); t < end; t += 24 * 60 * 60 * 1000) {
    const day = new Date(t).toISOString().slice(0, 10);
    filled.push({ day, value: creditsByDay.get(day) ?? 0 });
  }
  return filled;
};

/** The totals columns are 41rem; a name column beside them needs about 11rem more. */
const TOTALS_TABLE_MIN_WIDTH = '52rem';

function totalsColumns<Row extends ElevenLabsUsageTotals>(maxCredits: number): DataColumn<Row>[] {
  return [
    {
      id: 'credits',
      label: 'Vendor credits',
      numeric: true,
      width: '9rem',
      sortValue: row => row.credits,
      render: row => formatCredits(row.credits),
    },
    { id: 'share', label: 'Share', width: '8rem', render: row => <InlineBar value={row.credits} max={maxCredits} /> },
    {
      id: 'agentMinutes',
      label: 'Agent minutes',
      wrapHeader: true,
      numeric: true,
      width: '8rem',
      sortValue: row => row.agentMinutes,
      render: row => formatMinutes(row.agentMinutes),
    },
    {
      id: 'requests',
      label: 'Requests',
      numeric: true,
      width: '7rem',
      sortValue: row => row.requests,
      render: row => row.requests.toLocaleString(),
    },
    {
      id: 'possiblyBilled',
      label: 'Failed, may be billed (credits)',
      wrapHeader: true,
      numeric: true,
      width: '9rem',
      sortValue: row => row.possiblyBilledCredits,
      render: row => formatCredits(row.possiblyBilledCredits),
    },
  ];
}

// The current cycle is the unset filter, so the chip's Clear returns to it.
const CYCLE_OPTIONS = Array.from({ length: ELEVENLABS_MAX_CYCLES_BACK }, (_, index) => ({
  value: String(index + 1),
  label: index === 0 ? 'Previous cycle' : `${index + 1} cycles ago`,
}));

export function ElevenLabsDashboard() {
  const [cyclesBack, setCyclesBack] = useState(0);
  const { data, isLoading, isFetching, error, refetch } = useElevenLabsUsage(cyclesBack);
  const navigate = useNavigate();

  const openPlanSettings = () =>
    navigate({
      to: '/admin',
      // The tab slug, not the store: the store-to-URL mirror would drop the section and search.
      search: (previous: AdminSearch) => ({
        ...adminSearchForTab(previous, ADMIN_SETTINGS_TAB_SLUG),
        [ADMIN_SETTINGS_SECTION_PARAM]: SETTING_TABS.AI_CONFIGURATION.id,
        [ADMIN_SETTINGS_SEARCH_PARAM]: PLAN_SETTINGS_SEARCH,
      }),
      replace: true,
    });

  const chartData = useMemo(() => (data ? fillCycleDays(data.cycle, data.byDay) : []), [data]);

  return (
    <Stack gap={2} data-testid="elevenlabs-dashboard">
      <AdminPageHeader
        level="section"
        title="ElevenLabs"
        description="Estimated ElevenLabs plan credits and agent minutes used in a billing cycle on the platform key, by product, model, user and day."
        actions={
          <Stack direction="row" gap={1}>
            <Button
              variant="plain"
              startDecorator={<SettingsIcon />}
              onClick={() => void openPlanSettings()}
              data-testid="elevenlabs-plan-settings-btn"
            >
              Edit plan settings
            </Button>
            <Button
              variant="plain"
              startDecorator={<RefreshIcon />}
              onClick={() => void refetch()}
              disabled={isFetching}
              data-testid="elevenlabs-refresh-btn"
            >
              Refresh
            </Button>
          </Stack>
        }
      />
      <FilterBar
        search={false}
        state={{ query: '', view: '', filters: { cycle: cyclesBack === 0 ? '' : String(cyclesBack) } }}
        filters={[{ id: 'cycle', label: 'Billing cycle', options: CYCLE_OPTIONS }]}
        onChange={patch => {
          if (patch.filters) setCyclesBack(Number(patch.filters.cycle || 0));
        }}
      />

      {error ? (
        <ErrorState
          message={error instanceof Error ? error.message : 'Failed to load ElevenLabs usage'}
          onRetry={() => void refetch()}
          retrying={isFetching}
        />
      ) : isLoading || !data ? (
        <LoadingState label="Loading ElevenLabs usage" testId="elevenlabs-loading" />
      ) : (
        <ElevenLabsUsageBody data={data} chartData={chartData} onRetry={() => void refetch()} />
      )}
    </Stack>
  );
}

function ElevenLabsUsageBody({
  data,
  chartData,
  onRetry,
}: {
  data: ElevenLabsPlanUsage;
  chartData: { day: string; value: number }[];
  onRetry: () => void;
}) {
  const { platform, userKeys, plan } = data;
  const maxProductCredits = Math.max(0, ...data.byProduct.map(row => row.credits));
  const maxModelCredits = Math.max(0, ...data.byModel.map(row => row.credits));
  const maxUserCredits = Math.max(0, ...data.byUser.map(row => row.credits));
  const maxDayCredits = Math.max(0, ...data.byDay.map(row => row.credits));

  const modelColumns: DataColumn<ElevenLabsModelUsage>[] = [
    { id: 'product', label: 'Product', width: '9rem', render: row => PRODUCT_LABELS[row.product] },
    { id: 'model', label: 'Model', width: '14rem', render: row => row.model },
    {
      id: 'units',
      label: 'Units (incl. failed)',
      wrapHeader: true,
      numeric: true,
      width: '11rem',
      sortValue: row => row.units,
      render: row => `${Math.round(row.units).toLocaleString()} ${UNIT_LABELS[row.product]}`,
    },
    ...totalsColumns<ElevenLabsModelUsage>(maxModelCredits),
  ];

  return (
    <Stack spacing={3}>
      <Alert color="neutral" size="sm" role="note" data-testid="elevenlabs-cycle-note">
        Cycle {describeCycle(data.cycle)}. Vendor credits are estimated from recorded usage at published ElevenLabs
        rates (music is an estimate). Calls on users&apos; own ElevenLabs keys are left out
        {data.unknownKeySourceRequests > 0
          ? `; ${countOf(data.unknownKeySourceRequests, 'request')} with no recorded key source are counted as platform usage`
          : ''}
        .
      </Alert>

      <StatStrip aria-label="ElevenLabs plan key numbers">
        <StatTile
          label="Plan credits used"
          value={formatCredits(platform.credits)}
          comparison={formatShare(platform.credits, plan.monthlyCredits)}
        />
        <StatTile
          label="Agent minutes used"
          value={formatMinutes(platform.agentMinutes)}
          comparison={formatShare(platform.agentMinutes, plan.agentMinutes)}
        />
        <StatTile
          label="Failed, may be billed (credits)"
          value={formatCredits(platform.possiblyBilledCredits)}
          comparison={countOf(platform.failedRequests, 'failed request')}
        />
        <StatTile
          label="On users' own keys (credits)"
          value={formatCredits(userKeys.credits)}
          comparison={`${countOf(userKeys.requests, 'request')}, not counted`}
        />
      </StatStrip>

      <ChartSection
        title="Plan credits per day"
        testId="elevenlabs-daily"
        body={
          platform.requests === 0
            ? { kind: 'notice', content: <EmptyState title="No ElevenLabs usage in this cycle" action={null} /> }
            : {
                kind: 'ready',
                caption: `${formatCredits(platform.credits)} vendor credits across ${data.byDay.length} active days`,
                chart: (
                  <DailyAreaChart
                    data={chartData}
                    valueLabel="Vendor credits"
                    formatValue={formatCredits}
                    color="primary"
                    testid="elevenlabs-daily-chart"
                  />
                ),
                table: (
                  <ChartDataTable
                    label="Plan usage per day"
                    testId="elevenlabs-daily-table"
                    rows={data.byDay}
                    getRowId={row => row.day}
                    columns={[
                      { id: 'day', label: 'Day', render: row => row.day },
                      ...totalsColumns<ElevenLabsDayUsage>(maxDayCredits),
                    ]}
                  />
                ),
              }
        }
      />

      <SectionCard title="By product" body="custom" data-testid="elevenlabs-products">
        <DataTable
          label="By product"
          testId="elevenlabs-products-table"
          framed={false}
          minWidth={TOTALS_TABLE_MIN_WIDTH}
          rows={data.byProduct}
          getRowId={row => row.product}
          pagination={false}
          onRetry={onRetry}
          empty={<EmptyState title="No ElevenLabs usage in this cycle" action={null} />}
          columns={[
            { id: 'product', label: 'Product', render: row => PRODUCT_LABELS[row.product] },
            ...totalsColumns(maxProductCredits),
          ]}
        />
      </SectionCard>

      <SectionCard title="By model" body="custom" data-testid="elevenlabs-models">
        <DataTable
          label="By model"
          testId="elevenlabs-models-table"
          framed={false}
          minWidth="75rem"
          rows={data.byModel}
          getRowId={row => `${row.product}:${row.model}`}
          pagination={false}
          onRetry={onRetry}
          empty={<EmptyState title="No ElevenLabs usage in this cycle" action={null} />}
          columns={modelColumns}
        />
      </SectionCard>

      <SectionCard title="By user" body="custom" data-testid="elevenlabs-users">
        <DataTable
          label="By user"
          testId="elevenlabs-users-table"
          framed={false}
          minWidth={TOTALS_TABLE_MIN_WIDTH}
          rows={data.byUser}
          getRowId={row => row.userId}
          maxHeight="480px"
          onRetry={onRetry}
          empty={<EmptyState title="No ElevenLabs usage in this cycle" action={null} />}
          columns={[
            { id: 'user', label: 'User', render: row => <span title={row.userId}>{row.userLabel ?? row.userId}</span> },
            ...totalsColumns(maxUserCredits),
          ]}
        />
      </SectionCard>
    </Stack>
  );
}
