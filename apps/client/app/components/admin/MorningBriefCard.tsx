import { Box, Button, Link, Stack, Typography } from '@mui/joy';
import { useQuery } from '@tanstack/react-query';
import { api } from '@client/app/contexts/ApiContext';
import { latestMorningBriefSchema } from '@bike4mind/server-utils/shared/adminMorningBrief';
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
  const brief = data?.brief;
  // Delivery is opt-in per environment, so most environments never have a brief; an empty card is noise.
  if (!allowed || (data && !brief)) return null;
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
        ) : !brief ? null : (
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
