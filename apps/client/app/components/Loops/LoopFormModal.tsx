import { useState } from 'react';
import {
  Accordion,
  AccordionDetails,
  AccordionSummary,
  Box,
  Button,
  Chip,
  ChipDelete,
  DialogTitle,
  FormControl,
  FormHelperText,
  FormLabel,
  Input,
  List,
  ListItem,
  ListSubheader,
  Modal,
  ModalDialog,
  Option,
  Radio,
  RadioGroup,
  Select,
  Stack,
  Textarea,
  Typography,
} from '@mui/joy';
import {
  DEFAULT_LOOP_STAGES,
  LOOP_MAX_CONCURRENT,
  LOOP_P2_RUNS_PER_DAY_MAX,
  LOOP_SERVICE_LEVEL_HOURS,
  LOOP_SERVICE_LEVEL_HOURS_MAX,
  LOOP_TRIGGERS_MAX,
  type ILoop,
  type ILoopsBudget,
  type ILoopStageConfig,
  type ILoopTemplate,
  type LoopMergePolicy,
} from '@bike4mind/common';
import { PICKABLE_TOOLS } from '@client/app/components/Agent/OrchestrationSection';
import { getToolDisplayName } from '@client/app/utils/toolMapping';
import { useMcpServers } from '@client/app/hooks/data/mcpServers';
import { useGetAgents } from '@client/app/hooks/data/agents';
import { useGetSkills } from '@client/app/hooks/data/skills';
import { useAccessibleModels } from '@client/app/hooks/useAccessibleModels';
import { useConfig } from '@client/app/hooks/data/settings';
import { unavailableTools, unavailableToolsMessage } from '@client/app/components/Loops/loopUi';
import {
  useCreateLoop,
  useLoops,
  useLoopsBudget,
  useUpdateLoop,
  type LoopFormPayload,
} from '@client/app/hooks/data/loops';

// Limits mirror apps/client/server/utils/loopValidation.ts; keep in sync.
const NAME_MAX = 120;
const GOAL_MAX = 8000;
const TOOLS_MAX = 50;
const STAGES_MAX = 20;
const STAGE_NAME_MAX = 60;
const OVERSEES_MAX = 5;
const HANDOFF_TARGETS_MAX = 10;
const STAGE_INSTRUCTIONS_MAX = 4000;
const STAGE_SKILLS_MAX = 10;
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
  /** Cloud runs at once, as typed. */
  maxConcurrent: string;
  /** Keyed by stage name, so removing a stage (or it becoming the last) drops its config from the payload. */
  stageConfig: Record<string, StageSettings>;
  /** '' means the default service level (LOOP_SERVICE_LEVEL_HOURS). */
  slaP0: string;
  slaP1: string;
  /** '' means no p2 cap. */
  p2Cap: string;
  /** '' means the loop's model. */
  triageModel: string;
  /** '' means no escalation. */
  escalationModel: string;
  /** Ids of the owner's other loops this one's runs may hand tickets to. */
  handoffTargets: string[];
  /** '' in a field means not picked yet; `toStage` '' means this loop's first stage. */
  triggers: { fromLoopId: string; stage: string; toStage: string }[];
  wakeMode: 'interval' | 'tickets';
}

/** A stage's settings as the form edits them: the smoke check and hold labels as the text typed. */
type StageSettings = Omit<ILoopStageConfig, 'stage' | 'smoke' | 'holdLabels'> & { smoke?: string; holdLabels?: string };

