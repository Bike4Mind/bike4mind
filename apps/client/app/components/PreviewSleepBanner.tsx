import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Alert, Button, Typography } from '@mui/joy';
import { api } from '@client/app/contexts/ApiContext';

interface PreviewSleepStatus {
  asleep: boolean;
  waking: boolean;
  services: { label: string; running: number; desired: number }[];
}

const QUERY_KEY = ['preview-sleep'];
const POLL_MS = 15_000;

/**
 * Preview stages scale their ECS services to zero on a schedule (infra/previewSleep.ts). This
 * talks plain HTTP because the realtime socket is one of the services that sleeps; off-preview
 * the route 404s, the query errors once, and nothing renders or polls.
 */
const PreviewSleepBanner = () => {
  const queryClient = useQueryClient();
  const [requested, setRequested] = useState(false);
  const { data } = useQuery({
    queryKey: QUERY_KEY,
    queryFn: async () => (await api.get<PreviewSleepStatus>('/api/preview-sleep')).data,
    retry: false,
    refetchOnWindowFocus: false,
    refetchInterval: query => (query.state.data?.asleep || query.state.data?.waking ? POLL_MS : false),
  });
  const wake = useMutation({
    mutationFn: () => api.post('/api/preview-sleep'),
    onSuccess: () => {
      setRequested(true);
      return queryClient.invalidateQueries({ queryKey: QUERY_KEY });
    },
  });

  if (!data || (!data.asleep && !data.waking)) return null;

  const progress = data.services.map(s => `${s.label} ${s.running}/${s.desired}`).join(', ');
  return (
    <Alert
      data-testid="preview-sleep-banner"
      color="warning"
      variant="soft"
      size="sm"
      endDecorator={
        data.asleep && !requested ? (
          <Button
            data-testid="preview-sleep-wake-btn"
            size="sm"
            color="warning"
            loading={wake.isPending}
            onClick={() => wake.mutate()}
          >
            Wake
          </Button>
        ) : undefined
      }
    >
      <Typography level="body-sm">
        {data.waking || requested
          ? `This preview is waking up (${progress}). Chat works once every service is running.`
          : 'This preview is asleep to save cost. Wake it to use chat.'}
      </Typography>
    </Alert>
  );
};

export default PreviewSleepBanner;
