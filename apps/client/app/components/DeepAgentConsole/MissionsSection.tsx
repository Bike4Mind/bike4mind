import { FC, useState } from 'react';
import { Alert, Box, Button, Card, Chip, CircularProgress, Stack, Typography } from '@mui/joy';
import RocketLaunchOutlinedIcon from '@mui/icons-material/RocketLaunchOutlined';
import { useNavigate } from '@tanstack/react-router';
import { useAgentMissions, useCreateMission, type AgentRosterItem } from '@client/app/hooks/data/deepAgents';
import NewMissionModal, { type NewMissionValues } from './NewMissionModal';

export const MissionCard: FC<{ mission: AgentRosterItem; onOpen: () => void }> = ({ mission, onOpen }) => (
  <Card
    variant="outlined"
    size="sm"
    onClick={onOpen}
    sx={{ cursor: 'pointer', '&:hover': { borderColor: 'primary.outlinedBorder' } }}
    data-testid="mission-card"
  >
    <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 1 }}>
      <Typography level="title-sm" noWrap sx={{ flex: 1 }}>
        {mission.goal}
      </Typography>
      <Chip size="sm" variant="outlined">
        {mission.currentTier}
      </Chip>
    </Box>
    <Box sx={{ display: 'flex', gap: 1, alignItems: 'center' }}>
      <Typography level="body-xs">{mission.wakeCount ?? 0} wakes</Typography>
      <Typography level="body-xs">·</Typography>
      <Typography level="body-xs">{mission.semanticMemoryCount} memories</Typography>
      <Typography level="body-xs">·</Typography>
      <Typography level="body-xs">v{mission.version}</Typography>
      {mission.blockers.length > 0 && (
        <Chip size="sm" color="warning" variant="soft">
          {mission.blockers.length} blocker{mission.blockers.length === 1 ? '' : 's'}
        </Chip>
      )}
    </Box>
    {mission.nextIntendedAction && (
      <Typography level="body-xs" sx={{ color: 'text.tertiary' }} noWrap>
        Next: {mission.nextIntendedAction}
      </Typography>
    )}
  </Card>
);

interface MissionsSectionProps {
  b4mAgentId: string;
  agentName: string;
}

/**
 * The agent's Missions - standing goals it pursues across wakes, each with its
 * own memory, drives, and adversarial-review trail. Launch one here; click a
 * card for the full dossier (timeline, drives, review, Copy MD).
 */
const MissionsSection: FC<MissionsSectionProps> = ({ b4mAgentId, agentName }) => {
  const navigate = useNavigate();
  const [modalOpen, setModalOpen] = useState(false);
  const missions = useAgentMissions(b4mAgentId);
  const create = useCreateMission();

  const handleCreate = (values: NewMissionValues) => {
    void create
      .mutateAsync({ b4mAgentId, ...values })
      .then(result => {
        setModalOpen(false);
        void navigate({
          to: '/agents/$id/missions/$missionId',
          params: { id: b4mAgentId, missionId: result.missionId },
        });
      })
      .catch(() => {
        // surfaced via create.error in the modal
      });
  };

  const errorMessage = create.isError
    ? ((create.error as { response?: { data?: { error?: string } } })?.response?.data?.error ??
      (create.error as Error).message)
    : null;

  return (
    <Box data-testid="agent-missions-section">
      <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', mb: 1 }}>
        <Button
          size="sm"
          variant="outlined"
          startDecorator={<RocketLaunchOutlinedIcon />}
          onClick={() => setModalOpen(true)}
          data-testid="new-mission-btn"
        >
          New Mission
        </Button>
      </Box>
      <Typography level="body-sm" sx={{ color: 'text.tertiary', mb: 1.5 }}>
        Standing goals {agentName} pursues on its own — with memory, drives, and an adversarial-review trail.
      </Typography>

      {missions.isLoading && <CircularProgress size="sm" />}
      {missions.isError && (
        <Alert color="danger" variant="soft">
          Failed to load missions.
        </Alert>
      )}
      {missions.data?.length === 0 && (
        <Typography level="body-sm" sx={{ color: 'text.tertiary' }}>
          No missions yet — give {agentName} something to pursue while you&apos;re away.
        </Typography>
      )}
      <Stack spacing={1}>
        {missions.data?.map(mission => (
          <MissionCard
            key={mission.agentId}
            mission={mission}
            onOpen={() =>
              void navigate({
                to: '/agents/$id/missions/$missionId',
                params: { id: b4mAgentId, missionId: mission.agentId },
              })
            }
          />
        ))}
      </Stack>

      <NewMissionModal
        open={modalOpen}
        agentName={agentName}
        onClose={() => setModalOpen(false)}
        onCreate={handleCreate}
        pending={create.isPending}
        errorMessage={modalOpen ? errorMessage : null}
      />
    </Box>
  );
};

export default MissionsSection;