/** A desktop stage's guards from the form; a smoke check starting with http(s):// is a URL, else a command. */
function desktopGuards(settings: StageSettings): Partial<ILoopStageConfig> {
  const repoHint = settings.repoHint?.trim();
  const deployWorkflow = settings.deployWorkflow?.trim();
  const smoke = settings.smoke?.trim();
  const holdLabels = (settings.holdLabels ?? '')
    .split(',')
    .map(label => label.trim())
    .filter(Boolean);
  return {
    ...(repoHint && { repoHint }),
    ...(settings.mergePolicy && { mergePolicy: settings.mergePolicy }),
    ...(deployWorkflow && { deployWorkflow }),
    ...(smoke && { smoke: /^https?:\/\//i.test(smoke) ? { url: smoke } : { command: smoke } }),
    ...(holdLabels.length > 0 && { holdLabels }),
  };
}

export type LoopFormErrors = Partial<
  Record<
    | 'name'
    | 'goal'
    | 'interval'
    | 'maxConcurrent'
    | 'tools'
    | 'stages'
    | 'oversees'
    | 'budget'
    | 'stageConfig'
    | 'sla'
    | 'p2Cap'
    | 'handoffTargets'
    | 'triggers',
    string
  >
>;

/**
 * The hint under Runs at once: cloud only, and the lower of the admin lane limits when the value is above one
 * (`loopLaneLimits`, apps/client/server/utils/loopBudget.ts).
 */
export function maxConcurrentHint(value: number, limits?: ILoopsBudget['laneLimits']): string {
  const parts = ["Cloud runs at once; Desktop runs use your machine's own lanes."];
  if (limits && value > limits.lanesPerUser) {
    parts.push(
      `Up to ${limits.lanesPerUser} run at once: your limit is ${limits.lanesPerUser} cloud runs across all loops.`
    );
  }
  if (limits && value > limits.maxActiveRuns) parts.push(`(server-wide limit: ${limits.maxActiveRuns})`);
  return parts.join(' ');
}

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

  // Mirrors validateLoopMaxConcurrent (apps/client/server/utils/loopValidation.ts).
  const maxConcurrent = Number(values.maxConcurrent);
  if (!Number.isInteger(maxConcurrent) || maxConcurrent < 1 || maxConcurrent > LOOP_MAX_CONCURRENT) {
    errors.maxConcurrent = `Runs at once must be a whole number from 1 to ${LOOP_MAX_CONCURRENT}`;
  }

  if (values.tools.length > TOOLS_MAX) errors.tools = `Pick ${TOOLS_MAX} tools or fewer`;
  if (values.oversees.length > OVERSEES_MAX) errors.oversees = `Pick ${OVERSEES_MAX} loops or fewer`;
  if (values.handoffTargets.length > HANDOFF_TARGETS_MAX) {
    errors.handoffTargets = `Pick ${HANDOFF_TARGETS_MAX} loops or fewer`;
  }
  // Mirrors validateLoopTriggers (apps/client/server/utils/loopValidation.ts).
  if (values.triggers.length > LOOP_TRIGGERS_MAX) errors.triggers = `Add ${LOOP_TRIGGERS_MAX} triggers or fewer`;
  else if (values.triggers.some(trigger => !trigger.fromLoopId || !trigger.stage)) {
    errors.triggers = 'Pick a loop and a stage for each trigger';
  } else if (new Set(values.triggers.map(t => `${t.fromLoopId}/${t.stage}`)).size !== values.triggers.length) {
    errors.triggers = 'Each loop and stage can have one trigger';
  }

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

  // Mirrors validateLoopPriorityPolicy (apps/client/server/utils/loopValidation.ts).
  const sla = { p0: values.slaP0.trim(), p1: values.slaP1.trim() };
  const serviceLevelHours = Object.fromEntries(
    Object.entries(sla)
      .filter(([, value]) => value)
      .map(([key, value]) => [key, Number(value)])
  ) as NonNullable<ILoop['serviceLevelHours']>;
  if (Object.values(serviceLevelHours).some(hours => !(hours > 0 && hours <= LOOP_SERVICE_LEVEL_HOURS_MAX))) {
    errors.sla = `Hours must be above 0 and up to ${LOOP_SERVICE_LEVEL_HOURS_MAX}`;
  }
  const p2Cap = Number(values.p2Cap);
  if (values.p2Cap.trim() && !(Number.isInteger(p2Cap) && p2Cap >= 0 && p2Cap <= LOOP_P2_RUNS_PER_DAY_MAX)) {
    errors.p2Cap = `Must be a whole number from 0 to ${LOOP_P2_RUNS_PER_DAY_MAX}`;
  }

  // Mirrors validateLoopStageConfig (apps/client/server/utils/loopValidation.ts): blank fields are unset,
  // and the last stage has no settings.
  const stageConfig: ILoopStageConfig[] = [];
  for (const stage of stages.slice(0, -1)) {
    const settings = values.stageConfig[stage] ?? {};
    const instructions = settings.instructions?.trim();
    const entry: ILoopStageConfig = {
      stage,
      ...(instructions && { instructions }),
      ...(settings.model && { model: settings.model }),
      ...(settings.escalationModel && { escalationModel: settings.escalationModel }),
      ...(settings.tools?.length && { tools: settings.tools }),
      ...(settings.agentId && settings.runner !== 'desktop' && { agentId: settings.agentId }),
      ...(settings.skills?.length && { skills: settings.skills }),
      ...(settings.runner && { runner: settings.runner }),
      ...(settings.runner === 'desktop' && desktopGuards(settings)),
    };
    if (Object.keys(entry).length === 1) continue;
    if ((instructions?.length ?? 0) > STAGE_INSTRUCTIONS_MAX) {
      errors.stageConfig ??= `${stage}: instructions must be ${STAGE_INSTRUCTIONS_MAX} characters or fewer`;
    } else if ((settings.tools?.length ?? 0) > TOOLS_MAX) {
      errors.stageConfig ??= `${stage}: pick ${TOOLS_MAX} tools or fewer`;
    } else if ((settings.skills?.length ?? 0) > STAGE_SKILLS_MAX) {
      errors.stageConfig ??= `${stage}: pick ${STAGE_SKILLS_MAX} skills or fewer`;
    }
    stageConfig.push(entry);
  }

  if (Object.keys(errors).length > 0) return { errors };
  const agentId = values.agentId || (mode === 'edit' ? null : undefined);
  const oversees = values.oversees.length > 0 ? values.oversees : mode === 'edit' ? null : undefined;
  const budgetCreditsPerDay = values.budget.trim() ? budget : mode === 'edit' ? null : undefined;
  const stageConfigPayload = stageConfig.length > 0 ? stageConfig : mode === 'edit' ? null : undefined;
  // 1 is the default, stored as absent.
  const maxConcurrentPayload = maxConcurrent > 1 ? maxConcurrent : mode === 'edit' ? null : undefined;
  // Blank clears a setting on edit and leaves it out on create.
  const orClear = <T,>(value: T | undefined) => (value !== undefined ? value : mode === 'edit' ? null : undefined);
  const policy = {
    serviceLevelHours: orClear(Object.keys(serviceLevelHours).length > 0 ? serviceLevelHours : undefined),
    p2RunsPerDay: orClear(values.p2Cap.trim() ? p2Cap : undefined),
    triageModel: orClear(values.triageModel || undefined),
    escalationModel: orClear(values.escalationModel || undefined),
    handoffTargets: orClear(values.handoffTargets.length > 0 ? values.handoffTargets : undefined),
    triggers: orClear(
      values.triggers.length > 0
        ? values.triggers.map(({ fromLoopId, stage, toStage }) => ({
            fromLoopId,
            stage,
            ...(toStage && stages.slice(0, -1).includes(toStage) && { toStage }),
          }))
        : undefined
    ),
    wakeMode: orClear(values.wakeMode === 'tickets' ? ('tickets' as const) : undefined),
  };
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
      ...(maxConcurrentPayload !== undefined && { maxConcurrent: maxConcurrentPayload }),
      ...(stageConfigPayload !== undefined && { stageConfig: stageConfigPayload }),
      ...Object.fromEntries(Object.entries(policy).filter(([, value]) => value !== undefined)),
    },
  };
}

