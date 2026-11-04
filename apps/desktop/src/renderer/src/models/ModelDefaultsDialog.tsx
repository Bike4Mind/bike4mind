import { useEffect, useState } from 'react';
import Alert from '@mui/joy/Alert';
import Box from '@mui/joy/Box';
import Button from '@mui/joy/Button';
import CircularProgress from '@mui/joy/CircularProgress';
import DialogActions from '@mui/joy/DialogActions';
import DialogContent from '@mui/joy/DialogContent';
import DialogTitle from '@mui/joy/DialogTitle';
import Input from '@mui/joy/Input';
import Modal from '@mui/joy/Modal';
import ModalDialog from '@mui/joy/ModalDialog';
import Option from '@mui/joy/Option';
import Select from '@mui/joy/Select';
import Stack from '@mui/joy/Stack';
import Typography from '@mui/joy/Typography';
import type { ChatModelOption } from '@shared/chat';
import {
  GENERATION_FIELDS,
  GENERATION_LABELS,
  requestGeneration,
  type CatalogSampling,
  type GenerationField,
  type GenerationSettings,
  type NumericControl,
} from '@shared/generation';
import type { ModelEffort, ModelSettings } from '@shared/modelSettings';
import { EFFORT_LABELS } from '../chat/ReasoningEffortPicker';

const numberFormat = new Intl.NumberFormat('en-US', { maximumFractionDigits: 3 });

/** The fields a model's defaults can set: request-scope controls it lists and does not lock. */
export function editableFields(
  option: Pick<ChatModelOption, 'controls'> | null | undefined
): { field: GenerationField; control: NumericControl }[] {
  return GENERATION_FIELDS.flatMap(field => {
    const control = option?.controls?.[field];
    return control && control.scope === 'request' && !control.locked ? [{ field, control }] : [];
  });
}

/** Whether the Models screen offers a Settings dialog for this model. */
export function hasModelDefaults(option: Pick<ChatModelOption, 'controls'> | null | undefined): boolean {
  return editableFields(option).length > 0 || (option?.controls?.effort?.levels.length ?? 0) > 0;
}

type ThinkingState = 'thinking' | 'nonThinking';

function statesOf(option: ChatModelOption): ThinkingState[] {
  if (option.thinkingAlwaysOn) return ['thinking'];
  return option.thinkingToggle || option.controls?.effort ? ['thinking', 'nonThinking'] : ['nonThinking'];
}

export interface Seed {
  source: 'catalog' | 'model default';
  /** Undefined for a model default Desktop cannot read, such as a server's. */
  value?: number;
  unlimited?: true;
}

/** What a blank field sends in each thinking state the model has: the catalog's sampling, else the model's own default. */
export function seedsFor(
  field: GenerationField,
  control: NumericControl,
  option: ChatModelOption
): { state: ThinkingState; seed: Seed }[] {
  const sampling: CatalogSampling | undefined = option.catalogSampling;
  return statesOf(option).map(state => {
    const value = sampling?.[state]?.[field];
    if (value !== undefined) return { state, seed: { source: 'catalog', value } };
    return {
      state,
      seed: {
        source: 'model default',
        ...(control.default !== undefined ? { value: control.default } : {}),
        ...(control.default === undefined && control.unlimitedDefault ? { unlimited: true as const } : {}),
      },
    };
  });
}

function seedText(seed: Seed): string {
  const label = seed.source === 'catalog' ? 'Catalog' : 'Model default';
  if (seed.value !== undefined) return `${label}: ${numberFormat.format(seed.value)}`;
  return seed.unlimited ? `${label}: no limit` : label;
}

const STATE_TEXT: Record<ThinkingState, string> = { thinking: 'while thinking', nonThinking: 'with thinking off' };

/** The note under a field, naming where a blank value comes from. */
export function seedNote(seeds: { state: ThinkingState; seed: Seed }[]): string {
  const texts = seeds.map(({ seed }) => seedText(seed));
  if (texts.every(text => text === texts[0])) return `${texts[0]}.`;
  return `${seeds.map(({ state }, index) => `${texts[index]} ${STATE_TEXT[state]}`).join('. ')}.`;
}

