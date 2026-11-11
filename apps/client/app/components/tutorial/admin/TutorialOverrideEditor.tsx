import { FC, useEffect, useMemo, useState } from 'react';
import {
  Alert,
  Box,
  Button,
  Chip,
  FormControl,
  FormHelperText,
  FormLabel,
  IconButton,
  Input,
  Option,
  Select,
  Stack,
  Textarea,
  Typography,
} from '@mui/joy';
import ArrowUpwardIcon from '@mui/icons-material/ArrowUpward';
import ArrowDownwardIcon from '@mui/icons-material/ArrowDownward';
import {
  COPY_FIELDS,
  TEXT_MAX,
  TUTORIAL_CARD_SIDES,
  type AnchorUnit,
  type TutorialStep,
  type UnitState,
} from '@bike4mind/common';
import {
  TutorialEditRefused,
  useSaveTutorialEdits,
  useTutorialModules,
} from '@client/app/hooks/tutorials/useTutorialModules';
import { resolveTutorialSteps } from '../TutorialHostContext';
import type { TutorialStepRegistry } from '../types';
import type { TutorialAnchorChoices, TutorialModuleOverrideRow } from './adminTypes';
import {
  anchorValue,
  copyValue,
  diffOf,
  draftFrom,
  moveStep,
  orderOf,
  resetStep,
  sameDraft,
  setAnchor,
  setCopy,
  setTurn,
  turnValue,
  unitsOf,
  type OverrideDraft,
} from './tutorialOverrideDraft';
import { downloadOverrideBundle, liveUnitsOf } from './tutorialOverrideExport';

const REASON_MAX = 500;
const STATE_LABEL: Record<UnitState, string> = { live: 'live', retired: 'retired', stale: 'stale: review' };
const STATE_COLOR = { live: 'primary', retired: 'neutral', stale: 'warning' } as const;

const StateChip: FC<{ unitKey: string; state?: UnitState }> = ({ unitKey, state }) =>
  state ? (
    <Chip size="sm" variant="soft" color={STATE_COLOR[state]} data-testid={`tutorial-override-state-${unitKey}`}>
      {STATE_LABEL[state]}
    </Chip>
  ) : null;

