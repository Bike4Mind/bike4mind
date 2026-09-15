import { useAuthCallback } from '@client/app/hooks/data/auth';
import { LinearProgress, Typography } from '@mui/joy';
import { useParams, useSearch } from '@tanstack/react-router';

const CallbackPage = () => {
  const { strategy } = useParams({ strict: false });
  const search = useSearch({ strict: false });
  const { code, state } = search as any;

  const { isLoading, isSuccess, error } = useAuthCallback(strategy, code, state);

  if (isLoading || isSuccess) return <LinearProgress />;

  if (error) {
    return <Typography color="danger">An error occurred. Please try again.</Typography>;
  }

  return null;
};

export default CallbackPage;
