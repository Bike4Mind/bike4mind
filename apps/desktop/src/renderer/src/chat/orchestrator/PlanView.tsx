import Box from '@mui/joy/Box';
import CircularProgress from '@mui/joy/CircularProgress';
import Typography from '@mui/joy/Typography';
import { AGENT_STATE_LABEL } from '@shared/agentState';
import type { ViewAction, ViewSnapshot } from '@shared/viewSnapshot';
import { AgentPrIndicator } from './AgentPrIndicator';
import { stateJoyColor } from './statePalette';

/*
 * Built on the view contract alone, as Swimlanes is: it may import only @shared/viewSnapshot, @shared/agentState,
 * ./statePalette, ./AgentPrIndicator, React and the UI kit. snapshotView.tsx hosts it.
 */

const INDENT_STEP = 16;
const MAX_INDENT_LEVELS = 4;
/** Below this container width the "next" line drops under the current one. */
const NARROW_PX = 480;

const clamp = { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0 } as const;

type SnapshotAgent = ViewSnapshot['agents'][number];

/** The line for what the agent is on: its question when it needs the user, else the plan's current item. */
function currentLine(agent: SnapshotAgent): { text: string; testId: string } | null {
  if (agent.state === 'needs-you') {
    return { text: agent.decision?.question ?? 'Waiting on you', testId: 'plan-view-needs-you' };
  }
  const { plan } = agent;
  if (!plan?.total) return null;
  if (plan.done === plan.total) return { text: 'All done', testId: 'plan-view-current' };
  return plan.current ? { text: plan.current, testId: 'plan-view-current' } : null;
}

function PlanRow({ agent, onAction }: { agent: SnapshotAgent; onAction(action: ViewAction): void }) {
  const { plan } = agent;
  const hasPlan = !!plan?.total;
  const current = currentLine(agent);
  const next = hasPlan ? plan.next : undefined;
  // An aria-label replaces the button's contents as its name, so the plan has to be in it.
  const label = [
    `${agent.title}: ${AGENT_STATE_LABEL[agent.state]}`,
    hasPlan ? `${plan.done} of ${plan.total} done` : 'no plan yet',
    current?.text,
    next && `next ${next}`,
  ]
    .filter(Boolean)
    .join(', ');
  return (
    <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.75, minWidth: 0 }}>
      <Box
        component="button"
        type="button"
        onClick={() => onAction({ kind: 'open-agent', agentId: agent.id })}
        aria-label={label}
        data-testid={`plan-view-row-${agent.id}`}
        data-state={agent.state}
        sx={{
          flex: 1,
          minWidth: 0,
          display: 'grid',
          gridTemplateColumns: 'auto minmax(0, 1fr) minmax(0, 1fr)',
          gridTemplateAreas: '"ring title next" "ring current next"',
          columnGap: 1.5,
          rowGap: 0.25,
          alignItems: 'center',
          py: 1,
          pr: 1.5,
          pl: `${12 + Math.min(Math.max(agent.depth - 1, 0), MAX_INDENT_LEVELS) * INDENT_STEP}px`,
          textAlign: 'left',
          font: 'inherit',
          color: 'inherit',
          cursor: 'pointer',
          borderRadius: 'md',
          bgcolor: 'background.surface',
          border: agent.state === 'needs-you' ? '2px solid' : '1px solid',
          borderColor: agent.state === 'needs-you' ? 'warning.outlinedBorder' : 'divider',
          '&:hover': { bgcolor: 'background.level1' },
          '&:focus-visible': { outline: '2px solid', outlineColor: 'focusVisible', outlineOffset: 2 },
          [`@container (max-width: ${NARROW_PX}px)`]: {
            gridTemplateColumns: 'auto minmax(0, 1fr)',
            gridTemplateAreas: '"ring title" "ring current" "ring next"',
          },
        }}
      >
        <CircularProgress
          determinate
          size="md"
          value={hasPlan ? (plan.done / plan.total) * 100 : 0}
          color={stateJoyColor(agent.state)}
          data-testid="plan-view-ring"
          sx={{ gridArea: 'ring', '--CircularProgress-size': '40px' }}
        >
          <Typography level="body-xs">{hasPlan ? `${plan.done}/${plan.total}` : '-'}</Typography>
        </CircularProgress>
        <Typography level="title-sm" sx={{ gridArea: 'title', ...clamp }}>
          {agent.title}
        </Typography>
        <Box sx={{ gridArea: 'current', minWidth: 0 }}>
          {current ? (
            <Typography
              level="body-sm"
              color={agent.state === 'needs-you' ? 'warning' : undefined}
              data-testid={current.testId}
              sx={clamp}
            >
              {current.text}
            </Typography>
          ) : (
            !hasPlan && (
              <Typography level="body-sm" textColor="text.tertiary" data-testid="plan-view-empty-plan" sx={clamp}>
                No plan yet
              </Typography>
            )
          )}
        </Box>
        {next && (
          <Typography
            level="body-xs"
            textColor="text.tertiary"
            data-testid="plan-view-next"
            sx={{ gridArea: 'next', ...clamp }}
          >
            {`Next: ${next}`}
          </Typography>
        )}
      </Box>
      <AgentPrIndicator
        agentId={agent.id}
        pr={agent.pr}
        onOpen={() => onAction({ kind: 'open-pr', agentId: agent.id })}
      />
    </Box>
  );
}

/**
 * Plan: one row per agent with its plan as a done/total ring, what it is on (or the question it waits on
 * you for) and what comes next. Rows keep the snapshot's urgency order and indent by depth.
 */
export function PlanView({ snapshot, onAction }: { snapshot: ViewSnapshot; onAction(action: ViewAction): void }) {
  return (
    <Box
      data-testid="plan-view-root"
      sx={{
        flex: 1,
        minWidth: 0,
        containerType: 'inline-size',
        display: 'flex',
        flexDirection: 'column',
        gap: 0.75,
        p: 2,
        overflowY: 'auto',
        overflowX: 'hidden',
      }}
    >
      {snapshot.agents.length === 0 && (
        <Typography level="body-sm" textColor="text.tertiary" data-testid="plan-view-no-agents">
          No agents yet
        </Typography>
      )}
      {snapshot.agents.map(agent => (
        <PlanRow key={agent.id} agent={agent} onAction={onAction} />
      ))}
    </Box>
  );
}