/** Form values for a saved loop or a template (`ILoopTemplate` is shaped like the loop fields read here). */
export function initialValues(
  loop?: Pick<ILoop, 'name' | 'goal' | 'intervalMinutes' | 'tools' | 'stages'> & Partial<ILoop>
): LoopFormValues {
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
      maxConcurrent: '1',
      stageConfig: {},
      slaP0: '',
      slaP1: '',
      p2Cap: '',
      triageModel: '',
      escalationModel: '',
      handoffTargets: [],
      triggers: [],
      wakeMode: 'interval',
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
    maxConcurrent: String(loop.maxConcurrent ?? 1),
    slaP0: String(loop.serviceLevelHours?.p0 ?? ''),
    slaP1: String(loop.serviceLevelHours?.p1 ?? ''),
    p2Cap: String(loop.p2RunsPerDay ?? ''),
    triageModel: loop.triageModel ?? '',
    escalationModel: loop.escalationModel ?? '',
    handoffTargets: loop.handoffTargets ?? [],
    triggers: (loop.triggers ?? []).map(({ fromLoopId, stage, toStage }) => ({
      fromLoopId,
      stage,
      toStage: toStage ?? '',
    })),
    wakeMode: loop.wakeMode ?? 'interval',
    stageConfig: Object.fromEntries(
      (loop.stageConfig ?? []).map(({ stage, smoke, holdLabels, ...settings }) => [
        stage,
        {
          ...settings,
          ...(smoke && { smoke: 'url' in smoke ? smoke.url : smoke.command }),
          ...(holdLabels?.length && { holdLabels: holdLabels.join(', ') }),
        },
      ])
    ),
  };
}

