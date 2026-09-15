import { FC } from 'react';
import { Grid, Card, CardContent, Chip, Typography, Box, Tooltip } from '@mui/joy';
import GraphicEqIcon from '@mui/icons-material/GraphicEq';
import { useNavigate } from '@tanstack/react-router';
import { IAgent } from '@bike4mind/common';
import Bike4MindIcon from '@client/app/components/svgs/icons/Bike4MindIcon';
import AgentQuickActions from './AgentQuickActions';
import { LOW_CREDITS_THRESHOLD } from '@client/app/constants/agentForm';
import { AgentAvatar } from '@client/app/components/Agent/AgentAvatar';

interface AgentsGridProps {
  agents: IAgent[];
  currentUserCredits?: number;
  onAgentDelete: (deletedAgentId: string) => void;
}

const AgentsGrid: FC<AgentsGridProps> = ({ agents, currentUserCredits, onAgentDelete }) => {
  const navigate = useNavigate();

  return (
    <Grid container spacing={2} px={1}>
      {agents.map(agent => {
        const credits = agent.useOwnCredits ? agent.currentCredits || 0 : currentUserCredits || 0;
        const isLowCredits = credits < LOW_CREDITS_THRESHOLD;

        return (
          <Grid key={agent.id} xs={12} sm={6} md={4} xl={3}>
            <Card
              data-testid="agent-card"
              variant="outlined"
              sx={{
                position: 'relative',
                height: '100%',
                display: 'flex',
                flexDirection: 'column',
                cursor: 'pointer',
                border: '1px solid',
                boxShadow: 'none',
                p: 2,
                pt: 3,
                gap: 0,
                borderColor: 'divider',
                backgroundColor: theme => theme.palette.background.body,
                transition: 'border-color 200ms ease, box-shadow 200ms ease',
                '& .card-actions': {
                  opacity: { xs: 1, sm: 0 },
                  pointerEvents: { xs: 'auto', sm: 'none' },
                  transition: 'opacity 160ms ease',
                },
                '@media (hover: hover)': {
                  '&:hover': {
                    borderColor: 'primary.300',
                    boxShadow: '0 2px 8px rgba(0,0,0,0.08)',
                  },
                  '&:hover .card-actions': {
                    opacity: 1,
                    pointerEvents: 'auto',
                  },
                },
              }}
              onClick={() => {
                if (agent.type === 'voice') return;
                navigate({ to: `/agents/${agent.id}` });
              }}
            >
              {agent.type === 'voice' && (
                <Chip
                  size="sm"
                  variant="soft"
                  color="primary"
                  startDecorator={<GraphicEqIcon sx={{ width: 14, height: 14 }} />}
                  sx={{ position: 'absolute', top: 8, left: 8 }}
                  data-testid="agent-card-voice-badge"
                >
                  Voice
                </Chip>
              )}

              <AgentQuickActions
                agentId={agent.id}
                onDelete={onAgentDelete}
                isVoiceAgent={agent.type === 'voice'}
                agentName={agent.name}
              />

              <CardContent sx={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 1, p: 0 }}>
                <AgentAvatar name={agent.name} portraitUrl={agent.visual?.portraitUrl} size={64} showZoom />
                <Typography
                  data-testid="agent-card-name"
                  level="title-md"
                  sx={{ color: 'text.primary', fontWeight: 500, textAlign: 'center' }}
                >
                  {agent.name}
                </Typography>

                <Typography
                  level="body-xs"
                  sx={{
                    display: '-webkit-box',
                    WebkitLineClamp: 2,
                    WebkitBoxOrient: 'vertical',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    lineHeight: 1.4,
                    textAlign: 'center',
                    color: 'text.tertiary',
                    ...(!agent.description && { fontStyle: 'italic' }),
                  }}
                >
                  {agent.description || 'No description provided'}
                </Typography>

                {(agent.triggerWords?.length ?? 0) > 0 && (
                  <Box sx={{ display: 'flex', gap: 0.5, flexWrap: 'wrap', justifyContent: 'center' }}>
                    {agent.triggerWords!.map(word => (
                      <Chip key={word} size="sm" variant="soft" color="neutral" sx={{ fontSize: '11px' }}>
                        {word}
                      </Chip>
                    ))}
                  </Box>
                )}
              </CardContent>

              <Tooltip
                title={agent.useOwnCredits ? 'Credits balance for this agent' : 'Your account credit balance'}
                placement="top"
              >
                <Box
                  sx={{
                    display: 'flex',
                    mt: 'auto',
                    pt: 1.5,
                    justifyContent: 'space-between',
                    alignItems: 'center',
                  }}
                >
                  <Typography level="body-xs" sx={{ color: 'text.tertiary' }}>
                    {agent.useOwnCredits ? 'Agent credits' : 'Account credits'}
                  </Typography>

                  <Typography
                    level="body-xs"
                    sx={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 0.5,
                      color: isLowCredits ? 'danger.500' : 'text.tertiary',
                    }}
                  >
                    <Bike4MindIcon
                      size="10"
                      fill={isLowCredits ? 'var(--joy-palette-danger-500)' : 'var(--joy-palette-text-tertiary)'}
                    />
                    {credits.toLocaleString()}
                  </Typography>
                </Box>
              </Tooltip>
            </Card>
          </Grid>
        );
      })}
    </Grid>
  );
};

export default AgentsGrid;
