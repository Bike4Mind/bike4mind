/**
 * Mission dossier (`/agents/$id/missions/$missionId`).
 *
 * One mission of a B4M Agent, rendered with the full deep-agent dossier:
 * goal, drives, semantic memory with provenance, blockers, and the episode
 * timeline with wake-now, adversarial review, and Copy MD. Reuses the
 * DeepAgentConsole components - a mission IS a deep-agent charter linked to
 * the agent.
 */
import { FC, useState } from 'react';
import { Alert, Box, Button, CircularProgress, Typography } from '@mui/joy';
import ArrowBackOutlinedIcon from '@mui/icons-material/ArrowBackOutlined';
import { useNavigate, useParams } from '@tanstack/react-router';
import { useDocumentTitle } from '@client/app/hooks/useDocumentTitle';
import { scrollbarStyles } from '@client/app/utils/scrollbarStyles';
import { useDeepAgentDetail, useSpinAgent, useReviewEpisode } from '@client/app/hooks/data/deepAgents';
import AgentDetailPanel from '@client/app/components/DeepAgentConsole/AgentDetailPanel';

const MissionDossierPage: FC = () => {
  useDocumentTitle('Mission');
  const params = useParams({ strict: false }) as { id?: string; missionId?: string };
  const b4mAgentId = params.id ?? '';
  const missionId = params.missionId ?? null;
  const navigate = useNavigate();
  const [reviewingEpisodeId, setReviewingEpisodeId] = useState<string | null>(null);

  const detail = useDeepAgentDetail(missionId);
  const spin = useSpinAgent();
  const review = useReviewEpisode();

  const handleWake = (enableTools: boolean) => {
    if (!missionId) return;
    void spin.mutateAsync({ agentId: missionId, enableTools }).catch(() => {
      // surfaced via spin.error below
    });
  };

  const handleRequestReview = (episodeId: string) => {
    if (!missionId) return;
    setReviewingEpisodeId(episodeId);
    void review
      .mutateAsync({ agentId: missionId, episodeId })
      .catch(() => {
        // surfaced via review.error below
      })
      .finally(() => setReviewingEpisodeId(null));
  };

  const extractError = (e: unknown): string =>
    (e as { response?: { data?: { error?: string } } })?.response?.data?.error ?? (e as Error).message;
  const wakeError = spin.isError ? extractError(spin.error) : review.isError ? extractError(review.error) : null;

  return (
    <Box sx={{ height: '100%', overflowY: 'auto', p: 2, ...scrollbarStyles }}>
      <Button
        variant="plain"
        size="sm"
        startDecorator={<ArrowBackOutlinedIcon />}
        onClick={() => void navigate({ to: '/agents/$id', params: { id: b4mAgentId } })}
        sx={{ mb: 1 }}
        data-testid="mission-back-btn"
      >
        Back to agent
      </Button>

      {detail.isLoading && <CircularProgress size="sm" sx={{ m: 2 }} />}
      {detail.isError && (
        <Alert color="danger" variant="soft" sx={{ m: 2 }}>
          Failed to load this mission.
        </Alert>
      )}
      {detail.data && !detail.data.charter.identity.linkedAgentId && (
        <Typography level="body-xs" sx={{ color: 'text.tertiary', mb: 1 }}>
          (standalone deep agent — not linked to this agent)
        </Typography>
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
  );
};

export default MissionDossierPage;
