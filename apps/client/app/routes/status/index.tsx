/** Admin QA status (`/status`): tiles, trend charts, flaky tests and run history. Reads: pages/api/admin/qa. */
import { FC } from 'react';
import { Alert, Box, Stack, Typography } from '@mui/joy';
import { useNavigate } from '@tanstack/react-router';
import { useDocumentTitle } from '@client/app/hooks/useDocumentTitle';
import { qaStatusRoute } from '@client/app/router';
import { useQaFacets, useQaOverview, useQaRuns, type QaStatusSearch } from '@client/app/hooks/data/qaStatus';
import StatusFilters from '@client/app/components/QaStatus/StatusFilters';
import StatusTiles from '@client/app/components/QaStatus/StatusTiles';
import StatusCharts from '@client/app/components/QaStatus/StatusCharts';
import FlakyTable from '@client/app/components/QaStatus/FlakyTable';
import RunList from '@client/app/components/QaStatus/RunList';
import StatusHeader from '@client/app/components/QaStatus/StatusHeader';
import RunExpanded from '@client/app/components/QaStatus/RunExpanded';

const QaStatusPage: FC = () => {
  useDocumentTitle('QA Status');
  const search = qaStatusRoute.useSearch();
  const navigate = useNavigate();
  // Unscoped facets pick the default product; scoped ones fill the tenant/env options.
  const allFacets = useQaFacets();
  const product = search.product ?? allFacets.data?.products[0];
  const facets = useQaFacets(product);
  const effective: QaStatusSearch = { ...search, product };
  const overview = useQaOverview(effective);
  const runs = useQaRuns(effective);

  const onChange = (patch: Partial<QaStatusSearch>) =>
    navigate({ to: '/status', search: prev => ({ ...prev, ...patch }) });
  const openRun = (id: string) => navigate({ to: '/status/runs/$id', params: { id } });
  const openTest = (testKey: string) => navigate({ to: '/status/tests/$testKey', params: { testKey } });

  return (
    <Box sx={{ p: 3 }}>
      <Stack spacing={3}>
        <StatusHeader>
          <Typography level="h3">QA status</Typography>
        </StatusHeader>
        <StatusFilters search={effective} facets={facets.data} onChange={onChange} />
        {allFacets.data && allFacets.data.products.length === 0 && <Alert>No QA runs ingested yet.</Alert>}
        {(overview.isError || runs.isError) && <Alert color="danger">Could not load QA status.</Alert>}
        {overview.data && (
          <>
            <StatusTiles tiles={overview.data.tiles} onOpenRun={openRun} />
            <StatusCharts series={overview.data.series} range={effective.range} />
            <FlakyTable rows={overview.data.flaky} onOpenTest={openTest} />
          </>
        )}
        {product && (
          <RunList
            runs={runs.data?.pages.flatMap(p => p.runs) ?? []}
            onOpenRun={openRun}
            renderExpanded={run => <RunExpanded runId={run.id} onOpenTest={openTest} />}
            hasMore={Boolean(runs.hasNextPage)}
            onLoadMore={() => runs.fetchNextPage()}
          />
        )}
      </Stack>
    </Box>
  );
};

export default QaStatusPage;
