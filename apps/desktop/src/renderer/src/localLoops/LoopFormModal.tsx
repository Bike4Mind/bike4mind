import { useState } from 'react';
import Alert from '@mui/joy/Alert';
import Button from '@mui/joy/Button';
import Chip from '@mui/joy/Chip';
import ChipDelete from '@mui/joy/ChipDelete';
import DialogActions from '@mui/joy/DialogActions';
import DialogContent from '@mui/joy/DialogContent';
import DialogTitle from '@mui/joy/DialogTitle';
import FormControl from '@mui/joy/FormControl';
import FormHelperText from '@mui/joy/FormHelperText';
import FormLabel from '@mui/joy/FormLabel';
import Input from '@mui/joy/Input';
import Modal from '@mui/joy/Modal';
import ModalDialog from '@mui/joy/ModalDialog';
import Option from '@mui/joy/Option';
import Select from '@mui/joy/Select';
import Stack from '@mui/joy/Stack';
import Switch from '@mui/joy/Switch';
import Textarea from '@mui/joy/Textarea';
import Typography from '@mui/joy/Typography';
import { LOOP_TEMPLATES, type LoopMergePolicy } from '@bike4mind/common';
import {
  validateLoopBudget,
  validateLoopGoal,
  validateLoopMaxConcurrent,
  validateLoopModel,
  validateLoopName,
  validateLoopStages,
} from '@bike4mind/common/loops';
import type { ChatModelOption } from '@shared/chat';
import type { CreateLocalLoopRequest, LocalLoop, LocalLoopStageConfig } from '@shared/localLoops';
import type { LoopApprovalMode } from '@shared/loopRunner';

/** A stage's settings as the form edits them: the smoke check and hold labels as the text typed. */
type StageSettings = Omit<LocalLoopStageConfig, 'stage' | 'smoke' | 'holdLabels'> & {
  smoke?: string;
  holdLabels?: string;
};

interface Values {
  name: string;
  goal: string;
  stages: string[];
  stageConfig: Record<string, StageSettings>;
  model: string;
  escalationModel: string;
  fallbackModel: string;
  maxConcurrent: number;
  budget: string;
  p2RunsPerDay: string;
  approvalMode: LoopApprovalMode;
  mirror: boolean;
  directory: string;
}

type Errors = Partial<Record<'name' | 'goal' | 'stages' | 'model' | 'maxConcurrent' | 'budget' | 'directory', string>>;

const LANES = [1, 2, 3, 4];

function valuesOf(loop?: LocalLoop): Values {
  return {
    name: loop?.name ?? '',
    goal: loop?.goal ?? '',
    stages: loop?.stages ?? ['todo', 'doing', 'done'],
    stageConfig: Object.fromEntries(
      (loop?.stageConfig ?? []).map(({ stage, smoke, holdLabels, ...settings }) => [
        stage,
        {
          ...settings,
          ...(smoke && { smoke: 'url' in smoke ? smoke.url : smoke.command }),
          ...(holdLabels && { holdLabels: holdLabels.join(', ') }),
        },
      ])
    ),
    model: loop?.model ?? '',
    escalationModel: loop?.escalationModel ?? '',
    fallbackModel: loop?.fallbackModel ?? '',
    maxConcurrent: loop?.maxConcurrent ?? 1,
    budget: loop?.budgetCreditsPerDay !== undefined ? String(loop.budgetCreditsPerDay) : '',
    p2RunsPerDay: loop?.p2RunsPerDay !== undefined ? String(loop.p2RunsPerDay) : '',
    approvalMode: loop?.approvalMode ?? 'auto',
    mirror: loop?.mirror ?? true,
    directory: loop?.directory ?? '',
  };
}

/** A template's name, goal and stages; its runner, tools, agents and repo hints are web-loop settings. */
function fromTemplate(values: Values, id: string): Values {
  const template = LOOP_TEMPLATES.find(entry => entry.id === id);
  if (!template) return values;
  return {
    ...values,
    name: template.name,
    goal: template.goal,
    stages: [...template.stages],
    stageConfig: Object.fromEntries(
      template.stageConfig.map(entry => [
        entry.stage,
        {
          ...(entry.instructions && { instructions: entry.instructions }),
          ...(entry.model && { model: entry.model }),
          ...(entry.escalationModel && { escalationModel: entry.escalationModel }),
          ...(entry.mergePolicy && { mergePolicy: entry.mergePolicy }),
          ...(entry.deployWorkflow && { deployWorkflow: entry.deployWorkflow }),
          ...(entry.smoke && { smoke: 'url' in entry.smoke ? entry.smoke.url : entry.smoke.command }),
          ...(entry.holdLabels && { holdLabels: entry.holdLabels.join(', ') }),
        },
      ])
    ),
  };
}

