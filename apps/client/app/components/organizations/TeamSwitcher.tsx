import { useState } from 'react';
import { Box, Button, Stack, Typography } from '@mui/joy';
import { useNavigate } from '@tanstack/react-router';
import { useAccounts } from '@client/app/components/Credits/AccountSelector';
import { useUser } from '@client/app/contexts/UserContext';
import { useGetUserOrganizations } from '@client/app/hooks/data/organizations';
import { readTeamPreference, recentTeamsKey, rememberTeam } from './teamPreferences';

export default function TeamSwitcher() {
  const { currentUser } = useUser();
  const { accounts, selectedAccount, setSelectedAccount } = useAccounts();
  const { isLoading, isError, refetch } = useGetUserOrganizations(currentUser?.id);
  const navigate = useNavigate();
  const [revision, setRevision] = useState(0);
  const recent = currentUser ? readTeamPreference(recentTeamsKey(currentUser.id)) : [];
  const teams = accounts
    .filter(account => !account.personal)
    .sort((a, b) => {
      const rank = (id: string) => (recent.includes(id) ? recent.indexOf(id) : recent.length);
      return rank(a.id) - rank(b.id) || a.name.localeCompare(b.name);
    });

  return (
    <Stack spacing={0.5} data-testid="team-switcher" data-revision={revision}>
      <Typography level="body-xs" data-testid="team-switcher-context">
        {selectedAccount && !selectedAccount.personal ? `Team: ${selectedAccount.name}` : 'Personal workspace'}
      </Typography>
      {isLoading ? <Typography level="body-xs">Loading teams...</Typography> : null}
      {isError ? (
        <Button size="sm" variant="plain" onClick={() => refetch()} data-testid="team-switcher-retry-btn">
          Retry loading teams
        </Button>
      ) : (
        <Box sx={{ maxHeight: 132, overflowY: 'auto' }}>
          {teams.slice(0, 3).map(team => (
            <Button
              key={team.id}
              fullWidth
              size="sm"
              variant={selectedAccount?.id === team.id ? 'soft' : 'plain'}
              aria-current={selectedAccount?.id === team.id ? 'true' : undefined}
              data-testid={`team-switcher-${team.id}-btn`}
              sx={{ justifyContent: 'flex-start' }}
              onClick={() => {
                setSelectedAccount(team);
                if (currentUser) rememberTeam(currentUser.id, team.id);
                setRevision(value => value + 1);
                navigate({ to: '/organizations/$id', params: { id: team.id } });
              }}
            >
              {team.name}
            </Button>
          ))}
        </Box>
      )}
      <Button
        size="sm"
        variant="plain"
        onClick={() => navigate({ to: '/organizations' })}
        data-testid="team-switcher-all-btn"
      >
        All teams
      </Button>
    </Stack>
  );
}