interface LoopFormModalProps {
  open: boolean;
  onClose: () => void;
  /** Edits this loop when set; creates a draft otherwise. */
  loop?: ILoop;
  /** Prefills a new loop; ignored when `loop` is set. */
  template?: ILoopTemplate;
}

export default function LoopFormModal({ open, onClose, loop, template }: LoopFormModalProps) {
  const mode = loop ? 'edit' : 'create';
  const [values, setValues] = useState(() => initialValues(loop ?? template));
  const [errors, setErrors] = useState<LoopFormErrors>({});
  const [newStage, setNewStage] = useState('');
  const { data: mcpServers = [] } = useMcpServers();
  const { data: agents = [] } = useGetAgents();
  const { data: skills = [] } = useGetSkills();
  const { accessibleTextModels } = useAccessibleModels();
  const { data: loops = [], isSuccess: loopsLoaded } = useLoops();
  const toolAvailability = useConfig().data?.toolAvailability;
  const laneLimits = useLoopsBudget().data?.laneLimits;
  // A saved tool stays listed even when unavailable, so the Select can still render it and the owner can remove it.
  const missingTools = unavailableTools(PICKABLE_TOOLS, toolAvailability);
  const pickedMissing = missingTools.filter(tool => values.tools.includes(tool)).map(tool => getToolDisplayName(tool));
  const otherLoops = loops.filter(other => other.id !== loop?.id);
  // Drop ids of loops deleted since this one was saved; the Select can't show them, and the API rejects them.
  const stillOwned = (id: string) => !loopsLoaded || otherLoops.some(other => other.id === id);
  const oversees = values.oversees.filter(stillOwned);
  const handoffTargets = values.handoffTargets.filter(stillOwned);
  const triggers = values.triggers.filter(trigger => !trigger.fromLoopId || stillOwned(trigger.fromLoopId));
  const setTrigger = (index: number, patch: Partial<LoopFormValues['triggers'][number]>) =>
    set(
      'triggers',
      triggers.map((trigger, i) => (i === index ? { ...trigger, ...patch } : trigger))
    );
  const createLoop = useCreateLoop();
  const updateLoop = useUpdateLoop();
  const saving = createLoop.isPending || updateLoop.isPending;

  const set = <K extends keyof LoopFormValues>(key: K, value: LoopFormValues[K]) =>
    setValues(prev => ({ ...prev, [key]: value }));
  const setStage = (stage: string, patch: StageSettings) =>
    setValues(prev => ({
      ...prev,
      stageConfig: { ...prev.stageConfig, [stage]: { ...prev.stageConfig[stage], ...patch } },
    }));

  // The executor names MCP tools `<lowercased server>__<tool>` (toolGenerators generateMcpToolsFromCache).
  const mcpGroups = mcpServers
    .filter(server => server.enabled)
    .map(server => ({
      name: server.name,
      prefix: server.name.toLowerCase(),
      tools: server.tools.map(tool => ({
        value: `${server.name.toLowerCase()}__${tool}`,
        label: `${server.name}: ${tool}`,
      })),
    }));
  // Shared by the loop and per-stage tools pickers so both always offer the same list. "All" adds the server's
  // tools as they are now, by name: a tool the server gains later stays off until picked (see newToolsHint).
  const toolOptions = (selected: string[], onChange: (tools: string[]) => void) => [
    ...PICKABLE_TOOLS.filter(tool => !missingTools.includes(tool) || selected.includes(tool)).map(tool => (
      <Option key={tool} value={tool}>
        {getToolDisplayName(tool)}
        {missingTools.includes(tool) && ' (unavailable)'}
      </Option>
    )),
    ...mcpGroups.flatMap(server => [
      <ListSubheader key={`server-${server.prefix}`} sx={{ justifyContent: 'space-between' }}>
        {server.name}
        <Button
          size="sm"
          variant="plain"
          // Keeps the listbox open.
          onMouseDown={e => e.preventDefault()}
          onClick={() => onChange([...new Set([...selected, ...server.tools.map(tool => tool.value)])])}
          data-testid={`loop-form-tools-server-all-${server.prefix}`}
        >
          All
        </Button>
      </ListSubheader>,
      ...server.tools.map(tool => (
        <Option key={tool.value} value={tool.value}>
          {tool.label}
        </Option>
      )),
    ]),
  ];
  // Servers with some tools picked and some not: usually tools added since the pick.
  const newToolsHint = (selected: string[]) => {
    const notes = mcpGroups.flatMap(server => {
      const unpicked = server.tools.filter(tool => !selected.includes(tool.value)).length;
      const picked = server.tools.length - unpicked;
      return picked > 0 && unpicked > 0
        ? [`${unpicked} new tool${unpicked === 1 ? '' : 's'} on ${server.name}; not used until you pick them`]
        : [];
    });
    return notes.length > 0 ? (
      <FormHelperText data-testid="loop-form-tools-new-hint">{notes.join('. ')}</FormHelperText>
    ) : null;
  };
  // Shared by every model picker. A saved model the picker no longer lists stays selectable, so an edit never drops it.
  const modelOptions = (selected: string | undefined, emptyLabel: string) => [
    <Option key="" value="">
      {emptyLabel}
    </Option>,
    ...(selected && !accessibleTextModels.some(model => model.id === selected)
      ? [
          <Option key={selected} value={selected}>
            {selected}
          </Option>,
        ]
      : []),
    ...accessibleTextModels.map(model => (
      <Option key={model.id} value={model.id}>
        {model.name}
      </Option>
    )),
  ];
  const removedStages = loop ? loop.stages.filter(s => !values.stages.includes(s)) : [];

  const addStage = () => {
    const stage = newStage.trim();
    if (!stage) return;
    set('stages', [...values.stages, stage]);
    setNewStage('');
  };

  const submit = () => {
    const { errors: found, payload } = validateLoopForm({ ...values, oversees, handoffTargets, triggers }, mode);
    setErrors(found);
    if (!payload) return;
    const options = { onSuccess: onClose };
    if (loop) updateLoop.mutate({ id: loop.id, ...payload }, options);
    else createLoop.mutate(payload, options);
  };

  return (
    <Modal open={open} onClose={onClose}>
      <ModalDialog sx={{ width: 560, maxWidth: '95vw', overflowY: 'auto' }} data-testid="loop-form-modal">
        <DialogTitle>{loop ? 'Edit loop' : template ? 'New loop from template' : 'New loop'}</DialogTitle>
        <Stack gap={2}>
          {!loop && template && (
            <Box data-testid="loop-form-setup-notes">
              <Typography level="title-sm">Before you set it live</Typography>
              <List marker="disc" size="sm">
                {template.setupNotes.map(note => (
                  <ListItem key={note}>{note}</ListItem>
                ))}
              </List>
            </Box>
          )}
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
          <FormControl error={!!errors.maxConcurrent}>
            <FormLabel>Runs at once</FormLabel>
            <Input
              type="number"
              value={values.maxConcurrent}
              onChange={e => set('maxConcurrent', e.target.value)}
              sx={{ width: 120 }}
              slotProps={{ input: { min: 1, max: LOOP_MAX_CONCURRENT, 'data-testid': 'loop-form-max-concurrent' } }}
            />
            <FormHelperText data-testid="loop-form-max-concurrent-hint">
              {errors.maxConcurrent ?? maxConcurrentHint(Number(values.maxConcurrent), laneLimits)}
            </FormHelperText>
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
              {toolOptions(values.tools, tools => set('tools', tools))}
            </Select>
            {newToolsHint(values.tools)}
            {errors.tools || pickedMissing.length === 0 ? (
              <FormHelperText>
                {errors.tools ?? 'Runs are unattended, so the tools picked here are pre-approved for every run.'}
              </FormHelperText>
            ) : (
              <FormHelperText sx={{ color: 'warning.plainColor' }} data-testid="loop-form-tools-unavailable-warning">
                {unavailableToolsMessage(pickedMissing)}
              </FormHelperText>
            )}
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
                      onDelete={() => {
                        set(
                          'stages',
                          values.stages.filter((_, j) => j !== i)
                        );
                        // So re-adding a stage of the same name starts from defaults.
                        const { [stage]: _removed, ...rest } = values.stageConfig;
                        set('stageConfig', rest);
                      }}
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
          <Accordion data-testid="loop-form-stage-settings">
            <AccordionSummary slotProps={{ button: { 'data-testid': 'loop-form-stage-settings-toggle' } }}>
              Stage settings
            </AccordionSummary>
            <AccordionDetails>
              <Stack gap={2}>
                {values.stages.slice(0, -1).map((stage, i) => {
                  const settings = values.stageConfig[stage] ?? {};
                  return (
                    <Stack key={`${stage}-${i}`} gap={1} data-testid={`loop-form-stage-panel-${i}`}>
                      <Stack direction="row" gap={1} alignItems="center">
                        <Typography level="title-sm">{stage}</Typography>
                        {settings.runner === 'desktop' && (
                          <Chip size="sm" variant="soft">
                            desktop
                          </Chip>
                        )}
                      </Stack>
                      <FormControl>
                        <FormLabel>Runner</FormLabel>
                        <Select
                          value={settings.runner ?? 'cloud'}
                          onChange={(_, runner) =>
                            setStage(stage, { runner: runner === 'desktop' ? 'desktop' : undefined })
                          }
                          data-testid={`loop-form-stage-runner-${i}`}
                        >
                          <Option value="cloud">Cloud</Option>
                          <Option value="desktop">Desktop</Option>
                        </Select>
                        {settings.runner === 'desktop' && (
                          <FormHelperText>
                            Tickets in this stage wait for your Desktop app to pick them up.
                          </FormHelperText>
                        )}
                      </FormControl>
                      {settings.runner === 'desktop' && (
                        <>
                          <FormControl>
                            <FormLabel>Repo</FormLabel>
                            <Input
                              placeholder="owner/name"
                              value={settings.repoHint ?? ''}
                              onChange={e => setStage(stage, { repoHint: e.target.value })}
                              slotProps={{ input: { 'data-testid': `loop-form-stage-repo-${i}` } }}
                            />
                          </FormControl>
                          <FormControl>
                            <FormLabel>Merge policy</FormLabel>
                            <Select
                              value={settings.mergePolicy ?? 'review'}
                              onChange={(_, mergePolicy) =>
                                setStage(stage, { mergePolicy: (mergePolicy as LoopMergePolicy | null) ?? undefined })
                              }
                              data-testid={`loop-form-stage-merge-${i}`}
                            >
                              <Option value="review">Review required</Option>
                              <Option value="green-ci">Green CI</Option>
                              <Option value="never">Never merge</Option>
                            </Select>
                          </FormControl>
                          <FormControl>
                            <FormLabel>Deploy workflow</FormLabel>
                            <Input
                              placeholder="deploy.yml"
                              value={settings.deployWorkflow ?? ''}
                              onChange={e => setStage(stage, { deployWorkflow: e.target.value })}
                              slotProps={{ input: { 'data-testid': `loop-form-stage-deploy-${i}` } }}
                            />
                          </FormControl>
                          <FormControl>
                            <FormLabel>Smoke check</FormLabel>
                            <Input
                              placeholder="https://... or a command"
                              value={settings.smoke ?? ''}
                              onChange={e => setStage(stage, { smoke: e.target.value })}
                              slotProps={{ input: { 'data-testid': `loop-form-stage-smoke-${i}` } }}
                            />
                          </FormControl>
                          <FormControl>
                            <FormLabel>Hold labels</FormLabel>
                            <Input
                              placeholder="hold, do-not-merge"
                              value={settings.holdLabels ?? ''}
                              onChange={e => setStage(stage, { holdLabels: e.target.value })}
                              slotProps={{ input: { 'data-testid': `loop-form-stage-hold-${i}` } }}
                            />
                          </FormControl>
                        </>
                      )}
                      <FormControl>
                        <FormLabel>Model</FormLabel>
                        <Select
                          value={settings.model ?? ''}
                          onChange={(_, model) => setStage(stage, { model: model || undefined })}
                          data-testid={`loop-form-stage-model-${i}`}
                        >
                          {modelOptions(settings.model, 'Loop default')}
                        </Select>
                      </FormControl>
                      <FormControl>
                        <FormLabel>Escalation model</FormLabel>
                        <Select
                          value={settings.escalationModel ?? ''}
                          onChange={(_, model) => setStage(stage, { escalationModel: model || undefined })}
                          data-testid={`loop-form-stage-escalation-model-${i}`}
                        >
                          {modelOptions(settings.escalationModel, 'Loop default')}
                        </Select>
                      </FormControl>
                      <FormControl>
                        <FormLabel>Tools</FormLabel>
                        <Select
                          multiple
                          placeholder="Loop default"
                          value={settings.tools ?? []}
                          onChange={(_, tools) => setStage(stage, { tools })}
                          slotProps={{ listbox: { sx: { maxHeight: 320, overflow: 'auto' } } }}
                          data-testid={`loop-form-stage-tools-${i}`}
                        >
                          {toolOptions(settings.tools ?? [], tools => setStage(stage, { tools }))}
                        </Select>
                        {newToolsHint(settings.tools ?? [])}
                      </FormControl>
                      {settings.runner !== 'desktop' && (
                        <FormControl>
                          <FormLabel>Agent</FormLabel>
                          <Select
                            value={settings.agentId ?? ''}
                            onChange={(_, agentId) => setStage(stage, { agentId: agentId || undefined })}
                            data-testid={`loop-form-stage-agent-${i}`}
                          >
                            <Option value="">Same as loop</Option>
                            {agents.map(agent => (
                              <Option key={agent.id} value={agent.id}>
                                {agent.name}
                              </Option>
                            ))}
                          </Select>
                        </FormControl>
                      )}
                      <FormControl>
                        <FormLabel>Skills</FormLabel>
                        <Select
                          multiple
                          placeholder="None"
                          value={settings.skills ?? []}
                          onChange={(_, picked) => setStage(stage, { skills: picked })}
                          data-testid={`loop-form-stage-skills-${i}`}
                        >
                          {skills.map(skill => (
                            <Option key={skill.id} value={skill.id}>
                              {skill.name}
                            </Option>
                          ))}
                        </Select>
                        <FormHelperText>Added to the prompt of runs working a ticket in this stage.</FormHelperText>
                      </FormControl>
                      <FormControl>
                        <FormLabel>Instructions</FormLabel>
                        <Textarea
                          minRows={2}
                          maxRows={8}
                          placeholder="Added to the prompt of runs working a ticket in this stage"
                          value={settings.instructions ?? ''}
                          onChange={e => setStage(stage, { instructions: e.target.value })}
                          slotProps={{ textarea: { 'data-testid': `loop-form-stage-instructions-${i}` } }}
                        />
                      </FormControl>
                    </Stack>
                  );
                })}
              </Stack>
            </AccordionDetails>
          </Accordion>
          {errors.stageConfig && (
            <Typography level="body-sm" color="danger">
              {errors.stageConfig}
            </Typography>
          )}
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
          <FormControl error={!!errors.handoffTargets}>
            <FormLabel>Hand off to</FormLabel>
            <Select
              multiple
              placeholder="None"
              value={handoffTargets}
              onChange={(_, targets) => set('handoffTargets', targets)}
              data-testid="loop-form-handoff-targets"
            >
              {otherLoops.map(other => (
                <Option key={other.id} value={other.id}>
                  {other.name}
                </Option>
              ))}
            </Select>
            <FormHelperText>
              {errors.handoffTargets ??
                'Runs of this loop can pass tickets to the loops picked here. You can move any ticket yourself.'}
            </FormHelperText>
          </FormControl>
          <FormControl error={!!errors.triggers}>
            <FormLabel>Triggers</FormLabel>
            <Stack gap={1}>
              {triggers.map((trigger, i) => (
                <Stack key={i} direction="row" gap={1} alignItems="center" data-testid={`loop-form-trigger-${i}`}>
                  <Select
                    placeholder="When a ticket of"
                    value={trigger.fromLoopId || null}
                    onChange={(_, fromLoopId) => setTrigger(i, { fromLoopId: fromLoopId ?? '', stage: '' })}
                    sx={{ flex: 1 }}
                    data-testid={`loop-form-trigger-from-${i}`}
                  >
                    {otherLoops.map(other => (
                      <Option key={other.id} value={other.id}>
                        {other.name}
                      </Option>
                    ))}
                  </Select>
                  <Select
                    placeholder="reaches"
                    value={trigger.stage || null}
                    onChange={(_, stage) => setTrigger(i, { stage: stage ?? '' })}
                    sx={{ flex: 1 }}
                    data-testid={`loop-form-trigger-stage-${i}`}
                  >
                    {(otherLoops.find(other => other.id === trigger.fromLoopId)?.stages ?? []).map(stage => (
                      <Option key={stage} value={stage}>
                        {stage}
                      </Option>
                    ))}
                  </Select>
                  <Select
                    value={trigger.toStage}
                    onChange={(_, toStage) => setTrigger(i, { toStage: toStage ?? '' })}
                    sx={{ flex: 1 }}
                    data-testid={`loop-form-trigger-to-${i}`}
                  >
                    <Option value="">File into first stage</Option>
                    {values.stages.slice(0, -1).map(stage => (
                      <Option key={stage} value={stage}>
                        File into {stage}
                      </Option>
                    ))}
                  </Select>
                  <Button
                    variant="plain"
                    color="neutral"
                    size="sm"
                    onClick={() =>
                      set(
                        'triggers',
                        triggers.filter((_, j) => j !== i)
                      )
                    }
                    data-testid={`loop-form-trigger-remove-${i}`}
                  >
                    Remove
                  </Button>
                </Stack>
              ))}
              <Box>
                <Button
                  variant="outlined"
                  size="sm"
                  disabled={triggers.length >= LOOP_TRIGGERS_MAX || otherLoops.length === 0}
                  onClick={() => set('triggers', [...triggers, { fromLoopId: '', stage: '', toStage: '' }])}
                  data-testid="loop-form-trigger-add-btn"
                >
                  Add trigger
                </Button>
              </Box>
            </Stack>
            <FormHelperText>
              {errors.triggers ??
                "When a ticket of the picked loop reaches the stage, a linked ticket is filed into this loop. Pick a loop's last stage to fire when its tickets close."}
            </FormHelperText>
          </FormControl>
          <FormControl>
            <FormLabel>Wake</FormLabel>
            <RadioGroup
              value={values.wakeMode}
              onChange={e => set('wakeMode', e.target.value as LoopFormValues['wakeMode'])}
              data-testid="loop-form-wake-mode"
            >
              <Radio
                value="interval"
                label="On schedule and when tickets arrive"
                data-testid="loop-form-wake-interval"
              />
              <Radio value="tickets" label="Only when tickets arrive" data-testid="loop-form-wake-tickets" />
            </RadioGroup>
            <FormHelperText>
              Only when tickets arrive: an idle loop costs nothing, and the interval is only the retry delay after a
              capped run or a run that failed to start.
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
          <FormControl error={!!errors.sla}>
            <FormLabel>Service level (hours)</FormLabel>
            <Stack direction="row" gap={1}>
              <Input
                type="number"
                startDecorator="p0"
                placeholder={String(LOOP_SERVICE_LEVEL_HOURS.p0)}
                value={values.slaP0}
                onChange={e => set('slaP0', e.target.value)}
                sx={{ width: 140 }}
                slotProps={{ input: { min: 0, step: 'any', 'data-testid': 'loop-form-sla-p0' } }}
              />
              <Input
                type="number"
                startDecorator="p1"
                placeholder={String(LOOP_SERVICE_LEVEL_HOURS.p1)}
                value={values.slaP1}
                onChange={e => set('slaP1', e.target.value)}
                sx={{ width: 140 }}
                slotProps={{ input: { min: 0, step: 'any', 'data-testid': 'loop-form-sla-p1' } }}
              />
            </Stack>
            <FormHelperText>
              {errors.sla ?? 'A p0 or p1 ticket waiting longer than this shows as Overdue and notifies you.'}
            </FormHelperText>
          </FormControl>
          <FormControl error={!!errors.p2Cap}>
            <FormLabel>p2 runs per day</FormLabel>
            <Input
              type="number"
              placeholder="No cap"
              value={values.p2Cap}
              onChange={e => set('p2Cap', e.target.value)}
              sx={{ width: 160 }}
              slotProps={{ input: { min: 0, 'data-testid': 'loop-form-p2-cap' } }}
            />
            <FormHelperText>
              {errors.p2Cap ??
                'Optional. Keeps room for p0/p1: past it, p2 and p3 wait for 00:00 UTC and extra agent-set p2s move to p3.'}
            </FormHelperText>
          </FormControl>
          <FormControl>
            <FormLabel>Triage model</FormLabel>
            <Select
              value={values.triageModel}
              onChange={(_, model) => set('triageModel', model ?? '')}
              data-testid="loop-form-triage-model"
            >
              {modelOptions(values.triageModel, 'Loop model')}
            </Select>
            <FormHelperText>Sets the priority of tickets added without one.</FormHelperText>
          </FormControl>
          <FormControl>
            <FormLabel>Escalation model</FormLabel>
            <Select
              value={values.escalationModel}
              onChange={(_, model) => set('escalationModel', model ?? '')}
              data-testid="loop-form-escalation-model"
            >
              {modelOptions(values.escalationModel, 'None')}
            </Select>
            <FormHelperText>Optional. Runs a ticket&apos;s last try before it is blocked.</FormHelperText>
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
