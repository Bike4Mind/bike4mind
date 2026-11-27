import { useState } from 'react';
import Box from '@mui/joy/Box';
import Button from '@mui/joy/Button';
import Typography from '@mui/joy/Typography';
import type { ColorPaletteProp } from '@mui/joy/styles';
import { AGENT_STATE_LABEL, countAgentStates, type AgentState } from '@shared/agentState';
import type { ViewAction, ViewAgent, ViewApproval, ViewSnapshot } from '@shared/viewSnapshot';
import { oneClickOptions, type BubbleOption } from './scene/bubbleAnswer';
import { AgentPrIndicator } from './AgentPrIndicator';

/** Shown as a card: the user has to act on it, or should know it went wrong. */
const ATTENTION: ReadonlySet<AgentState> = new Set(['needs-you', 'failed']);
/** The rest, collapsed to one line of counts, in this order. Working agents also get a row each, for Stop. */
const QUIET_ORDER: readonly AgentState[] = ['waiting', 'done', 'paused', 'stopped', 'idle'];

interface AttentionItem {
  key: string;
  title: string;
  detail?: string;
  pr?: ViewAgent['pr'];
  color: ColorPaletteProp;
  open: ViewAction;
  /** One click per option of the decision it waits on; absent when that needs the full card. */
  answer?: { agentId: string; decisionId: string; options: BubbleOption[] };
  approvals: ViewApproval[];
  /** Set when Stop applies (a waiting agent): the same states the peek drawer offers it for. */
  stop?: ViewAgent;
}

function decisionAnswer(agent: ViewAgent): AttentionItem['answer'] {
  const decision = agent.decision;
  if (!decision?.oneClick || decision.multiSelect) return undefined;
  const options = oneClickOptions(decision.options);
  return options && { agentId: agent.id, decisionId: decision.id, options };
}

function attentionItems(snapshot: ViewSnapshot): AttentionItem[] {
  const approvalsOf = (sessionId: string) => (snapshot.approvals ?? []).filter(item => item.sessionId === sessionId);
  const items: AttentionItem[] = [];
  if (snapshot.root.state === 'needs-you') {
    items.push({
      key: 'root',
      title: 'The orchestrating conversation',
      detail: 'Waiting for your approval',
      color: 'warning',
      open: { kind: 'open-root' },
      approvals: approvalsOf(snapshot.root.id),
    });
  }
  for (const agent of snapshot.agents.filter(candidate => ATTENTION.has(candidate.state))) {
    const waiting = agent.state === 'needs-you';
    items.push({
      key: agent.id,
      title: agent.title,
      detail: agent.decision?.question ?? agent.now,
      pr: agent.pr,
      color: waiting ? 'warning' : 'danger',
      open: { kind: 'open-agent', agentId: agent.id },
      answer: waiting ? decisionAnswer(agent) : undefined,
      approvals: waiting ? approvalsOf(agent.id) : [],
      stop: waiting ? agent : undefined,
    });
  }
  return items;
}

function quietLine(snapshot: ViewSnapshot): string {
  const counts = countAgentStates(snapshot.agents.map(agent => agent.state));
  return QUIET_ORDER.filter(state => counts[state] > 0)
    .map(state => `${counts[state]} ${AGENT_STATE_LABEL[state].toLowerCase()}`)
    .join(' \u00b7 ');
}

/** Ties a sent action to what it acted on, so a Stop comes back once the agent has moved on. */
const stopKey = (agent: ViewAgent) => `stop:${agent.id}:${agent.updatedAt}`;

/**
 * What has been sent and not yet cleared by the next snapshot, and the last failure. A sent control
 * goes away at once rather than waiting for the push, so a second click never sends it twice; one
 * main refused comes back with the error.
 */
