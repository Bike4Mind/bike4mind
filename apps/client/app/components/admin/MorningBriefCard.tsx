import { Box, Button, Link, Stack, Typography } from '@mui/joy';
import { useQuery } from '@tanstack/react-query';
import { api } from '@client/app/contexts/ApiContext';
import { latestMorningBriefSchema } from '@client/shared/adminMorningBrief';
import { useUser } from '@client/app/contexts/UserContext';
import { isFullAdmin } from '@bike4mind/common';
import { SectionCard, ErrorState, LoadingState } from './shared';

export function MorningBriefCard() {
  const { currentUser } = useUser();
  const allowed = isFullAdmin(currentUser);
  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: ['admin-morning-brief'],
    queryFn: async () => latestMorningBriefSchema.parse((await api.get('/api/admin/morning-brief')).data),
    staleTime: 60_000,
    enabled: allowed,
  });
  if (!allowed) return null;
  const brief = data?.brief;
  return (
    <SectionCard
      title="Morning brief"
      body="custom"
      data-testid="admin-morning-brief"
      action={
        <Button variant="plain" onClick={() => void refetch()} data-testid="morning-brief-refresh-btn">
          Refresh brief
        </Button>
      }
    >
      <Box sx={{ p: 2 }}>
        {isLoading ? (
          <LoadingState label="Loading morning brief" />
        ) : isError ? (
          <ErrorState
            message="The morning brief could not be loaded. The admin queues remain available."
            onRetry={() => void refetch()}
          />
        ) : !brief ? (
          <Typography level="body-sm">
            No morning brief yet. Review the admin queues manually; scheduled delivery is opt-in.
          </Typography>
        ) : (
          <Stack spacing={2}>
            <Typography level="body-xs">
              {brief.day} (UTC) - {brief.environment} - Slack:{' '}
              {brief.delivery === 'sending' ? 'unconfirmed' : brief.delivery}
            </Typography>
            {brief.summary && <Typography level="body-md">AI summary (advisory only): {brief.summary}</Typography>}
            <Typography
              level="body-sm"
              sx={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}
              data-testid="morning-brief-facts"
            >
              {brief.facts}
            </Typography>
            <Typography level="title-sm">Needs a human today</Typography>
            {brief.needsHuman.slice(0, 5).map(link => (
              <Link key={link.href} href={link.href} data-testid="morning-brief-human-link">
                {link.label}
              </Link>
            ))}
          </Stack>
        )}
      </Box>
    </SectionCard>
  );
}
