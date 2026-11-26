import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Alert, Box, Button, Typography } from '@mui/joy';
import { api } from '@client/app/contexts/ApiContext';
import { useIsTablet } from '@client/app/hooks/useIsMobile';

interface PreviewSleepStatus {
  asleep: boolean;
  waking: boolean;
  services: { label: string; running: number; desired: number }[];
}

const QUERY_KEY = ['preview-sleep'];
const POLL_MS = 15_000;
// Catches the scheduled sleep in a tab left open on a preview.
const AWAKE_POLL_MS = 5 * 60_000;

// Inlined at build; set only on preview stages by infra/previewSleep.ts, so other stages never call the route.
export const PREVIEW_SLEEP_ENABLED = process.env.NEXT_PUBLIC_PREVIEW_SLEEP_ENABLED === 'true';

/**
 * Preview stages scale their ECS services to zero on a schedule (infra/previewSleep.ts). This
 * talks plain HTTP because the realtime socket is one of the services that sleeps. The sidenav
 * footer hosts it on desktop; on tablet the sidenav is off-screen, so the layout floats it instead.
 */
const PreviewSleepBanner = ({ placement }: { placement: 'sidenav' | 'floating' }) => {
  const queryClient = useQueryClient();
  const isTablet = useIsTablet();
  const { data } = useQuery({
    queryKey: QUERY_KEY,
    queryFn: async () => (await api.get<PreviewSleepStatus>('/api/preview-sleep')).data,
    enabled: PREVIEW_SLEEP_ENABLED,
    retry: false,
    refetchInterval: query => (query.state.data?.asleep || query.state.data?.waking ? POLL_MS : AWAKE_POLL_MS),
  });
  const wake = useMutation({
    mutationFn: () => api.post('/api/preview-sleep'),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: QUERY_KEY }),
  });

  if (isTablet !== (placement === 'floating')) return null;
  if (!data || (!data.asleep && !data.waking)) return null;

  const progress = data.services.map(s => `${s.label} ${s.running}/${s.desired}`).join(', ');
  const alert = (
    <Alert
      data-testid="preview-sleep-banner"
      color="warning"
      variant="soft"
      size="sm"
      endDecorator={
        data.asleep ? (
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
      <Box>
        <Typography level="body-sm">
          {data.waking
            ? `This preview is waking up (${progress}). Chat works once every service is up and serving.`
            : 'This preview is asleep to save cost. Wake it to use chat.'}
        </Typography>
        {wake.isError && (
          <Typography level="body-xs" color="danger" data-testid="preview-sleep-wake-error">
            Could not wake the preview. Try again in a moment.
          </Typography>
        )}
      </Box>
    </Alert>
  );

  if (placement === 'sidenav') return alert;
  return (
    <Box
      sx={{
        position: 'fixed',
        top: 'calc(var(--notebook-header-height, 0px) + 8px)',
        left: '50%',
        transform: 'translateX(-50%)',
        width: 'min(92vw, 420px)',
        zIndex: 1200,
      }}
    >
      {alert}
    </Box>
  );
};

export default PreviewSleepBanner;
