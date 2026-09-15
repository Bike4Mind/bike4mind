import { FC, useState } from 'react';
import { Alert, Box, Button, Chip, Divider, Stack, Switch, Typography } from '@mui/joy';
import BoltOutlinedIcon from '@mui/icons-material/BoltOutlined';
import MenuBookOutlinedIcon from '@mui/icons-material/MenuBookOutlined';
import { useNavigate } from '@tanstack/react-router';
import ContentCopyOutlinedIcon from '@mui/icons-material/ContentCopyOutlined';
import CheckOutlinedIcon from '@mui/icons-material/CheckOutlined';
import type { AgentDetail } from '@client/app/hooks/data/deepAgents';
import DriveBars from './DriveBars';
import EpisodeCard from './EpisodeCard';
import { formatAgentDossierMarkdown } from './markdown';

interface AgentDetailPanelProps {
  detail: AgentDetail;
  onWake: (enableTools: boolean) => void;
  wakePending: boolean;
  wakeError: string | null;
  /** Request an adversarial review of an episode. */
  onRequestReview?: (episodeId: string) => void;
  /** Episode id currently under review (its card shows the spinner). */
  reviewingEpisodeId?: string | null;
}

/**
 * The agent's soul, rendered: identity + goal, motivational state, groomed
 * memory with provenance, and the episode timeline (its biography).
 */
const AgentDetailPanel: FC<AgentDetailPanelProps> = ({
  detail,
  onWake,
  wakePending,
  wakeError,
  onRequestReview,
  reviewingEpisodeId,
}) => {
  const navigate = useNavigate();
  const [wakeWithTools, setWakeWithTools] = useState(true);
  const [copied, setCopied] = useState(false);
  const { charter, handoff, episodes } = detail;

  const handleCopyMarkdown = () => {
    void navigator.clipboard.writeText(formatAgentDossierMarkdown(detail)).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  };

  return (
    <Stack spacing={2} data-testid="deep-agent-detail-panel">
      <Box sx={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 2 }}>
        <Box>
          <Typography level="h3">{charter.identity.name}</Typography>
          <Box sx={{ display: 'flex', gap: 0.5, mt: 0.5, flexWrap: 'wrap' }}>
            <Chip size="sm" variant="soft">
              {charter.identity.role}
            </Chip>
            <Chip size="sm" variant="outlined">
              {charter.currentTier}
            </Chip>
            <Chip size="sm" variant="outlined" color="neutral">
              v{charter.version}
            </Chip>
            {handoff && (
              <Chip size="sm" variant="outlined" color="neutral">
                {handoff.wakeCount} wake{handoff.wakeCount === 1 ? '' : 's'}
              </Chip>
            )}
          </Box>
        </Box>
        <Stack spacing={0.5} alignItems="flex-end">
          <Box sx={{ display: 'flex', gap: 1 }}>
            {charter.sessionId && (
              <Button
                variant="outlined"
                color="neutral"
                startDecorator={<MenuBookOutlinedIcon />}
                onClick={() => void navigate({ to: '/notebooks/$id', params: { id: charter.sessionId! } })}
                data-testid="deep-agent-open-log-btn"
              >
                Mission log
              </Button>
            )}
            <Button
              variant="outlined"
              color={copied ? 'success' : 'neutral'}
              startDecorator={copied ? <CheckOutlinedIcon /> : <ContentCopyOutlinedIcon />}
              onClick={handleCopyMarkdown}
              data-testid="deep-agent-copy-md-btn"
            >
              {copied ? 'Copied!' : 'Copy MD'}
            </Button>
            <Button
              startDecorator={<BoltOutlinedIcon />}
              onClick={() => onWake(wakeWithTools)}
              loading={wakePending}
              data-testid="deep-agent-wake-now-btn"
            >
              Wake now
            </Button>
          </Box>
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
            <Typography level="body-xs" sx={{ color: 'text.tertiary' }}>
              tools
            </Typography>
            <Switch
              size="sm"
              checked={wakeWithTools}
              onChange={e => setWakeWithTools(e.target.checked)}
              data-testid="deep-agent-wake-tools-switch"
            />
          </Box>
        </Stack>
      </Box>

      {wakePending && (
        <Alert color="primary" variant="soft" data-testid="deep-agent-waking-alert">
          The agent is awake — orienting, acting, reflecting. This takes 10–60s; the timeline updates when it finishes.
        </Alert>
      )}
      {wakeError && (
        <Alert color="danger" variant="soft">
          Wake failed: {wakeError}
        </Alert>
      )}

      <Typography level="body-sm">{charter.goal.description}</Typography>

      {handoff?.nextIntendedAction && (
        <Alert variant="soft" color="neutral">
          <Box>
            <Typography level="body-xs" sx={{ fontWeight: 'lg', color: 'text.tertiary' }}>
              NEXT INTENDED ACTION
            </Typography>
            <Typography level="body-sm">{handoff.nextIntendedAction}</Typography>
          </Box>
        </Alert>
      )}

      <Box>
        <Typography level="title-sm" sx={{ mb: 1 }}>
          Drives
        </Typography>
        <DriveBars drives={charter.drives} />
      </Box>

      <Box>
        <Typography level="title-sm" sx={{ mb: 1 }}>
          Semantic memory ({charter.semanticMemory.length})
        </Typography>
        {charter.semanticMemory.length === 0 ? (
          <Typography level="body-xs" sx={{ color: 'text.tertiary' }}>
            Nothing groomed into long-term memory yet.
          </Typography>
        ) : (
          <Stack spacing={1}>
            {charter.semanticMemory.map(m => (
              <Box key={m.id} data-testid="deep-agent-memory-entry">
                <Typography level="body-sm">{m.fact}</Typography>
                <Typography level="body-xs" sx={{ color: 'text.tertiary' }}>
                  {m.evidenceTier} · conf {m.confidence.toFixed(2)} · from{' '}
                  {m.sourceEpisodeIds.length > 0 ? `episode ${m.sourceEpisodeIds[0].slice(0, 8)}…` : 'unknown'}
                </Typography>
              </Box>
            ))}
          </Stack>
        )}
      </Box>

      {charter.blockers.length > 0 && (
        <Alert color="warning" variant="soft">
          <Box>
            <Typography level="body-xs" sx={{ fontWeight: 'lg' }}>
              BLOCKERS
            </Typography>
            {charter.blockers.map((b, i) => (
              <Typography key={i} level="body-sm">
                {b}
              </Typography>
            ))}
          </Box>
        </Alert>
      )}

      <Divider />

      <Typography level="title-sm">Episodes ({episodes.length})</Typography>
      <Stack spacing={1}>
        {episodes.map(episode => (
          <EpisodeCard
            key={episode.id}
            episode={episode}
            onRequestReview={onRequestReview}
            reviewPending={reviewingEpisodeId === episode.id}
          />
        ))}
      </Stack>
    </Stack>
  );
};

export default AgentDetailPanel;
