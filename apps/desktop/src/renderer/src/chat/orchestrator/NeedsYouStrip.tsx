import Box from '@mui/joy/Box';
import Stack from '@mui/joy/Stack';
import Typography from '@mui/joy/Typography';
import type { AgentPersona } from '@shared/agentPersona';
import { spawnPathOf } from '@shared/pendingDecisions';
import { DecisionCard, type DecisionAsker } from './DecisionCard';
import type { AgentView } from './roster';
import { useTreeDecisions } from './useTreeDecisions';

/** The orchestrating conversation's name at the head of each path, when it has none of its own. */
const ROOT_FALLBACK = 'Orchestrator';

/** The name the stage gives an agent and its chain from the root, as a DecisionCard shows who asked. */
export function askerOf(
  agents: readonly AgentView[],
  personas: ReadonlyMap<string, AgentPersona>,
  sessionId: string,
  rootTitle: string
): DecisionAsker {
  const nameOf = (agent: AgentView) => personas.get(agent.id)?.label ?? agent.title;
  const chain = spawnPathOf(agents, sessionId);
  const self = chain.at(-1);
  return { name: self ? nameOf(self) : sessionId, path: [rootTitle, ...chain.map(nameOf)] };
}

/**
 * Everything the agents under an Orchestrate parent are waiting on, flat, so a run can be minded
 * from the parent without opening any agent. Hidden when nothing is open.
 */
export function NeedsYouStrip({
  agents,
  personas,
  rootTitle,
  onOpenDetails,
}: {
  agents: readonly AgentView[];
  personas: ReadonlyMap<string, AgentPersona>;
  rootTitle?: string;
  onOpenDetails(sessionId: string): void;
}) {
  const { byId, loadError, refresh } = useTreeDecisions(agents);
  const decisions = [...byId.values()].flat();
  if (decisions.length === 0 && !loadError) return null;
  const root = rootTitle?.trim() || ROOT_FALLBACK;

  return (
    <Box
      role="region"
      aria-label="Needs you"
      // Focusable so the list can be scrolled from the keyboard once it overflows.
      tabIndex={0}
      data-testid="orchestrator-needs-you-strip"
      sx={{
        flexShrink: 0,
        maxHeight: '40%',
        overflowY: 'auto',
        overscrollBehavior: 'contain',
        px: 1.5,
        pb: 1,
        borderBottom: '1px solid',
        borderColor: 'divider',
      }}
    >
      <Typography level="title-sm" color="warning" sx={{ py: 0.75 }} data-testid="orchestrator-needs-you-strip-title">
        Needs you ({decisions.length})
      </Typography>
      {loadError && (
        <Typography level="body-xs" color="danger" data-testid="orchestrator-needs-you-strip-error">
          {loadError}
        </Typography>
      )}
      <Stack spacing={1.5}>
        {decisions.map(decision => (
          <DecisionCard
            key={`${decision.sessionId}:${decision.decisionId}`}
            decision={decision}
            asker={askerOf(agents, personas, decision.sessionId, root)}
            onOpenDetails={onOpenDetails}
            onSettled={refresh}
          />
        ))}
      </Stack>
    </Box>
  );
}
