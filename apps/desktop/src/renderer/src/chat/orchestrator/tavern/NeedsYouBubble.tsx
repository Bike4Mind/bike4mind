import { useState } from 'react';
import Box from '@mui/joy/Box';
import type { ChatApprovalAnswer } from '@shared/chat';
import { pendingCallsIn } from '@shared/needsYou';
import type { TaskDecisionAnswer } from '@shared/orchestration';
import { refreshKeyOf, useSessionMessages } from '../AgentPeekDrawer';
import type { AgentView } from '../roster';
import { type BubblePlan, planForCall, planForQuestion } from './bubbleAnswer';

const PROMPT_MAX = 70;

const truncate = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The plan for one agent: a worker decision wins, then the first call parked at the approval gate. */
function usePlan(agent: AgentView): BubblePlan {
  const { messages } = useSessionMessages(agent.id, refreshKeyOf(agent));
  if (agent.decision) {
    return planForQuestion(agent.decision.question, { via: 'decision', decisionId: agent.decision.id });
  }
  return planForCall(pendingCallsIn(messages)[0]);
}

// Pixel-sign buttons, drawn in the bubble's own ink so they read as part of it.
const buttonSx = {
  font: 'inherit',
  fontSize: '0.92em',
  lineHeight: 1.2,
  px: '0.55em',
  py: '0.2em',
  border: '2px solid #2a1d10',
  borderRadius: '4px',
  cursor: 'pointer',
  bgcolor: 'rgba(255, 250, 240, 0.94)',
  color: '#2a1d10',
  '&:hover': { bgcolor: '#fff7df' },
  '&:focus-visible': { outline: '2px solid #2a1d10', outlineOffset: 2 },
  '&:disabled': { opacity: 0.5, cursor: 'default' },
} as const;

const primarySx = { ...buttonSx, bgcolor: '#2a1d10', color: '#f5c542', '&:hover': { bgcolor: '#3d2a17' } } as const;

/**
 * The zone's "needs you" bubble with the focused agent's answer in it: Approve / Deny for a call at
 * the approval gate, one button per option for a short single-choice question, and Open for the
 * rest. Answers go through the same `respondToApproval` / `answerTaskDecision` calls as the peek
 * drawer and NeedsYouCard, so main settles the wait once and the card, the dock badge and the
 * notifications all clear with it (main/attention/needsYouMonitor.ts). Never offers "always allow".
 */
export function NeedsYouBubble({
  waiting,
  nameOf,
  onOpen,
  testId,
}: {
  /** The zone's waiting agents, left to right. */
  waiting: readonly AgentView[];
  nameOf(agent: AgentView): string;
  /** Open the full card for this agent (the peek drawer). */
  onOpen(id: string): void;
  testId: string;
}) {
  const [focusedId, setFocusedId] = useState<string | undefined>(undefined);
  const index = Math.max(
    0,
    waiting.findIndex(agent => agent.id === focusedId)
  );
  const agent = waiting[index];
  const label = waiting.length === 1 ? 'Needs you!' : `Needs you! ×${waiting.length}`;
  return (
    <Box
      data-testid={testId}
      role="group"
      aria-label={`${nameOf(agent)} needs you`}
      sx={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: '0.3em',
        maxWidth: 'min(42cqw, 320px)',
        px: '0.6em',
        py: '0.35em',
        borderRadius: '6px',
        border: '2px solid #2a1d10',
        bgcolor: '#f5c542',
        color: '#2a1d10',
        fontSize: 'clamp(10px, 2.2cqh, 14px)',
        lineHeight: 1.2,
        pointerEvents: 'auto',
      }}
    >
      <Box sx={{ display: 'flex', alignItems: 'center', gap: '0.4em', fontWeight: 700, whiteSpace: 'nowrap' }}>
        <span data-testid={`${testId}-label`}>{label}</span>
        {waiting.length > 1 && (
          <Box
            component="button"
            type="button"
            aria-label="Next waiting agent"
            data-testid={`${testId}-next`}
            onClick={() => setFocusedId(waiting[(index + 1) % waiting.length].id)}
            sx={buttonSx}
          >
            {'▸'}
          </Box>
        )}
      </Box>
      {/* Keyed on the agent so a half-sent answer never carries over to the next one in the cycle. */}
      <AgentAnswer
        key={agent.id}
        agent={agent}
        name={nameOf(agent)}
        named={waiting.length > 1}
        onOpen={onOpen}
        testId={testId}
      />
    </Box>
  );
}

