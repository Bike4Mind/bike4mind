/** Admin QA run detail (`/status/runs/$id`): suites, metrics, failed tests with media, report link. */
import { FC } from 'react';
import { Alert, Box, CircularProgress, Link, Stack } from '@mui/joy';
import { Link as RouterLink, useNavigate } from '@tanstack/react-router';
import { useDocumentTitle } from '@client/app/hooks/useDocumentTitle';
import { qaRunRoute } from '@client/app/router';
import { useQaRunDetail } from '@client/app/hooks/data/qaStatus';
import RunDetail from '@client/app/components/QaStatus/RunDetail';

const QaRunPage: FC = () => {
  useDocumentTitle('QA Run');
  const { id } = qaRunRoute.useParams();
  const navigate = useNavigate();
  const { data, isLoading, isError } = useQaRunDetail(id);
  return (
    <Box sx={{ p: 3, overflow: 'auto', height: '100%' }}>
      <Stack spacing={2}>
        <Link component={RouterLink} to="/status" level="body-sm">
          Back to status
        </Link>
        {isLoading && <CircularProgress />}
        {isError && <Alert color="danger">Run not found.</Alert>}
        {data && (
          <RunDetail
            detail={data}
            onOpenTest={testKey => navigate({ to: '/status/tests/$testKey', params: { testKey } })}
          />
        )}
      </Stack>
    </Box>
  );
};

export default QaRunPage;