function useSender(onAction: (action: ViewAction) => void | Promise<void>) {
  const [sent, setSent] = useState<ReadonlySet<string>>(() => new Set());
  const [error, setError] = useState<{ key: string; message: string } | null>(null);
  const send = async (key: string, action: ViewAction) => {
    setError(null);
    setSent(current => new Set(current).add(key));
    try {
      await onAction(action);
    } catch (caught) {
      setSent(current => {
        const next = new Set(current);
        next.delete(key);
        return next;
      });
      setError({ key, message: caught instanceof Error ? caught.message : String(caught) });
    }
  };
  return { sent, error, send };
}

/**
 * Focus mode: the stage cut down to what needs the user (an agent or the orchestrator waiting on
 * them, or an agent that failed), each with what can be done about it in place: a decision's options,
 * Allow once or Deny on a quick approval, Stop. Working agents get a line each with Stop; everything
 * else collapses to one line of counts. Open goes to the same places the full views do. Every action
 * goes through `onAction`, which the host checks against the snapshot (acceptViewAction).
 */
export function FocusPanel({
  snapshot,
  onAction,
}: {
  snapshot: ViewSnapshot;
  onAction(action: ViewAction): void | Promise<void>;
}) {
  const items = attentionItems(snapshot);
  const working = snapshot.agents.filter(agent => agent.state === 'working');
  const quiet = quietLine(snapshot);
  const { sent, error, send } = useSender(onAction);

  const stopButton = (agent: ViewAgent) => {
    const key = stopKey(agent);
    return (
      <Button
        size="sm"
        variant="plain"
        color="neutral"
        disabled={sent.has(key)}
        onClick={() => void send(key, { kind: 'stop', agentId: agent.id })}
        data-testid="orchestrator-focus-stop-btn"
        sx={{ flexShrink: 0 }}
      >
        Stop
      </Button>
    );
  };

  const errorLine = (keys: readonly string[]) =>
    error &&
    keys.includes(error.key) && (
      <Typography level="body-xs" color="danger" data-testid="orchestrator-focus-error">
        {error.message}
      </Typography>
    );

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
        items.map(item => {
          const answer = item.answer;
          const answerKey = answer && `answer:${answer.decisionId}`;
          const approvals = item.approvals.filter(approval => !sent.has(`approve:${approval.id}`));
          const keys = [
            ...(answerKey ? [answerKey] : []),
            ...item.approvals.map(approval => `approve:${approval.id}`),
            ...(item.stop ? [stopKey(item.stop)] : []),
          ];
          return (
            <Box
              key={item.key}
              data-testid="orchestrator-focus-item"
              data-color={item.color}
              sx={{
                display: 'flex',
                flexDirection: 'column',
                gap: 1,
                p: 1.5,
                borderRadius: 'md',
                bgcolor: 'background.surface',
                border: '1px solid',
                borderColor: `${item.color}.outlinedBorder`,
              }}
            >
              <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5 }}>
                <Box
                  aria-hidden
                  sx={{ width: 8, height: 8, borderRadius: '50%', flexShrink: 0, bgcolor: `${item.color}.solidBg` }}
                />
                <Box sx={{ flex: 1, minWidth: 0 }}>
                  <Typography level="title-sm" noWrap>
                    {item.title}
                  </Typography>
                  <AgentPrIndicator
                    agentId={item.key}
                    pr={item.pr}
                    onOpen={() => void onAction({ kind: 'open-pr', agentId: item.key })}
                  />
                  {item.detail && (
                    <Typography level="body-sm" textColor="text.secondary" sx={{ overflowWrap: 'anywhere' }}>
                      {item.detail}
                    </Typography>
                  )}
                </Box>
                {item.stop && stopButton(item.stop)}
                <Button
                  size="sm"
                  variant="soft"
                  color={item.color}
                  onClick={() => void onAction(item.open)}
                  data-testid="orchestrator-focus-open-btn"
                  sx={{ flexShrink: 0 }}
                >
                  Open
                </Button>
              </Box>
              {answer && answerKey && !sent.has(answerKey) && (
                <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 0.75, pl: 2.5 }}>
                  {answer.options.map(option => (
                    <Button
                      key={option.label}
                      size="sm"
                      variant={option.recommended ? 'solid' : 'outlined'}
                      color="primary"
                      title={option.recommended ? 'Recommended' : undefined}
                      onClick={() =>
                        void send(answerKey, {
                          kind: 'answer',
                          agentId: answer.agentId,
                          decisionId: answer.decisionId,
                          answer: { status: 'answered', answers: [{ selected: [option.label] }] },
                        })
                      }
                      data-testid="orchestrator-focus-option-btn"
                    >
                      {option.face}
                    </Button>
                  ))}
                </Box>
              )}
              {approvals.map(approval => (
                <Box
                  key={approval.id}
                  data-testid="orchestrator-focus-approval"
                  sx={{ display: 'flex', alignItems: 'center', gap: 0.75, pl: 2.5 }}
                >
                  <Typography level="body-sm" fontFamily="code" noWrap sx={{ flex: 1, minWidth: 0 }}>
                    {approval.label}
                  </Typography>
                  <Button
                    size="sm"
                    variant="solid"
                    color="primary"
                    onClick={() =>
                      void send(`approve:${approval.id}`, { kind: 'approve', approvalId: approval.id, mode: 'once' })
                    }
                    data-testid="orchestrator-focus-allow-once-btn"
                  >
                    Allow once
                  </Button>
                  <Button
                    size="sm"
                    variant="outlined"
                    color="neutral"
                    onClick={() =>
                      void send(`approve:${approval.id}`, { kind: 'approve', approvalId: approval.id, mode: 'deny' })
                    }
                    data-testid="orchestrator-focus-deny-btn"
                  >
                    Deny
                  </Button>
                </Box>
              ))}
              {errorLine(keys)}
            </Box>
          );
        })
      )}
      {working.length > 0 && (
        <Box sx={{ display: 'flex', flexDirection: 'column', px: 0.5 }}>
          {working.map(agent => (
            <Box
              key={agent.id}
              data-testid="orchestrator-focus-working-row"
              sx={{ display: 'flex', alignItems: 'center', gap: 1, minHeight: 32 }}
            >
              <Typography level="body-sm" noWrap sx={{ flexShrink: 1, minWidth: 0 }}>
                {agent.title}
              </Typography>
              {agent.now && (
                <Typography level="body-xs" textColor="text.tertiary" noWrap sx={{ flex: 1, minWidth: 0 }}>
                  {agent.now}
                </Typography>
              )}
              <Box sx={{ flex: agent.now ? 0 : 1 }} />
              <AgentPrIndicator
                agentId={agent.id}
                pr={agent.pr}
                onOpen={() => void onAction({ kind: 'open-pr', agentId: agent.id })}
              />
              {stopButton(agent)}
              {errorLine([stopKey(agent)])}
            </Box>
          ))}
        </Box>
      )}
      {quiet && (
        <Typography level="body-xs" textColor="text.tertiary" data-testid="orchestrator-focus-quiet" sx={{ px: 0.5 }}>
          {quiet}
        </Typography>
      )}
      {snapshot.agents
        .filter(agent => QUIET_ORDER.includes(agent.state) && agent.pr)
        .map(agent => (
          <Box
            key={agent.id}
            data-testid={`orchestrator-focus-pr-${agent.id}`}
            sx={{ display: 'flex', alignItems: 'center', gap: 1, minWidth: 0 }}
          >
            <Typography level="body-sm" noWrap sx={{ minWidth: 0 }}>
              {agent.title}
            </Typography>
            <AgentPrIndicator
              agentId={agent.id}
              pr={agent.pr}
              onOpen={() => void onAction({ kind: 'open-pr', agentId: agent.id })}
            />
          </Box>
        ))}
    </Box>
  );
}