function AgentAnswer({
  agent,
  name,
  named,
  onOpen,
  testId,
}: {
  agent: AgentView;
  name: string;
  /** Several agents share the bubble, so say which one this answer goes to. */
  named: boolean;
  onOpen(id: string): void;
  testId: string;
}) {
  const plan = usePlan(agent);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const send = async (request: () => Promise<unknown>) => {
    setSending(true);
    setError(null);
    try {
      await request();
    } catch (caught) {
      setError(errorText(caught));
      setSending(false);
    }
  };
  const respond = (approvalId: string, answer: ChatApprovalAnswer) =>
    void send(() => window.b4m.chat.respondToApproval(approvalId, answer));
  const decide = (decisionId: string, answer: TaskDecisionAnswer) =>
    void send(() => window.b4m.chat.answerTaskDecision(agent.id, decisionId, answer));

  const prompt = plan.kind === 'approve' ? plan.summary : plan.prompt;
  const open = (
    <Box
      component="button"
      type="button"
      onClick={() => onOpen(agent.id)}
      data-testid={`${testId}-open`}
      sx={plan.kind === 'open' ? primarySx : buttonSx}
    >
      Open
    </Box>
  );

  return (
    <>
      {(named || prompt) && (
        <Box
          data-testid={`${testId}-prompt`}
          title={prompt}
          sx={{ fontWeight: 500, textAlign: 'center', overflowWrap: 'anywhere' }}
        >
          {named && <strong>{`${name}: `}</strong>}
          {prompt && truncate(prompt, PROMPT_MAX)}
        </Box>
      )}
      {error && (
        <Box data-testid={`${testId}-error`} role="alert" sx={{ fontWeight: 500, color: '#7a1010' }}>
          {truncate(error, PROMPT_MAX)}
        </Box>
      )}
      <Box
        data-testid={`${testId}-actions`}
        data-plan={plan.kind}
        sx={{ display: 'flex', flexWrap: 'wrap', justifyContent: 'center', gap: '0.3em' }}
      >
        {plan.kind === 'approve' && (
          <>
            <Box
              component="button"
              type="button"
              disabled={sending}
              onClick={() => respond(plan.approvalId, { decision: 'once' })}
              data-testid={`${testId}-approve`}
              sx={primarySx}
            >
              Approve
            </Box>
            <Box
              component="button"
              type="button"
              disabled={sending}
              onClick={() => respond(plan.approvalId, { decision: 'deny' })}
              data-testid={`${testId}-deny`}
              sx={buttonSx}
            >
              Deny
            </Box>
          </>
        )}
        {plan.kind === 'choose' &&
          plan.options.map((option, optionIndex) => {
            const target = plan.target;
            const answers = [{ selected: [option.label] }];
            return (
              <Box
                key={option.label}
                component="button"
                type="button"
                disabled={sending}
                title={option.recommended ? 'Recommended' : undefined}
                onClick={() =>
                  target.via === 'decision'
                    ? decide(target.decisionId, { status: 'answered', answers })
                    : respond(target.approvalId, { decision: 'once', answers })
                }
                data-testid={`${testId}-option-${optionIndex}`}
                sx={option.recommended ? primarySx : buttonSx}
              >
                {option.face}
              </Box>
            );
          })}
        {open}
      </Box>
    </>
  );
}
