/**
 * Deep Agent Console (`/deep-agents`).
 *
 * The browser surface for long-horizon autonomous agents: enroll an agent
 * with a goal, watch its episode timeline (policy -> tools -> reflection ->
 * scope locks), inspect its drives and groomed memory, and trigger wakes
 * on demand. Architecture: docs/concepts/deep-agent-framework.md.
 */
import { FC, useState } from 'react';
import { Alert, Box, Button, Card, Chip, CircularProgress, Stack, Typography } from '@mui/joy';
import AddOutlinedIcon from '@mui/icons-material/AddOutlined';
import PsychologyOutlinedIcon from '@mui/icons-material/PsychologyOutlined';
import { useDocumentTitle } from '@client/app/hooks/useDocumentTitle';
import { scrollbarStyles } from '@client/app/utils/scrollbarStyles';
import {
  useDeepAgentsList,
  useDeepAgentDetail,
  useSpinAgent,
  useReviewEpisode,
  type AgentRosterItem,
} from '@client/app/hooks/data/deepAgents';
import AgentDetailPanel from '@client/app/components/DeepAgentConsole/AgentDetailPanel';
import EnrollModal, { type EnrollFormValues } from '@client/app/components/DeepAgentConsole/EnrollModal';

const RosterCard: FC<{ agent: AgentRosterItem; selected: boolean; onSelect: () => void }> = ({
  agent,
  selected,
  onSelect,
}) => (
  <Card
    variant={selected ? 'solid' : 'outlined'}
    color={selected ? 'primary' : 'neutral'}
    invertedColors={selected}
    size="sm"
    onClick={onSelect}
    sx={{ cursor: 'pointer' }}
    data-testid="deep-agent-roster-card"
  >
    <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 1 }}>
      <Typography level="title-sm" noWrap>
        {agent.name}
      </Typography>
      <Chip size="sm" variant="soft">
        {agent.role}
      </Chip>
    </Box>
    <Typography level="body-xs" sx={{ color: 'text.tertiary' }} noWrap>
      {agent.goal}
    </Typography>
    <Box sx={{ display: 'flex', gap: 1 }}>
      <Typography level="body-xs">{agent.wakeCount ?? 0} wakes</Typography>
      <Typography level="body-xs">·</Typography>
      <Typography level="body-xs">{agent.semanticMemoryCount} memories</Typography>
      <Typography level="body-xs">·</Typography>
      <Typography level="body-xs">v{agent.version}</Typography>
    </Box>
  </Card>
);

const DeepAgentConsolePage: FC = () => {
  useDocumentTitle('Deep Agents');
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null);
  const [enrollOpen, setEnrollOpen] = useState(false);

  const roster = useDeepAgentsList();
  const detail = useDeepAgentDetail(selectedAgentId);
  const spin = useSpinAgent();
  const review = useReviewEpisode();
  const [reviewingEpisodeId, setReviewingEpisodeId] = useState<string | null>(null);

  const handleEnroll = (values: EnrollFormValues) => {
    void spin
      .mutateAsync({
        name: values.name,
        role: values.role,
        goal: values.goal,
        enableTools: values.enableTools,
      })
      .then(result => {
        setEnrollOpen(false);
        setSelectedAgentId(result.agentId);
      })
      .catch(() => {
        // Keep the modal open; the error is surfaced via spin.error (passed
        // to EnrollModal below). No unhandled rejection.
      });
  };

  const handleWake = (enableTools: boolean) => {
    if (!selectedAgentId) return;
    void spin.mutateAsync({ agentId: selectedAgentId, enableTools }).catch(() => {
      // surfaced via spin.error below
    });
  };

  const handleRequestReview = (episodeId: string) => {
    if (!selectedAgentId) return;
    setReviewingEpisodeId(episodeId);
    void review
      .mutateAsync({ agentId: selectedAgentId, episodeId })
      .catch(() => {
        // surfaced via review.error -> wakeError banner below
      })
      .finally(() => setReviewingEpisodeId(null));
  };

  const extractError = (e: unknown): string =>
    (e as { response?: { data?: { error?: string } } })?.response?.data?.error ?? (e as Error).message;
  const wakeError = spin.isError ? extractError(spin.error) : review.isError ? extractError(review.error) : null;

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', height: '100%', p: 2, gap: 2 }}>
      <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
          <PsychologyOutlinedIcon />
          <Typography level="h2">Deep Agents</Typography>
        </Box>
        <Button
          startDecorator={<AddOutlinedIcon />}
          onClick={() => setEnrollOpen(true)}
          data-testid="deep-agent-enroll-btn"
        >
          Enroll Agent
        </Button>
      </Box>

      <Box sx={{ display: 'flex', gap: 2, flex: 1, minHeight: 0 }}>
        {/* Roster */}
        <Box sx={{ width: 320, flexShrink: 0, overflowY: 'auto', ...scrollbarStyles }}>
          {roster.isLoading && <CircularProgress size="sm" />}
          {roster.isError && (
            <Alert color="danger" variant="soft">
              Failed to load agents.
            </Alert>
          )}
          {roster.data?.length === 0 && (
            <Typography level="body-sm" sx={{ color: 'text.tertiary', p: 2 }}>
              No agents yet — enroll your first one. It will wake, orient on its goal, act with its tools, and reflect
              into memory.
            </Typography>
          )}
          <Stack spacing={1}>
            {roster.data?.map(agent => (
              <RosterCard
                key={agent.agentId}
                agent={agent}
                selected={agent.agentId === selectedAgentId}
                onSelect={() => setSelectedAgentId(agent.agentId)}
              />
            ))}
          </Stack>
        </Box>

        {/* Detail */}
        <Box sx={{ flex: 1, overflowY: 'auto', ...scrollbarStyles }}>
          {!selectedAgentId && (
            <Typography level="body-sm" sx={{ color: 'text.tertiary', p: 2 }}>
              Select an agent to see its charter, drives, memory, and episode timeline.
            </Typography>
          )}
          {selectedAgentId && detail.isLoading && <CircularProgress size="sm" sx={{ m: 2 }} />}
          {selectedAgentId && detail.isError && (
            <Alert color="danger" variant="soft" sx={{ m: 2 }}>
              Failed to load agent detail.
            </Alert>
          )}
          {detail.data && (
            <AgentDetailPanel
              detail={detail.data}
              onWake={handleWake}
              wakePending={spin.isPending}
              wakeError={wakeError}
              onRequestReview={handleRequestReview}
              reviewingEpisodeId={reviewingEpisodeId}
            />
          )}
        </Box>
      </Box>

      <EnrollModal
        open={enrollOpen}
        onClose={() => setEnrollOpen(false)}
        onEnroll={handleEnroll}
        pending={spin.isPending}
        errorMessage={enrollOpen ? wakeError : null}
      />
    </Box>
  );
};

export default DeepAgentConsolePage;