const messageOf = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** Field errors by the same rules main applies (@bike4mind/common/loops), so most refusals show before Save. */
export function validateLoopForm(values: Values): Errors {
  const errors: Errors = {};
  const check = (field: keyof Errors, run: () => unknown) => {
    try {
      run();
    } catch (err) {
      errors[field] = messageOf(err);
    }
  };
  check('name', () => validateLoopName(values.name));
  check('goal', () => validateLoopGoal(values.goal));
  check('stages', () => validateLoopStages(values.stages));
  check('model', () => validateLoopModel(values.model));
  check('maxConcurrent', () => validateLoopMaxConcurrent(values.maxConcurrent));
  if (values.budget.trim()) check('budget', () => validateLoopBudget(Number(values.budget)));
  if (!values.directory) errors.directory = 'Choose the folder this loop works in.';
  return errors;
}

function requestOf(values: Values): CreateLocalLoopRequest {
  const stageConfig = values.stages.slice(0, -1).flatMap(stage => {
    const { smoke, holdLabels, ...settings } = values.stageConfig[stage] ?? {};
    const labels = (holdLabels ?? '')
      .split(',')
      .map(label => label.trim())
      .filter(Boolean);
    const entry: LocalLoopStageConfig = {
      stage,
      ...(settings.instructions?.trim() && { instructions: settings.instructions.trim() }),
      ...(settings.model && { model: settings.model }),
      ...(settings.escalationModel && { escalationModel: settings.escalationModel }),
      ...(settings.mergePolicy && { mergePolicy: settings.mergePolicy }),
      ...(settings.deployWorkflow?.trim() && { deployWorkflow: settings.deployWorkflow.trim() }),
      ...(smoke?.trim() && {
        smoke: /^https?:\/\//i.test(smoke.trim()) ? { url: smoke.trim() } : { command: smoke.trim() },
      }),
      ...(labels.length > 0 && { holdLabels: labels }),
    };
    return Object.keys(entry).length > 1 ? [entry] : [];
  });
  return {
    name: values.name.trim(),
    goal: values.goal.trim(),
    stages: values.stages,
    stageConfig,
    model: values.model,
    ...(values.escalationModel && { escalationModel: values.escalationModel }),
    ...(values.fallbackModel && { fallbackModel: values.fallbackModel }),
    maxConcurrent: values.maxConcurrent,
    ...(values.budget.trim() && { budgetCreditsPerDay: Number(values.budget) }),
    ...(values.p2RunsPerDay.trim() && { p2RunsPerDay: Math.max(0, Math.floor(Number(values.p2RunsPerDay))) }),
    directory: values.directory,
    approvalMode: values.approvalMode,
    mirror: values.mirror,
  };
}

function ModelSelect({
  value,
  onChange,
  models,
  optional,
  testId,
}: {
  value: string;
  onChange: (value: string) => void;
  models: readonly ChatModelOption[];
  optional?: boolean;
  testId: string;
}) {
  // The stored model stays choosable when the catalog no longer lists it (or has not loaded).
  const listed = value && !models.some(model => model.id === value) ? [{ id: value, name: value }, ...models] : models;
  return (
    <Select
      size="sm"
      value={value}
      onChange={(_event, next) => onChange(next ?? '')}
      placeholder={optional ? 'Same as the loop' : 'Choose a model'}
      slotProps={{ button: { 'data-testid': testId } }}
    >
      {optional && <Option value="">None</Option>}
      {listed.map(model => (
        <Option key={model.id} value={model.id}>
          {model.name}
        </Option>
      ))}
    </Select>
  );
}

/**
 * Create or edit a Desktop loop. The web form's fields, minus Slack and the per-stage runner, repo, tools, agent
 * and skills (every stage runs on this Mac), plus lanes, a fallback model and the mirror switch. The folder comes
 * only from the native picker (localLoops.pickFolder); main refuses any other path.
 */