const ReadOnlyField: FC<{ label: string; value: string }> = ({ label, value }) => (
  <Box>
    <Typography level="body-xs" sx={{ color: 'text.tertiary' }}>
      {label} (edit in code)
    </Typography>
    <Typography level="body-sm" sx={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>
      {value}
    </Typography>
  </Box>
);

interface AnchorPickerProps {
  step: TutorialStep;
  value: AnchorUnit;
  choices: TutorialAnchorChoices;
  onChange: (value: AnchorUnit) => void;
}

/** Anchor, scope, side and avoid edited as one value, each picked from what the repo modules already use. */
const AnchorPicker: FC<AnchorPickerProps> = ({ step, value, choices, onChange }) => {
  const pick = (key: keyof AnchorUnit, options: readonly string[], label: string) => (
    <FormControl size="sm" sx={{ minWidth: 160, flex: 1 }}>
      <FormLabel>{label}</FormLabel>
      <Select
        value={value[key] ?? ''}
        onChange={(_, next) => onChange({ ...value, [key]: next || undefined })}
        slotProps={{
          button: { 'data-testid': `tutorial-override-anchor-${step.id}-${key}` } as Record<string, unknown>,
        }}
      >
        <Option value="">none</Option>
        {[...new Set([...(value[key] ? [value[key] as string] : []), ...options])].map(option => (
          <Option key={option} value={option}>
            {option}
          </Option>
        ))}
      </Select>
    </FormControl>
  );
  return (
    <Stack direction="row" gap={1} flexWrap="wrap" data-testid={`tutorial-override-anchor-${step.id}`}>
      {pick('anchor', choices.anchors, 'Anchor')}
      {pick('anchorScope', choices.anchorScopes, 'Scope')}
      {pick('placement', TUTORIAL_CARD_SIDES, 'Side')}
      {pick('avoid', choices.avoids, 'Avoid')}
    </Stack>
  );
};

interface Props {
  apiBase: string;
  row: TutorialModuleOverrideRow;
  choices: TutorialAnchorChoices;
  /** The host's own step renderers, on top of the generic ones, so a step nothing renders can be flagged. */
  steps?: TutorialStepRegistry;
  /** Told whenever the draft gains or loses unsaved changes. */
  onDirtyChange?: (dirty: boolean) => void;
}

/** Live edits to one repo module: copy, anchors, order, and a turn's prompt or reply, saved as one set. */
const TutorialOverrideEditor: FC<Props> = ({ apiBase, row, choices, steps, onDirtyChange }) => {
  const save = useSaveTutorialEdits(apiBase);
  const modules = useTutorialModules(apiBase);
  const renderers = useMemo(() => resolveTutorialSteps(apiBase, steps), [apiBase, steps]);
  const saved = useMemo(() => draftFrom(row.fields), [row.fields]);
  const [draft, setDraft] = useState<OverrideDraft>(saved);
  // The row refetches under an open draft, so a save is checked against the sequence and fields the draft
  // started from, not the row's current ones.
  const [basis, setBasis] = useState<number | null>(row.contentSeq);
  const [base, setBase] = useState<OverrideDraft>(saved);
  const [reason, setReason] = useState('');
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set());
  const [refused, setRefused] = useState<TutorialEditRefused | null>(null);

  const stepById = useMemo(() => new Map(row.repo.steps.map(step => [step.id, step])), [row.repo.steps]);
  const repoIds = useMemo(() => row.repo.steps.map(step => step.id), [row.repo.steps]);
  const stateOf = useMemo(() => new Map(row.report.states.map(s => [s.key, s.state])), [row.report.states]);
  const order = orderOf(draft, repoIds);
  const dirty = !sameDraft(draft, base);
  // An untouched draft follows another admin's save; a touched one keeps its basis and meets the 409.
  useEffect(() => {
    if (row.contentSeq === basis || dirty) return;
    setDraft(saved);
    setBase(saved);
    setBasis(row.contentSeq);
  }, [row.contentSeq, basis, dirty, saved]);
  useEffect(() => {
    onDirtyChange?.(dirty);
    return () => onDirtyChange?.(false);
  }, [dirty, onDirtyChange]);
  const reasonGiven = reason.trim().length > 0;

  const submit = (fields: ReturnType<typeof unitsOf>) =>
    save.mutate(
      { moduleId: row.moduleId, fields, reason: reason.trim(), expectedContentSeq: basis },
      {
        onSuccess: data => {
          const fresh = data.modules.find(m => m.moduleId === row.moduleId);
          const next = draftFrom(fresh?.fields ?? []);
          setDraft(next);
          setBase(next);
          setBasis(fresh?.contentSeq ?? null);
          setReason('');
          setRefused(null);
        },
        onError: error => setRefused(error instanceof TutorialEditRefused ? error : null),
      }
    );

  const reload = async () => {
    const fresh = (await modules.refetch()).data?.find(m => m.moduleId === row.moduleId);
    if (!fresh) return;
    const next = draftFrom(fresh.fields);
    setDraft(next);
    setBase(next);
    setBasis(fresh.contentSeq);
    setRefused(null);
  };

  const toggle = (stepId: string) =>
    setOpen(prev => {
      const next = new Set(prev);
      if (next.has(stepId)) next.delete(stepId);
      else next.add(stepId);
      return next;
    });

  const sentTurns = new Set<number>();
  const rulesFor = (stepId: string) => (refused?.rules ?? []).filter(rule => rule.stepId === stepId);

  return (
    <Stack gap={1.5} data-testid={`tutorial-override-editor-${row.moduleId}`} sx={{ pt: 1 }}>
      {row.report.rejected.length > 0 && (
        <Alert color="danger" variant="soft" data-testid={`tutorial-override-rejected-${row.moduleId}`}>
          <Box>
            <Typography level="title-sm">Override rejected: learners get the repo text</Typography>
            {row.report.rejected.map((issue, i) => (
              <Typography key={i} level="body-xs">
                {issue.stepId ? `${issue.stepId}: ` : ''}
                {issue.message} ({issue.rule})
              </Typography>
            ))}
          </Box>
        </Alert>
      )}

      {stateOf.has('order') && (
        <Stack direction="row" alignItems="center" gap={1}>
          <Typography level="body-sm">Step order</Typography>
          <StateChip unitKey="order" state={stateOf.get('order')} />
        </Stack>
      )}

      {order.map((stepId, index) => {
        const step = stepById.get(stepId)!;
        const editable = row.editable[stepId] ?? [];
        const turn = step.turn !== undefined && !sentTurns.has(step.turn) ? row.repo.turns[step.turn] : undefined;
        if (step.turn !== undefined) sentTurns.add(step.turn);
        const isOpen = open.has(stepId);
        const fieldStates = [...stateOf.entries()].filter(
          ([key]) => key.startsWith(`copy:${stepId}:`) || key === `anchor:${stepId}` || key === `turn:${step.turn}`
        );
        return (
          <Box
            key={stepId}
            data-testid={`tutorial-override-step-${stepId}`}
            sx={{ border: '1px solid', borderColor: 'divider', borderRadius: 'sm', p: 1 }}
          >
            <Stack direction="row" alignItems="center" gap={1}>
              <IconButton
                size="sm"
                variant="plain"
                disabled={index === 0}
                onClick={() => setDraft(d => moveStep(d, repoIds, stepId, -1))}
                aria-label={`Move ${stepId} up`}
                data-testid={`tutorial-override-move-up-${stepId}`}
              >
                <ArrowUpwardIcon />
              </IconButton>
              <IconButton
                size="sm"
                variant="plain"
                disabled={index === order.length - 1}
                onClick={() => setDraft(d => moveStep(d, repoIds, stepId, 1))}
                aria-label={`Move ${stepId} down`}
                data-testid={`tutorial-override-move-down-${stepId}`}
              >
                <ArrowDownwardIcon />
              </IconButton>
              <Typography level="title-sm" sx={{ flex: 1, minWidth: 0, overflowWrap: 'anywhere' }}>
                {step.title ?? stepId}
                <Typography level="body-xs" sx={{ color: 'text.tertiary', ml: 1 }}>
                  {stepId} / {step.type}
                  {step.turn !== undefined ? ` / turn ${step.turn}` : ''}
                </Typography>
              </Typography>
              {!renderers[step.type] && (
                <Chip size="sm" variant="soft" color="warning" data-testid={`tutorial-override-no-renderer-${stepId}`}>
                  no renderer
                </Chip>
              )}
              {fieldStates.map(([key, state]) => (
                <StateChip key={key} unitKey={key} state={state} />
              ))}
              <Button
                size="sm"
                variant="plain"
                onClick={() => toggle(stepId)}
                data-testid={`tutorial-override-edit-${stepId}`}
              >
                {isOpen ? 'Close' : 'Edit'}
              </Button>
            </Stack>
            {rulesFor(stepId).map((rule, i) => (
              <Typography key={i} level="body-xs" color="danger">
                {rule.message} ({rule.rule})
              </Typography>
            ))}
            {isOpen && (
              <Stack gap={1} sx={{ mt: 1 }}>
                {COPY_FIELDS.filter(field => step[field] !== undefined).map(field =>
                  editable.includes(field) ? (
                    <FormControl key={field} size="sm">
                      <FormLabel>{field}</FormLabel>
                      <Textarea
                        minRows={1}
                        value={copyValue(draft, step, field)}
                        onChange={event => setDraft(d => setCopy(d, step, field, event.target.value))}
                        slotProps={{
                          textarea: {
                            maxLength: TEXT_MAX,
                            'data-testid': `tutorial-override-field-${stepId}-${field}`,
                          } as Record<string, unknown>,
                        }}
                      />
                    </FormControl>
                  ) : (
                    <ReadOnlyField key={field} label={field} value={step[field] ?? ''} />
                  )
                )}
                {step.anchor !== undefined || step.anchorScope !== undefined || step.placement !== undefined ? (
                  <AnchorPicker
                    step={step}
                    value={anchorValue(draft, step)}
                    choices={choices}
                    onChange={value => setDraft(d => setAnchor(d, step, value))}
                  />
                ) : null}
                {turn && (
                  <>
                    {turn.turn > 0 && editable.includes('prompt') ? (
                      <FormControl size="sm">
                        <FormLabel>Message the learner sends (saved with its reply)</FormLabel>
                        <Textarea
                          minRows={1}
                          value={turnValue(draft, turn).prompt}
                          onChange={event =>
                            setDraft(d => setTurn(d, turn, { ...turnValue(d, turn), prompt: event.target.value }))
                          }
                          slotProps={{
                            textarea: {
                              maxLength: TEXT_MAX,
                              'data-testid': `tutorial-override-field-${stepId}-prompt`,
                            } as Record<string, unknown>,
                          }}
                        />
                      </FormControl>
                    ) : (
                      <ReadOnlyField label="Message the learner sends" value={turn.prompt} />
                    )}
                    <FormControl size="sm">
                      <FormLabel>Recorded reply</FormLabel>
                      <Textarea
                        minRows={2}
                        maxRows={10}
                        value={turnValue(draft, turn).reply}
                        onChange={event =>
                          setDraft(d => setTurn(d, turn, { ...turnValue(d, turn), reply: event.target.value }))
                        }
                        slotProps={{
                          textarea: {
                            maxLength: TEXT_MAX,
                            'data-testid': `tutorial-override-field-${stepId}-reply`,
                          } as Record<string, unknown>,
                        }}
                      />
                    </FormControl>
                  </>
                )}
                <Box>
                  <Button
                    size="sm"
                    variant="outlined"
                    color="neutral"
                    onClick={() => setDraft(d => resetStep(d, step))}
                    data-testid={`tutorial-override-reset-step-${stepId}`}
                  >
                    Reset step
                  </Button>
                </Box>
              </Stack>
            )}
          </Box>
        );
      })}

      {dirty && (
        <Box data-testid="tutorial-override-diff">
          <Typography level="title-sm">Changes against the repo</Typography>
          {diffOf(draft).map(line => (
            <Typography key={line.key} level="body-xs" sx={{ overflowWrap: 'anywhere' }}>
              <b>{line.key}</b>: {line.before} {'->'} {line.after}
            </Typography>
          ))}
        </Box>
      )}

      {refused && (
        <Alert color="danger" variant="soft" data-testid="tutorial-override-errors">
          <Box>
            <Typography level="title-sm">{refused.message}</Typography>
            {refused.rules.map((rule, i) => (
              <Typography key={i} level="body-xs">
                {rule.stepId ? `${rule.stepId}: ` : ''}
                {rule.message} ({rule.rule})
              </Typography>
            ))}
            {refused.conflict && (
              <Button
                size="sm"
                variant="outlined"
                color="danger"
                sx={{ mt: 1 }}
                disabled={modules.isFetching}
                onClick={() => void reload()}
                data-testid="tutorial-override-reload"
              >
                Reload, dropping my changes
              </Button>
            )}
          </Box>
        </Alert>
      )}

      <FormControl size="sm">
        <Input
          placeholder="Reason for the edit"
          value={reason}
          onChange={event => setReason(event.target.value.slice(0, REASON_MAX))}
          slotProps={{ input: { 'data-testid': 'tutorial-override-reason', 'aria-label': 'Reason for the edit' } }}
        />
        <FormHelperText>
          Required. Fixing a card&apos;s words or a reply leaves learners where they are; a new order, anchor or message
          restarts anyone part way through.
        </FormHelperText>
      </FormControl>
      <Stack direction="row" gap={1}>
        <Button
          size="sm"
          disabled={!dirty || !reasonGiven || save.isPending}
          onClick={() => submit(unitsOf(draft))}
          data-testid="tutorial-override-save"
        >
          Save edits
        </Button>
        <Button
          size="sm"
          variant="outlined"
          color="danger"
          disabled={row.fields.length === 0 || !reasonGiven || save.isPending}
          onClick={() => submit([])}
          data-testid="tutorial-override-reset-module"
        >
          Reset module
        </Button>
        <Button
          size="sm"
          variant="outlined"
          color="neutral"
          disabled={liveUnitsOf(row).length === 0}
          onClick={() => downloadOverrideBundle(row)}
          data-testid="tutorial-override-export"
        >
          Export
        </Button>
      </Stack>
    </Stack>
  );
};

export default TutorialOverrideEditor;
