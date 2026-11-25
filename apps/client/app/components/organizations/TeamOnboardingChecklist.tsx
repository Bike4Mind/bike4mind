import { useState } from 'react';
import { Button, Card, Chip, Stack, Typography } from '@mui/joy';
import { IOrganizationDocument } from '@bike4mind/common';
import { useOrganizationSeats } from '@client/app/hooks/data/organizations';
import { useGetOrgSlackWorkspace } from '@client/app/hooks/data/useOrgSlackWorkspace';
import { useGetOrgGitHubConnection } from '@client/app/hooks/data/useOrgGitHubConnection';
import { useGetOrgWebhookConfig } from '@client/app/hooks/data/useOrgWebhooks';
import { OrganizationTabs } from '@client/app/routes/organizations/orgTabAccess';
import { readTeamPreference, writeTeamPreference } from './teamPreferences';

export default function TeamOnboardingChecklist({
  organization,
  userId,
  onOpen,
}: {
  organization: IOrganizationDocument;
  userId: string;
  onOpen: (tab: OrganizationTabs) => void;
}) {
  const key = `team-onboarding:${userId}:${organization.id}`;
  const [dismissed, setDismissed] = useState(() => readTeamPreference(key));
  const { pendingSeats, availableSeats } = useOrganizationSeats(organization.id);
  const { data: slack } = useGetOrgSlackWorkspace(organization.id);
  const { data: github } = useGetOrgGitHubConnection(organization.id);
  const { data: webhook } = useGetOrgWebhookConfig(organization.id);
  const items = [
    {
      id: 'members',
      label: 'Invite members',
      tab: OrganizationTabs.Members,
      done: pendingSeats > 0 || organization.users.some(member => member.userId !== organization.userId),
    },
    {
      id: 'context',
      label: 'Set the team AI context',
      tab: OrganizationTabs.Settings,
      done: !!organization.systemPrompt?.trim(),
    },
    {
      id: 'integrations',
      label: 'Connect integrations',
      tab: OrganizationTabs.Integrations,
      done: !!slack?.enabled || !!github?.connected || !!webhook?.enabled,
    },
    { id: 'seats', label: 'Add seats', tab: OrganizationTabs.Billing, done: availableSeats > 0 },
  ];
  const dismiss = (id: string) => {
    const next = [...dismissed, id];
    setDismissed(next);
    writeTeamPreference(key, next);
  };
  if (dismissed.includes('all') || items.every(item => item.done || dismissed.includes(item.id))) return null;

  return (
    <Card variant="outlined" data-testid="team-onboarding-checklist">
      <Stack direction="row" justifyContent="space-between" alignItems="center">
        <Typography level="title-md">Get your team ready</Typography>
        <Button size="sm" variant="plain" onClick={() => dismiss('all')} data-testid="team-onboarding-dismiss-btn">
          Dismiss checklist
        </Button>
      </Stack>
      {items
        .filter(item => !dismissed.includes(item.id))
        .map(item => (
          <Stack key={item.id} direction="row" spacing={1} alignItems="center">
            <Typography sx={{ flex: 1 }}>{item.label}</Typography>
            {item.done ? (
              <Chip color="success" size="sm" data-testid={`team-onboarding-${item.id}-done`}>
                Done
              </Chip>
            ) : (
              <>
                <Button
                  size="sm"
                  variant="outlined"
                  onClick={() => onOpen(item.tab)}
                  data-testid={`team-onboarding-${item.id}-open-btn`}
                >
                  Open
                </Button>
                <Button
                  size="sm"
                  variant="plain"
                  onClick={() => dismiss(item.id)}
                  data-testid={`team-onboarding-${item.id}-dismiss-btn`}
                >
                  Dismiss
                </Button>
              </>
            )}
          </Stack>
        ))}
    </Card>
  );
}
