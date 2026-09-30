import { FC } from 'react';
import { CircularProgress, Typography } from '@mui/joy';
import { useQaRunDetail } from '@client/app/hooks/data/qaStatus';
import RunDetail from './RunDetail';

/** Lazy-loads a run's detail when its row is expanded on /status. */
const RunExpanded: FC<{ runId: string; onOpenTest: (testKey: string) => void }> = ({ runId, onOpenTest }) => {
  const { data, isLoading, isError } = useQaRunDetail(runId);
  if (isLoading) return <CircularProgress size="sm" />;
  if (isError || !data) return <Typography level="body-sm">Could not load this run.</Typography>;
  return <RunDetail detail={data} onOpenTest={onOpenTest} compact />;
};

export default RunExpanded;
