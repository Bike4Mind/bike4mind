import Box from '@mui/joy/Box';
import Button from '@mui/joy/Button';
import Typography from '@mui/joy/Typography';
import type { ColorPaletteProp } from '@mui/joy/styles';
import { AGENT_STATE_LABEL, countAgentStates, type AgentState } from '@shared/agentState';
import type { ViewAction, ViewAgent, ViewSnapshot } from '@shared/viewSnapshot';

/** Shown as a card: the user has to act on it, or should know it went wrong. */
const ATTENTION: ReadonlySet<AgentState> = new Set(['needs-you', 'failed']);
/** The rest, collapsed to one line of counts, in this order. */
const QUIET_ORDER: readonly AgentState[] = ['working', 'done', 'stopped', 'idle'];

interface AttentionItem {
  key: string;
  title: string;
  detail?: string;
  color: ColorPaletteProp;
  action: ViewAction;
}

function attentionItems(snapshot: ViewSnapshot): AttentionItem[] {
  const items: AttentionItem[] = [];
  if (snapshot.root.state === 'needs-you') {
    items.push({
      key: 'root',
      title: 'The orchestrating conversation',
      detail: 'Waiting for your approval',
      color: 'warning',
      action: { kind: 'open-root' },
    });
  }
  const urgent = (agent: ViewAgent) => ATTENTION.has(agent.state);
  for (const agent of snapshot.agents.filter(urgent)) {
    items.push({
      key: agent.id,
      title: agent.title,
      detail: agent.decision?.question ?? agent.now,
      color: agent.state === 'failed' ? 'danger' : 'warning',
      action: { kind: 'open-agent', agentId: agent.id },
    });
  }
  return items;
}

function quietLine(snapshot: ViewSnapshot): string {
  const counts = countAgentStates(
    snapshot.agents.filter(agent => !ATTENTION.has(agent.state)).map(agent => agent.state)
  );
  return QUIET_ORDER.filter(state => counts[state] > 0)
    .map(state => `${counts[state]} ${AGENT_STATE_LABEL[state].toLowerCase()}`)
    .join(' \u00B7 ');
}

/**
 * Focus mode: the stage cut down to what needs the user (an agent or the orchestrator waiting on
 * them, or an agent that failed). Everything else collapses to one line of counts. Opening an item
 * goes to the same places the full views do, where answering and approving live.
 */
export function FocusPanel({ snapshot, onAction }: { snapshot: ViewSnapshot; onAction(action: ViewAction): void }) {
  const items = attentionItems(snapshot);
  const quiet = quietLine(snapshot);

  return (
    <Box
      data-testid="orchestrator-focus-panel"
      sx={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 1, p: 2, maxWidth: 640, width: '100%', mx: 'auto' }}
    >
      {items.length === 0 ? (
        <Typography level="body-md" textColor="text.secondary" data-testid="orchestrator-focus-empty" sx={{ py: 2 }}>
          Nothing needs you right now.
        </Typography>
      ) : (
        items.map(item => (
          <Box
            key={item.key}
            data-testid="orchestrator-focus-item"
            data-color={item.color}
            sx={{
              display: 'flex',
              alignItems: 'center',
              gap: 1.5,
              p: 1.5,
              borderRadius: 'md',
              bgcolor: 'background.surface',
              border: '1px solid',
              borderColor: `${item.color}.outlinedBorder`,
            }}
          >
            <Box
              aria-hidden
              sx={{ width: 8, height: 8, borderRadius: '50%', flexShrink: 0, bgcolor: `${item.color}.solidBg` }}
            />
            <Box sx={{ flex: 1, minWidth: 0 }}>
              <Typography level="title-sm" noWrap>
                {item.title}
              </Typography>
              {item.detail && (
                <Typography level="body-sm" textColor="text.secondary" sx={{ overflowWrap: 'anywhere' }}>
                  {item.detail}
                </Typography>
              )}
            </Box>
            <Button
              size="sm"
              variant="soft"
              color={item.color}
              onClick={() => onAction(item.action)}
              data-testid="orchestrator-focus-open-btn"
              sx={{ flexShrink: 0 }}
            >
              Open
            </Button>
          </Box>
        ))
      )}
      {quiet && (
        <Typography level="body-xs" textColor="text.tertiary" data-testid="orchestrator-focus-quiet" sx={{ px: 0.5 }}>
          {quiet}
        </Typography>
      )}
    </Box>
  );
}
