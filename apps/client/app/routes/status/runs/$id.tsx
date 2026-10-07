/** Admin QA run detail (`/status/runs/$id`): suites, metrics, changes since the previous run, tests, report link. */
import { FC } from 'react';
import { Alert, Box, CircularProgress, Link, Stack } from '@mui/joy';
import { Link as RouterLink, useNavigate } from '@tanstack/react-router';
import { useDocumentTitle } from '@client/app/hooks/useDocumentTitle';
import { qaRunRoute } from '@client/app/router';
import { useQaRunDetail } from '@client/app/hooks/data/qaStatus';
import StatusHeader from '@client/app/components/QaStatus/StatusHeader';
import RunDetail from '@client/app/components/QaStatus/RunDetail';

const QaRunPage: FC = () => {
  useDocumentTitle('QA Run');
  const { id } = qaRunRoute.useParams();
  const navigate = useNavigate();
  const { data, isLoading, isError } = useQaRunDetail(id);
  return (
    <Box sx={{ p: 3 }}>
      <Stack spacing={2}>
        <StatusHeader>
          <Link component={RouterLink} to="/status" level="body-sm">
            Back to status
          </Link>
        </StatusHeader>
        {isLoading && <CircularProgress />}
        {isError && <Alert color="danger">Run not found.</Alert>}
        {data && (
          <RunDetail
            detail={data}
            onOpenTest={testKey => navigate({ to: '/status/tests/$testKey', params: { testKey } })}
            onOpenRun={runId => navigate({ to: '/status/runs/$id', params: { id: runId } })}
          />
        )}
      </Stack>
    </Box>
  );
};

export default QaRunPage;
