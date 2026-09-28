/** Admin QA test history (`/status/tests/$testKey`): last 50 results and the flake rate. */
import { FC } from 'react';
import { Alert, Box, CircularProgress, Link, Stack } from '@mui/joy';
import { Link as RouterLink, useNavigate } from '@tanstack/react-router';
import { useDocumentTitle } from '@client/app/hooks/useDocumentTitle';
import { qaTestRoute } from '@client/app/router';
import { useQaTestHistory } from '@client/app/hooks/data/qaStatus';
import TestHistory from '@client/app/components/QaStatus/TestHistory';

const QaTestPage: FC = () => {
  useDocumentTitle('QA Test');
  // The router decodes the segment; the hook re-sends the key as ?testKey=, never as a path.
  const { testKey } = qaTestRoute.useParams();
  const navigate = useNavigate();
  const { data, isLoading, isError } = useQaTestHistory(testKey);
  return (
    <Box sx={{ p: 3, overflow: 'auto', height: '100%' }}>
      <Stack spacing={2}>
        <Link component={RouterLink} to="/status" level="body-sm">
          Back to status
        </Link>
        {isLoading && <CircularProgress />}
        {isError && <Alert color="danger">No results for this test.</Alert>}
        {data && <TestHistory history={data} onOpenRun={id => navigate({ to: '/status/runs/$id', params: { id } })} />}
      </Stack>
    </Box>
  );
};

export default QaTestPage;
