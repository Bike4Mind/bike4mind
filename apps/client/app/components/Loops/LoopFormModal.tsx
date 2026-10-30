import { useState } from 'react';
import {
  Box,
  Button,
  Chip,
  ChipDelete,
  DialogTitle,
  FormControl,
  FormHelperText,
  FormLabel,
  Input,
  Modal,
  ModalDialog,
  Option,
  Select,
  Stack,
  Textarea,
  Typography,
} from '@mui/joy';
import { DEFAULT_LOOP_STAGES, type ILoop } from '@bike4mind/common';
import { PICKABLE_TOOLS } from '@client/app/components/Agent/OrchestrationSection';
import { getToolDisplayName } from '@client/app/utils/toolMapping';
import { useMcpServers } from '@client/app/hooks/data/mcpServers';
import { useGetAgents } from '@client/app/hooks/data/agents';
import { useCreateLoop, useLoops, useUpdateLoop, type LoopFormPayload } from '@client/app/hooks/data/loops';

// Limits mirror apps/client/server/utils/loopValidation.ts; keep in sync.
const NAME_MAX = 120;
const GOAL_MAX = 8000;
const TOOLS_MAX = 50;
const STAGES_MAX = 20;
const STAGE_NAME_MAX = 60;
const OVERSEES_MAX = 5;
const INTERVAL_MIN = 5;
const INTERVAL_MAX = 10_080;
// Mirrors validateLoopStages (apps/client/server/utils/loopValidation.ts): the last stage means closed.
const STAGES_MIN = 2;

const UNIT_MINUTES = { minutes: 1, hours: 60, days: 1440 } as const;
type IntervalUnit = keyof typeof UNIT_MINUTES;

export interface LoopFormValues {
  name: string;
  goal: string;
  interval: string;
  intervalUnit: IntervalUnit;
  tools: string[];
  stages: string[];
  /** '' means no agent. */
  agentId: string;
  /** Ids of the owner's other loops this one oversees. */
  oversees: string[];
  /** '' means no daily budget. */
  budget: string;
}

export type LoopFormErrors = Partial<
  Record<'name' | 'goal' | 'interval' | 'tools' | 'stages' | 'oversees' | 'budget', string>
>;

/** Checks the form against the API's limits; `payload` is set only when there are no errors. */
export function validateLoopForm(
  values: LoopFormValues,
  mode: 'create' | 'edit'
): { errors: LoopFormErrors; payload?: LoopFormPayload } {
  const errors: LoopFormErrors = {};
  const name = values.name.trim();
  const goal = values.goal.trim();
  if (!name) errors.name = 'Name is required';
  else if (name.length > NAME_MAX) errors.name = `Name must be ${NAME_MAX} characters or fewer`;
  if (!goal) errors.goal = 'Goal is required';
  else if (goal.length > GOAL_MAX) errors.goal = `Goal must be ${GOAL_MAX} characters or fewer`;

  const intervalMinutes = Number(values.interval) * UNIT_MINUTES[values.intervalUnit];
  if (!values.interval.trim() || !Number.isInteger(intervalMinutes)) {
    errors.interval = 'Interval must be a whole number of minutes';
  } else if (intervalMinutes < INTERVAL_MIN || intervalMinutes > INTERVAL_MAX) {
    errors.interval = `Interval must be from ${INTERVAL_MIN} minutes to 7 days`;
  }

  if (values.tools.length > TOOLS_MAX) errors.tools = `Pick ${TOOLS_MAX} tools or fewer`;
  if (values.oversees.length > OVERSEES_MAX) errors.oversees = `Pick ${OVERSEES_MAX} loops or fewer`;

  const stages = values.stages.map(s => s.trim());
  if (stages.length < STAGES_MIN || stages.length > STAGES_MAX) {
    errors.stages = `A loop needs ${STAGES_MIN} to ${STAGES_MAX} stages`;
  } else if (stages.some(s => !s || s.length > STAGE_NAME_MAX)) {
    errors.stages = `Stage names must be 1 to ${STAGE_NAME_MAX} characters`;
  } else if (new Set(stages).size !== stages.length) {
    errors.stages = 'Stage names must be unique';
  }

  // Mirrors validateLoopBudget (apps/client/server/utils/loopValidation.ts).
  const budget = Number(values.budget);
  if (values.budget.trim() && !(Number.isFinite(budget) && budget > 0)) {
    errors.budget = 'Budget must be a positive number of credits';
  }

  if (Object.keys(errors).length > 0) return { errors };
  const agentId = values.agentId || (mode === 'edit' ? null : undefined);
  const oversees = values.oversees.length > 0 ? values.oversees : mode === 'edit' ? null : undefined;
  const budgetCreditsPerDay = values.budget.trim() ? budget : mode === 'edit' ? null : undefined;
  return {
    errors,
    payload: {
      name,
      goal,
      intervalMinutes,
      tools: values.tools,
      stages,
      ...(agentId !== undefined && { agentId }),
      ...(oversees !== undefined && { oversees }),
      ...(budgetCreditsPerDay !== undefined && { budgetCreditsPerDay }),
    },
  };
}