export function LoopFormModal({
  loop,
  models,
  onClose,
  onSaved,
}: {
  loop?: LocalLoop;
  models: readonly ChatModelOption[];
  onClose: () => void;
  onSaved: (loopId: string) => void;
}) {
  const [values, setValues] = useState(() => valuesOf(loop));
  const [errors, setErrors] = useState<Errors>({});
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [newStage, setNewStage] = useState('');
  const set = <K extends keyof Values>(key: K, value: Values[K]) =>
    setValues(current => ({ ...current, [key]: value }));
  const setStage = (stage: string, patch: Partial<StageSettings>) =>
    setValues(current => ({
      ...current,
      stageConfig: { ...current.stageConfig, [stage]: { ...current.stageConfig[stage], ...patch } },
    }));
  const api = window.b4m.localLoops;

  const addStage = () => {
    const stage = newStage.trim();
    if (!stage || values.stages.includes(stage)) return;
    // New stages go before the last one, which means done.
    set('stages', [...values.stages.slice(0, -1), stage, ...values.stages.slice(-1)]);
    setNewStage('');
  };

  const pickFolder = async () => {
    setError(null);
    const result = await api.pickFolder();
    if (!result.ok) setError(result.error);
    else if (result.value) set('directory', result.value.directory);
  };

  const save = async () => {
    const found = validateLoopForm(values);
    setErrors(found);
    if (Object.keys(found).length > 0) return;
    setSaving(true);
    setError(null);
    const request = requestOf(values);
    const result = loop
      ? await api.updateLoop({
          id: loop.id,
          ...request,
          // A blank optional field on edit clears it; left out, main would keep the old value.
          escalationModel: request.escalationModel ?? null,
          fallbackModel: request.fallbackModel ?? null,
          budgetCreditsPerDay: request.budgetCreditsPerDay ?? null,
          p2RunsPerDay: request.p2RunsPerDay ?? null,
        })
      : await api.createLoop(request);
    setSaving(false);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    onSaved(result.value.loop.id);
  };

  return (
    <Modal open onClose={onClose}>
      <ModalDialog sx={{ width: 640, maxWidth: '95vw' }} data-testid="local-loops-form">
        <DialogTitle>{loop ? 'Edit loop' : 'New loop'}</DialogTitle>
        <DialogContent sx={{ overflowY: 'auto' }}>
          <Stack spacing={2}>
            {!loop && (
              <FormControl>
                <FormLabel>From template</FormLabel>
                <Select
                  size="sm"
                  placeholder="Start blank"
                  onChange={(_event, id) => typeof id === 'string' && setValues(current => fromTemplate(current, id))}
                  slotProps={{ button: { 'data-testid': 'local-loops-form-template' } }}
                >
                  {LOOP_TEMPLATES.map(template => (
                    <Option key={template.id} value={template.id}>
                      {template.name}
                    </Option>
                  ))}
                </Select>
              </FormControl>
            )}
            <FormControl error={!!errors.name}>
              <FormLabel>Name</FormLabel>
              <Input
                size="sm"
                value={values.name}
                onChange={event => set('name', event.target.value)}
                slotProps={{ input: { 'data-testid': 'local-loops-form-name' } }}
              />
              {errors.name && <FormHelperText>{errors.name}</FormHelperText>}
            </FormControl>
            <FormControl error={!!errors.goal}>
              <FormLabel>Goal</FormLabel>
              <Textarea
                size="sm"
                minRows={2}
                value={values.goal}
                onChange={event => set('goal', event.target.value)}
                slotProps={{ textarea: { 'data-testid': 'local-loops-form-goal' } }}
              />
              {errors.goal && <FormHelperText>{errors.goal}</FormHelperText>}
            </FormControl>
            <FormControl error={!!errors.directory}>
              <FormLabel>Folder</FormLabel>
              <Stack direction="row" spacing={1} alignItems="center">
                <Typography
                  level="body-sm"
                  sx={{ flex: 1, wordBreak: 'break-all' }}
                  data-testid="local-loops-form-folder"
                >
                  {values.directory || 'No folder chosen'}
                </Typography>
                <Button
                  size="sm"
                  variant="outlined"
                  onClick={() => void pickFolder()}
                  data-testid="local-loops-form-folder-btn"
                >
                  Choose folder
                </Button>
              </Stack>
              <FormHelperText>
                {errors.directory ?? 'A local git checkout; each run works in its own worktree.'}
              </FormHelperText>
            </FormControl>
            <FormControl error={!!errors.stages}>
              <FormLabel>Stages</FormLabel>
              <Stack direction="row" flexWrap="wrap" gap={0.5} sx={{ mb: 1 }}>
                {values.stages.map((stage, i) => (
                  <Chip
                    key={stage}
                    variant="soft"
                    endDecorator={
                      <ChipDelete
                        onDelete={() =>
                          set(
                            'stages',
                            values.stages.filter((_, j) => j !== i)
                          )
                        }
                        data-testid={`local-loops-form-stage-remove-${i}`}
                      />
                    }
                  >
                    {stage}
                  </Chip>
                ))}
              </Stack>
              <Stack direction="row" gap={1}>
                <Input
                  size="sm"
                  placeholder="Add a stage"
                  value={newStage}
                  onChange={event => setNewStage(event.target.value)}
                  onKeyDown={event => {
                    if (event.key === 'Enter') {
                      event.preventDefault();
                      addStage();
                    }
                  }}
                  sx={{ flex: 1 }}
                  slotProps={{ input: { 'data-testid': 'local-loops-form-stage-input' } }}
                />
                <Button size="sm" variant="outlined" onClick={addStage}>
                  Add
                </Button>
              </Stack>
              <FormHelperText>{errors.stages ?? 'The last stage means done.'}</FormHelperText>
            </FormControl>
            {values.stages.slice(0, -1).map((stage, i) => {
              const settings = values.stageConfig[stage] ?? {};
              return (
                <Stack key={stage} spacing={1} data-testid={`local-loops-form-stage-panel-${i}`}>
                  <Typography level="title-sm">Stage: {stage}</Typography>
                  <Stack direction="row" spacing={1}>
                    <FormControl sx={{ flex: 1 }}>
                      <FormLabel>Model</FormLabel>
                      <ModelSelect
                        optional
                        value={settings.model ?? ''}
                        onChange={model => setStage(stage, { model: model || undefined })}
                        models={models}
                        testId={`local-loops-form-stage-model-${i}`}
                      />
                    </FormControl>
                    <FormControl sx={{ flex: 1 }}>
                      <FormLabel>Escalation model</FormLabel>
                      <ModelSelect
                        optional
                        value={settings.escalationModel ?? ''}
                        onChange={model => setStage(stage, { escalationModel: model || undefined })}
                        models={models}
                        testId={`local-loops-form-stage-escalation-${i}`}
                      />
                    </FormControl>
                  </Stack>
                  <FormControl>
                    <FormLabel>Instructions</FormLabel>
                    <Textarea
                      size="sm"
                      minRows={2}
                      value={settings.instructions ?? ''}
                      onChange={event => setStage(stage, { instructions: event.target.value })}
                    />
                  </FormControl>
                  <Stack direction="row" spacing={1}>
                    <FormControl sx={{ flex: 1 }}>
                      <FormLabel>Merge policy</FormLabel>
                      <Select
                        size="sm"
                        value={settings.mergePolicy ?? 'review'}
                        onChange={(_event, policy) =>
                          setStage(stage, { mergePolicy: (policy ?? undefined) as LoopMergePolicy | undefined })
                        }
                      >
                        <Option value="review">Review</Option>
                        <Option value="green-ci">Green CI</Option>
                        <Option value="never">Never</Option>
                      </Select>
                    </FormControl>
                    <FormControl sx={{ flex: 1 }}>
                      <FormLabel>Deploy workflow</FormLabel>
                      <Input
                        size="sm"
                        value={settings.deployWorkflow ?? ''}
                        onChange={event => setStage(stage, { deployWorkflow: event.target.value })}
                      />
                    </FormControl>
                  </Stack>
                  <Stack direction="row" spacing={1}>
                    <FormControl sx={{ flex: 1 }}>
                      <FormLabel>Smoke check</FormLabel>
                      <Input
                        size="sm"
                        placeholder="URL or command"
                        value={settings.smoke ?? ''}
                        onChange={event => setStage(stage, { smoke: event.target.value })}
                      />
                    </FormControl>
                    <FormControl sx={{ flex: 1 }}>
                      <FormLabel>Hold labels</FormLabel>
                      <Input
                        size="sm"
                        placeholder="Comma separated"
                        value={settings.holdLabels ?? ''}
                        onChange={event => setStage(stage, { holdLabels: event.target.value })}
                      />
                    </FormControl>
                  </Stack>
                </Stack>
              );
            })}
            <Stack direction="row" spacing={1}>
              <FormControl sx={{ flex: 1 }} error={!!errors.model}>
                <FormLabel>Model</FormLabel>
                <ModelSelect
                  value={values.model}
                  onChange={model => set('model', model)}
                  models={models}
                  testId="local-loops-form-model"
                />
                {errors.model && <FormHelperText>{errors.model}</FormHelperText>}
              </FormControl>
              <FormControl sx={{ flex: 1 }}>
                <FormLabel>Escalation model</FormLabel>
                <ModelSelect
                  optional
                  value={values.escalationModel}
                  onChange={model => set('escalationModel', model)}
                  models={models}
                  testId="local-loops-form-escalation"
                />
              </FormControl>
              <FormControl sx={{ flex: 1 }}>
                <FormLabel>Fallback model</FormLabel>
                <ModelSelect
                  optional
                  value={values.fallbackModel}
                  onChange={model => set('fallbackModel', model)}
                  models={models}
                  testId="local-loops-form-fallback"
                />
                <FormHelperText>Taken while the budget runs ahead of the day.</FormHelperText>
              </FormControl>
            </Stack>
            <Stack direction="row" spacing={1}>
              <FormControl sx={{ flex: 1 }} error={!!errors.maxConcurrent}>
                <FormLabel>Lanes</FormLabel>
                <Select
                  size="sm"
                  value={values.maxConcurrent}
                  onChange={(_event, lanes) => lanes && set('maxConcurrent', lanes)}
                  slotProps={{ button: { 'data-testid': 'local-loops-form-lanes' } }}
                >
                  {LANES.map(lanes => (
                    <Option key={lanes} value={lanes}>
                      {lanes} at a time
                    </Option>
                  ))}
                </Select>
                {errors.maxConcurrent && <FormHelperText>{errors.maxConcurrent}</FormHelperText>}
              </FormControl>
              <FormControl sx={{ flex: 1 }} error={!!errors.budget}>
                <FormLabel>Daily budget (credits)</FormLabel>
                <Input
                  size="sm"
                  type="number"
                  value={values.budget}
                  onChange={event => set('budget', event.target.value)}
                  slotProps={{ input: { 'data-testid': 'local-loops-form-budget' } }}
                />
                {errors.budget && <FormHelperText>{errors.budget}</FormHelperText>}
              </FormControl>
              <FormControl sx={{ flex: 1 }}>
                <FormLabel>p2 runs per day</FormLabel>
                <Input
                  size="sm"
                  type="number"
                  value={values.p2RunsPerDay}
                  onChange={event => set('p2RunsPerDay', event.target.value)}
                />
              </FormControl>
            </Stack>
            <FormControl>
              <FormLabel>Approvals</FormLabel>
              <Select
                size="sm"
                value={values.approvalMode}
                onChange={(_event, mode) => mode && set('approvalMode', mode)}
              >
                <Option value="auto">Auto: safe actions run, the rest wait for you</Option>
                <Option value="full">Full: every action runs</Option>
              </Select>
            </FormControl>
            <Switch
              size="sm"
              checked={values.mirror}
              onChange={event => set('mirror', event.target.checked)}
              endDecorator="Show this loop's status on the web and phone"
              sx={{ alignSelf: 'flex-start' }}
              slotProps={{ input: { 'data-testid': 'local-loops-form-mirror' } }}
            />
            {error && (
              <Alert color="danger" role="alert" data-testid="local-loops-form-error">
                {error}
              </Alert>
            )}
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button
            onClick={() => void save()}
            loading={saving}
            disabled={!values.directory}
            data-testid="local-loops-form-save-btn"
          >
            {loop ? 'Save' : 'Create'}
          </Button>
          <Button variant="plain" color="neutral" onClick={onClose}>
            Cancel
          </Button>
        </DialogActions>
      </ModalDialog>
    </Modal>
  );
}
