import { useEffect, useState, type ReactNode } from 'react';
import Box from '@mui/joy/Box';
import Stack from '@mui/joy/Stack';
import Typography from '@mui/joy/Typography';
import Button from '@mui/joy/Button';
import Textarea from '@mui/joy/Textarea';
import Select from '@mui/joy/Select';
import Option from '@mui/joy/Option';
import type { TaskAction } from '@shared/orchestration';
import type { ChatModelOption } from '@shared/chat';
import { hostChat } from '../../host/hostChat';
import type { AgentView } from './roster';

function TaskDetails({ compact, children }: { compact: boolean; children: ReactNode }) {
  if (!compact) return children;
  return (
    <Box component="details" data-testid="agent-task-details">
      <Box
        component="summary"
        data-testid="agent-task-details-toggle"
        sx={{ cursor: 'pointer', fontFamily: 'body', fontSize: 'xs', color: 'text.secondary', py: 0.5 }}
      >
        Criteria, attempts and evidence
      </Box>
      <Stack spacing={1} sx={{ pt: 0.75 }}>
        {children}
      </Stack>
    </Box>
  );
}

export function TaskDecisionPanel({ agent, compact = false }: { agent: AgentView; compact?: boolean }) {
  const [models, setModels] = useState<ChatModelOption[]>([]);
  const [task, setTask] = useState(agent.workerTask);
  const [note, setNote] = useState('');
  const [upgrade, setUpgrade] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    setTask(agent.workerTask);
  }, [agent.workerTask]);
  const attemptId = agent.workerTask?.attempts.at(-1)?.id;
  const decisionId =
    agent.workerTask?.state.status === 'escalation-requested' ? agent.workerTask.state.decisionId : undefined;
  useEffect(() => {
    setNote('');
    setUpgrade(null);
    setError(null);
  }, [agent.id, attemptId, decisionId]);
  useEffect(() => {
    let current = true;
    async function load() {
      try {
        const catalog = await hostChat.listModels();
        if (current) setModels(catalog.models);
      } catch (failure) {
        if (current) setError(`Could not load model names: ${String(failure)}`);
      }
    }
    void load();
    return () => {
      current = false;
    };
  }, [agent.id]);
  async function decide(action: TaskAction) {
    setBusy(true);
    setError(null);
    try {
      const updated = await window.b4m.chat.taskAction(agent.id, action);
      setTask(updated.workerTask);
    } catch (failure) {
      setError(String(failure));
    } finally {
      setBusy(false);
    }
  }
  const name = (id: string) => models.find(model => model.id === id)?.name ?? id;
  const state = task?.state;
  const stopped = agent.state !== 'working';
  const allowed = agent.orchestrationPolicy?.policy.escalation;
  const taskOpen = state && state.status !== 'canceled' && !(state.status === 'completed' && state.accepted);
  const needsAssessment = taskOpen && state.status !== 'queued' && state.status !== 'running';
  return (
    <Stack spacing={1} data-testid="agent-task-panel">
      {!compact && (
        <Typography level="body-xs" data-testid="agent-effective-model">
          {agent.workerSelection?.role ?? 'Inherited worker'}: {name(agent.model)}
          {agent.workerSelection ? ` (${agent.workerSelection.source})` : ''}
        </Typography>
      )}
      {error && (
        <Typography role="alert" color="danger" sx={{ whiteSpace: 'pre-line' }}>
          {error}
        </Typography>
      )}
      {task && state && (
        <>
          {!compact && (
            <Typography level="title-sm" data-testid="agent-task-state">
              Task: {state.status}
              {state.status === 'completed' ? (state.accepted ? ' - accepted' : ' - awaiting assessment') : ''}
            </Typography>
          )}
          {'reason' in state && <Typography level="body-sm">{state.reason}</Typography>}
          {state.status === 'canceled' && (
            <Typography level="body-xs" data-testid="agent-task-closed-note">
              This task is closed. You can still chat in this conversation; follow-ups do not reopen the task.
            </Typography>
          )}
          <TaskDetails compact={compact}>
            <Typography level="body-sm">{task.contract.outcome}</Typography>
            <Typography level="body-xs">
              Attempts: {task.attempts.map(attempt => `${name(attempt.model)} (${attempt.trigger})`).join(', ')}
            </Typography>
            {task.contract.acceptanceCriteria.map(criterion => (
              <Typography key={criterion} level="body-xs">
                Criterion: {criterion}
              </Typography>
            ))}
            {'evidence' in state &&
              state.evidence.map((evidence, index) => (
                <Typography key={index} level="body-xs">
                  {evidence}
                </Typography>
              ))}
            {state.status === 'completed' && (
              <>
                <Typography level="body-sm">{state.handoff}</Typography>
                <Typography level="body-xs">Changed paths: {state.changedPaths.join(', ') || '(none)'}</Typography>
                {state.verification.map((check, index) => (
                  <Typography key={index} level="body-xs" color={check.outcome === 'passed' ? 'success' : 'danger'}>
                    {check.criterion}: {check.outcome} - {check.command}: {check.evidence}
                  </Typography>
                ))}
                {state.unmetCriteria.map(criterion => (
                  <Typography key={criterion} color="danger">
                    Unmet: {criterion}
                  </Typography>
                ))}
                {state.assessment && <Typography level="body-xs">Assessment: {state.assessment}</Typography>}
              </>
            )}
          </TaskDetails>
          {needsAssessment && (
            <>
              <Textarea
                aria-label="Task decision evidence or revision"
                data-testid="agent-task-note"
                placeholder="Assessment evidence, missing decision, or revision instructions"
                value={note}
                onChange={event => setNote(event.target.value)}
              />
              {state.status === 'completed' && (
                <Button
                  disabled={busy || !stopped || !note.trim()}
                  data-testid="agent-task-accept-btn"
                  onClick={() => void decide({ kind: 'accept', assessment: note })}
                >
                  Accept reviewed evidence
                </Button>
              )}
              <Button
                variant="outlined"
                color="neutral"
                disabled={busy || !stopped || !note.trim()}
                data-testid="agent-task-revise-btn"
                onClick={() => void decide({ kind: 'revise', contract: task.contract, instruction: note })}
              >
                Clarify and continue this task
              </Button>
              {state.status === 'escalation-requested' && (
                <>
                  <Typography level="body-xs">
                    Requested: {state.requestedModelId ? name(state.requestedModelId) : 'clarification'}. An approved
                    upgrade starts one paid attempt in this task; siblings and planner keep their models. No hard
                    spending cap is enforced.
                  </Typography>
                  <Select
                    data-testid="agent-task-upgrade-select"
                    aria-label="Task upgrade model"
                    value={upgrade}
                    onChange={(_event, value) => setUpgrade(value)}
                  >
                    {(allowed?.allowedRoles.includes(task.contract.role) ? allowed.allowedModels : []).map(id => (
                      <Option key={id} value={id} data-testid={`agent-task-upgrade-option-${id}`}>
                        {name(id)}
                      </Option>
                    ))}
                  </Select>
                  <Button
                    disabled={busy || !stopped || !upgrade}
                    data-testid="agent-task-upgrade-btn"
                    onClick={() =>
                      upgrade && void decide({ kind: 'upgrade', modelId: upgrade, decisionId: state.decisionId })
                    }
                  >
                    Approve this model upgrade
                  </Button>
                  <Button
                    variant="outlined"
                    color="neutral"
                    disabled={busy || !stopped}
                    data-testid="agent-task-deny-btn"
                    onClick={() =>
                      void decide({
                        kind: 'deny',
                        decisionId: state.decisionId,
                        reason: note.trim() || 'User declined the model upgrade.',
                      })
                    }
                  >
                    Deny upgrade
                  </Button>
                </>
              )}
            </>
          )}
          {taskOpen && (
            <Button
              variant="outlined"
              color="danger"
              disabled={busy}
              data-testid="agent-task-cancel-btn"
              onClick={() => void decide({ kind: 'cancel', reason: note.trim() || 'Canceled by user.' })}
            >
              Cancel task
            </Button>
          )}
        </>
      )}
    </Stack>
  );
}