function initialValues(loop?: ILoop): LoopFormValues {
  if (!loop) {
    return {
      name: '',
      goal: '',
      interval: '30',
      intervalUnit: 'minutes',
      tools: [],
      stages: [...DEFAULT_LOOP_STAGES],
      agentId: '',
      oversees: [],
      budget: '',
    };
  }
  const unit: IntervalUnit =
    loop.intervalMinutes % 1440 === 0 ? 'days' : loop.intervalMinutes % 60 === 0 ? 'hours' : 'minutes';
  return {
    name: loop.name,
    goal: loop.goal,
    interval: String(loop.intervalMinutes / UNIT_MINUTES[unit]),
    intervalUnit: unit,
    tools: loop.tools,
    stages: loop.stages,
    agentId: loop.agentId ?? '',
    oversees: loop.oversees ?? [],
    budget: String(loop.budgetCreditsPerDay ?? ''),
  };
}

interface LoopFormModalProps {
  open: boolean;
  onClose: () => void;
  /** Edits this loop when set; creates a draft otherwise. */
  loop?: ILoop;
}

export default function LoopFormModal({ open, onClose, loop }: LoopFormModalProps) {
  const mode = loop ? 'edit' : 'create';
  const [values, setValues] = useState(() => initialValues(loop));
  const [errors, setErrors] = useState<LoopFormErrors>({});
  const [newStage, setNewStage] = useState('');
  const { data: mcpServers = [] } = useMcpServers();
  const { data: agents = [] } = useGetAgents();
  const { data: loops = [], isSuccess: loopsLoaded } = useLoops();
  const otherLoops = loops.filter(other => other.id !== loop?.id);
  // Drop ids of loops deleted since this one was saved; the Select can't show them, and the API rejects them.
  const oversees = loopsLoaded
    ? values.oversees.filter(id => otherLoops.some(other => other.id === id))
    : values.oversees;
  const createLoop = useCreateLoop();
  const updateLoop = useUpdateLoop();
  const saving = createLoop.isPending || updateLoop.isPending;

  const set = <K extends keyof LoopFormValues>(key: K, value: LoopFormValues[K]) =>
    setValues(prev => ({ ...prev, [key]: value }));

  // The executor names MCP tools `<lowercased server>__<tool>` (toolGenerators generateMcpToolsFromCache).
  const mcpTools = mcpServers
    .filter(server => server.enabled)
    .flatMap(server =>
      server.tools.map(tool => ({ value: `${server.name.toLowerCase()}__${tool}`, label: `${server.name}: ${tool}` }))
    );
  const removedStages = loop ? loop.stages.filter(s => !values.stages.includes(s)) : [];

  const addStage = () => {
    const stage = newStage.trim();
    if (!stage) return;
    set('stages', [...values.stages, stage]);
    setNewStage('');
  };

  const submit = () => {
    const { errors: found, payload } = validateLoopForm({ ...values, oversees }, mode);
    setErrors(found);
    if (!payload) return;
    const options = { onSuccess: onClose };
    if (loop) updateLoop.mutate({ id: loop.id, ...payload }, options);
    else createLoop.mutate(payload, options);
  };

  return (
    <Modal open={open} onClose={onClose}>
      <ModalDialog sx={{ width: 560, maxWidth: '95vw', overflowY: 'auto' }} data-testid="loop-form-modal">
        <DialogTitle>{loop ? 'Edit loop' : 'New loop'}</DialogTitle>
        <Stack gap={2}>
          <FormControl error={!!errors.name}>
            <FormLabel>Name</FormLabel>
            <Input
              value={values.name}
              onChange={e => set('name', e.target.value)}
              slotProps={{ input: { 'data-testid': 'loop-form-name-input' } }}
            />
            {errors.name && <FormHelperText>{errors.name}</FormHelperText>}
          </FormControl>
          <FormControl error={!!errors.goal}>
            <FormLabel>Goal</FormLabel>
            <Textarea
              minRows={3}
              maxRows={10}
              value={values.goal}
              onChange={e => set('goal', e.target.value)}
              slotProps={{ textarea: { 'data-testid': 'loop-form-goal-input' } }}
            />
            {errors.goal ? (
              <FormHelperText>{errors.goal}</FormHelperText>
            ) : (
              <FormHelperText>The prompt every run is given.</FormHelperText>
            )}
          </FormControl>
          <FormControl error={!!errors.interval}>
            <FormLabel>Run every</FormLabel>
            <Stack direction="row" gap={1}>
              <Input
                type="number"
                value={values.interval}
                onChange={e => set('interval', e.target.value)}
                sx={{ width: 120 }}
                slotProps={{ input: { min: 1, 'data-testid': 'loop-form-interval-input' } }}
              />
              <Select
                value={values.intervalUnit}
                onChange={(_, unit) => unit && set('intervalUnit', unit)}
                data-testid="loop-form-interval-unit-select"
              >
                <Option value="minutes">minutes</Option>
                <Option value="hours">hours</Option>
                <Option value="days">days</Option>
              </Select>
            </Stack>
            {errors.interval && <FormHelperText>{errors.interval}</FormHelperText>}
          </FormControl>
          <FormControl error={!!errors.tools}>
            <FormLabel>Tools</FormLabel>
            <Select
              multiple
              placeholder="None"
              value={values.tools}
              onChange={(_, tools) => set('tools', tools)}
              slotProps={{ listbox: { sx: { maxHeight: 320, overflow: 'auto' } } }}
              data-testid="loop-form-tools-select"
            >
              {PICKABLE_TOOLS.map(tool => (
                <Option key={tool} value={tool}>
                  {getToolDisplayName(tool)}
                </Option>
              ))}
              {mcpTools.map(tool => (
                <Option key={tool.value} value={tool.value}>
                  {tool.label}
                </Option>
              ))}
            </Select>
            <FormHelperText>
              {errors.tools ?? 'Runs are unattended, so the tools picked here are pre-approved for every run.'}
            </FormHelperText>
          </FormControl>
          <FormControl error={!!errors.stages}>
            <FormLabel>Stages</FormLabel>
            <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 0.5, mb: 1 }}>
              {values.stages.map((stage, i) => (
                <Chip
                  key={`${stage}-${i}`}
                  variant="soft"
                  endDecorator={
                    <ChipDelete
                      onDelete={() =>
                        set(
                          'stages',
                          values.stages.filter((_, j) => j !== i)
                        )
                      }
                      data-testid={`loop-form-stage-remove-${i}`}
                    />
                  }
                >
                  {stage}
                </Chip>
              ))}
            </Box>
            <Stack direction="row" gap={1}>
              <Input
                placeholder="Add a stage"
                value={newStage}
                onChange={e => setNewStage(e.target.value)}
                onKeyDown={e => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    addStage();
                  }
                }}
                sx={{ flex: 1 }}
                slotProps={{ input: { 'data-testid': 'loop-form-stage-input' } }}
              />
              <Button variant="outlined" onClick={addStage} data-testid="loop-form-stage-add-btn">
                Add
              </Button>
            </Stack>
            <FormHelperText>{errors.stages ?? 'The last stage means done.'}</FormHelperText>
            {removedStages.length > 0 && (
              <Typography level="body-xs" color="warning" data-testid="loop-form-stage-removed-warning">
                Tickets in a removed stage show under the first stage.
              </Typography>
            )}
          </FormControl>
          <FormControl>
            <FormLabel>Agent</FormLabel>
            <Select
              value={values.agentId}
              onChange={(_, agentId) => set('agentId', agentId ?? '')}
              data-testid="loop-form-agent-select"
            >
              <Option value="">None</Option>
              {agents.map(agent => (
                <Option key={agent.id} value={agent.id}>
                  {agent.name}
                </Option>
              ))}
            </Select>
          </FormControl>
          <FormControl error={!!errors.oversees}>
            <FormLabel>Oversees</FormLabel>
            <Select
              multiple
              placeholder="None"
              value={oversees}
              onChange={(_, oversees) => set('oversees', oversees)}
              data-testid="loop-form-oversees-select"
            >
              {otherLoops.map(other => (
                <Option key={other.id} value={other.id}>
                  {other.name}
                </Option>
              ))}
            </Select>
            <FormHelperText>
              {errors.oversees ??
                'Runs of this loop can check the loops picked here and send them directives. They never do their work.'}
            </FormHelperText>
          </FormControl>
          <FormControl error={!!errors.budget}>
            <FormLabel>Daily budget (credits)</FormLabel>
            <Input
              type="number"
              placeholder="No budget"
              value={values.budget}
              onChange={e => set('budget', e.target.value)}
              sx={{ width: 160 }}
              slotProps={{ input: { min: 0, 'data-testid': 'loop-form-budget-input' } }}
            />
            <FormHelperText>
              {errors.budget ?? 'Optional. The loop pauses for the rest of the UTC day once it is spent.'}
            </FormHelperText>
          </FormControl>
          <Stack direction="row" gap={1} justifyContent="flex-end">
            <Button variant="plain" color="neutral" onClick={onClose} data-testid="loop-form-cancel-btn">
              Cancel
            </Button>
            <Button onClick={submit} loading={saving} data-testid="loop-form-submit-btn">
              {loop ? 'Save' : 'Create'}
            </Button>
          </Stack>
        </Stack>
      </ModalDialog>
    </Modal>
  );
}