function placeholderFor(seeds: { seed: Seed }[]): string {
  const { seed } = seeds[0];
  if (seed.value !== undefined) return String(seed.value);
  return seed.unlimited ? 'No limit' : 'Default';
}

type Drafts = Partial<Record<GenerationField, string>>;

function draftsOf(generation: GenerationSettings | undefined): Drafts {
  const drafts: Drafts = {};
  for (const field of GENERATION_FIELDS) {
    const value = generation?.[field];
    if (value !== undefined) drafts[field] = String(value);
  }
  return drafts;
}

/**
 * One model's defaults: the per-request options its controls list. A blank field stores nothing,
 * so a turn sends the catalog's sampling for a reviewed build, else nothing and the model's own
 * default applies. A conversation's own settings override these.
 */
export function ModelDefaultsDialog({ option, onClose }: { option: ChatModelOption | null; onClose: () => void }) {
  return <ModelDefaultsForm key={option?.id ?? ''} option={option} onClose={onClose} />;
}

/** An IPC rejection arrives wrapped in Electron's "Error invoking remote method" text. */
function reasonText(reason: unknown): string {
  const text = reason instanceof Error ? reason.message : String(reason);
  return text.replace(/^Error invoking remote method '[^']*': (?:Error: )?/, '');
}

function ModelDefaultsForm({ option, onClose }: { option: ChatModelOption | null; onClose: () => void }) {
  const [loaded, setLoaded] = useState<ModelSettings | null>(null);
  const [readFailed, setReadFailed] = useState(false);
  const [drafts, setDrafts] = useState<Drafts>({});
  const [effort, setEffort] = useState<ModelEffort | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const modelId = option?.id ?? null;

  useEffect(() => {
    setLoaded(null);
    setReadFailed(false);
    setError(null);
    if (!modelId) return;
    let live = true;
    window.b4m.chat.getModelSettings(modelId).then(
      settings => {
        if (!live) return;
        const current = settings ?? {};
        setLoaded(current);
        setDrafts(draftsOf(current.generation));
        setEffort(current.effort ?? null);
      },
      (reason: unknown) => {
        if (!live) return;
        setLoaded({});
        setReadFailed(true);
        setError(`Desktop could not read this model's settings: ${reasonText(reason)}`);
      }
    );
    return () => {
      live = false;
    };
  }, [modelId]);

  if (!option) return null;
  const fields = editableFields(option);
  const levels = option.controls?.effort?.levels ?? [];

  const save = async () => {
    const generation: GenerationSettings = {};
    for (const { field, control } of fields) {
      const text = drafts[field]?.trim();
      if (!text) continue;
      const value = requestGeneration({ [field]: Number(text) }, { [field]: control })[field];
      if (value !== undefined) generation[field] = value;
    }
    const next: ModelSettings = {
      ...(Object.keys(generation).length > 0 ? { generation } : {}),
      ...(effort && levels.includes(effort) ? { effort } : {}),
    };
    setSaving(true);
    try {
      const saved = await window.b4m.chat.setModelSettings(option.id, next);
      if (saved) onClose();
      else setError('Desktop could not save these settings.');
    } catch (reason) {
      setError(`Desktop could not save these settings: ${reasonText(reason)}`);
    } finally {
      setSaving(false);
    }
  };

  const touched = fields.some(({ field }) => drafts[field]?.trim()) || effort !== null;

  return (
    <Modal open onClose={() => !saving && onClose()}>
      <ModalDialog size="md" sx={{ maxWidth: 480, width: '100%' }} data-testid="model-defaults-dialog">
        <DialogTitle>Settings for {option.name}</DialogTitle>
        <DialogContent>
          <Typography level="body-sm" textColor="text.tertiary">
            Defaults for every chat on this model. A chat&apos;s own settings override them. A blank field uses the
            catalog value when there is one, else the model&apos;s own default.
          </Typography>
          {error && (
            <Alert color="danger" variant="soft" sx={{ mt: 1 }} data-testid="model-defaults-error">
              {error}
            </Alert>
          )}
          {loaded === null ? (
            <Box sx={{ display: 'grid', placeItems: 'center', py: 3 }}>
              <CircularProgress size="sm" />
            </Box>
          ) : (
            <Stack spacing={0.5} sx={{ mt: 1 }}>
              {fields.map(({ field, control }) => {
                const seeds = seedsFor(field, control, option);
                return (
                  <Stack
                    key={field}
                    direction="row"
                    alignItems="center"
                    justifyContent="space-between"
                    spacing={2}
                    sx={{ py: 0.5 }}
                    data-testid={`model-defaults-${field}-row`}
                  >
                    <Stack sx={{ minWidth: 0 }}>
                      <Typography level="body-sm">{GENERATION_LABELS[field]}</Typography>
                      <Typography
                        level="body-xs"
                        textColor="text.tertiary"
                        id={`model-defaults-${field}-note`}
                        data-testid={`model-defaults-${field}-source`}
                        data-source={seeds[0].seed.source}
                      >
                        {seedNote(seeds)}
                        {control.includesThinking ? ' Thinking counts toward it.' : ''}
                      </Typography>
                    </Stack>
                    <Input
                      size="sm"
                      type="number"
                      value={drafts[field] ?? ''}
                      placeholder={placeholderFor(seeds)}
                      disabled={saving}
                      onChange={event => setDrafts(current => ({ ...current, [field]: event.target.value }))}
                      sx={{
                        width: 112,
                        flexShrink: 0,
                        '--Input-placeholderColor': 'var(--joy-palette-text-tertiary)',
                        '& input::placeholder': { fontStyle: 'italic' },
                      }}
                      slotProps={{
                        input: {
                          min: control.min,
                          max: control.max,
                          step: control.step,
                          'aria-label': GENERATION_LABELS[field],
                          'aria-describedby': `model-defaults-${field}-note`,
                          'data-testid': `model-defaults-${field}-input`,
                        },
                      }}
                    />
                  </Stack>
                );
              })}
              {levels.length > 0 && (
                <Stack direction="row" alignItems="center" justifyContent="space-between" spacing={2} sx={{ py: 0.5 }}>
                  <Stack sx={{ minWidth: 0 }}>
                    <Typography level="body-sm">Thinking level</Typography>
                    <Typography level="body-xs" textColor="text.tertiary">
                      Used while a chat&apos;s effort is Default.
                    </Typography>
                  </Stack>
                  <Select
                    size="sm"
                    value={effort ?? 'default'}
                    disabled={saving}
                    onChange={(_event, value) =>
                      setEffort(value && value !== 'default' ? (value as ModelEffort) : null)
                    }
                    sx={{ width: 140, flexShrink: 0 }}
                    slotProps={{ button: { 'aria-label': 'Thinking level' } }}
                    data-testid="model-defaults-effort-select"
                  >
                    <Option value="default">Model default</Option>
                    {levels.map(level => (
                      <Option key={level} value={level}>
                        {EFFORT_LABELS[level]}
                      </Option>
                    ))}
                  </Select>
                </Stack>
              )}
            </Stack>
          )}
        </DialogContent>
        <DialogActions>
          <Button
            loading={saving}
            disabled={loaded === null || readFailed}
            onClick={() => void save()}
            data-testid="model-defaults-save-btn"
          >
            Save
          </Button>
          <Button
            variant="plain"
            color="neutral"
            disabled={saving}
            onClick={onClose}
            data-testid="model-defaults-cancel-btn"
          >
            Cancel
          </Button>
          <Button
            variant="plain"
            color="neutral"
            disabled={saving || loaded === null || !touched}
            onClick={() => {
              setDrafts({});
              setEffort(null);
            }}
            sx={{ mr: 'auto' }}
            data-testid="model-defaults-clear-btn"
          >
            Clear all
          </Button>
        </DialogActions>
      </ModalDialog>
    </Modal>
  );
}
