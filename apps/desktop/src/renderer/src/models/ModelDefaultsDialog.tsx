import { useEffect, useRef, useState, type ReactNode } from 'react';
import Alert from '@mui/joy/Alert';
import Box from '@mui/joy/Box';
import Button from '@mui/joy/Button';
import CircularProgress from '@mui/joy/CircularProgress';
import DialogActions from '@mui/joy/DialogActions';
import DialogContent from '@mui/joy/DialogContent';
import DialogTitle from '@mui/joy/DialogTitle';
import Divider from '@mui/joy/Divider';
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
import { contextSizeLabel, parseModelContextSetting, type ModelContextSetting } from '@shared/localContextSetting';
import {
  KEEP_ALIVE_CHOICES,
  MAX_DRAFT_TOKENS,
  type ContextSizeOffer,
  type KeepAliveSeconds,
  type ModelEffort,
  type ModelLoadOffer,
  type ModelSettings,
} from '@shared/modelSettings';
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

const SAME_AS_SETTINGS = 'settings';
const OFFER_DEBOUNCE_MS = 250;

/** The context Select's value for a stored choice; null is the Settings choice. */
export function contextValue(context: ModelContextSetting | null): string {
  if (!context) return SAME_AS_SETTINGS;
  if (context.mode === 'fixed') return `fixed:${context.tokens}`;
  return context.maxTokens === undefined ? 'auto' : `auto:${context.maxTokens}`;
}

function contextOf(value: string): ModelContextSetting | null {
  const [mode, size] = value.split(':');
  return parseModelContextSetting(
    mode === 'fixed' ? { mode, tokens: Number(size) } : { mode, ...(size ? { maxTokens: Number(size) } : {}) }
  );
}

/** What a size stores: the size, or the trained length when that is less. */
function capOf({ size, tokens }: Pick<ContextSizeOffer, 'size' | 'tokens'>): number {
  return Math.min(size, tokens);
}

/** The num_ctx a context choice sends, from the offer's ratings; undefined when the offer does not say. */
export function contextSent(offer: ModelLoadOffer, context: ModelContextSetting | null): number | undefined {
  const offered = offer.context;
  if (offered?.kind !== 'ollama') return undefined;
  if (!context) return offered.settings;
  const tokens = context.mode === 'fixed' ? context.tokens : context.maxTokens;
  // A stored size no option lists (a re-pull changed the trained length) runs at itself, within the ceiling.
  const size =
    offered.sizes.find(candidate => capOf(candidate) === tokens) ??
    offered.sizes.find(candidate => candidate.size === tokens);
  if (!size && tokens !== undefined) {
    if (context.mode === 'fixed') return Math.min(tokens, offered.ceiling ?? tokens);
    return offered.auto === undefined ? undefined : Math.min(tokens, offered.auto);
  }
  if (context.mode === 'fixed') return size?.tokens;
  return context.maxTokens === undefined ? offered.auto : size?.autoTokens;
}

type ContextOption = { value: string; label: string; testId: string; warning?: string };

function contextOptions(offered: NonNullable<ModelLoadOffer['context']>): ContextOption[] {
  const settings: ContextOption = {
    value: SAME_AS_SETTINGS,
    label:
      offered.kind === 'budget'
        ? `Server's ${contextSizeLabel(offered.server)}`
        : offered.auto === undefined
          ? `Default (${contextSizeLabel(offered.settings)})`
          : 'Same as Settings',
    testId: 'model-defaults-context-option-settings',
  };
  if (offered.kind === 'budget') {
    return [
      settings,
      ...offered.sizes.map(size => ({
        value: `fixed:${size}`,
        label: contextSizeLabel(size),
        testId: `model-defaults-context-option-${size}`,
      })),
    ];
  }
  const auto: ContextOption[] =
    offered.auto === undefined
      ? []
      : [
          { value: 'auto', label: 'Auto', testId: 'model-defaults-context-option-auto' },
          ...offered.sizes
            .filter(candidate => offered.ceiling === undefined || capOf(candidate) < offered.ceiling)
            .map(candidate => ({
              value: `auto:${capOf(candidate)}`,
              label: `Auto, up to ${contextSizeLabel(capOf(candidate))}`,
              testId: `model-defaults-context-option-auto-${candidate.size}`,
            })),
        ];
  return [
    settings,
    ...auto,
    ...offered.sizes.map(candidate => ({
      value: `fixed:${capOf(candidate)}`,
      label: contextSizeLabel(candidate.tokens),
      testId: `model-defaults-context-option-${candidate.size}`,
      ...(candidate.loads === false ? { warning: "May not load in this computer's memory" } : {}),
    })),
  ];
}

function sameContext(a: ModelContextSetting | null, b: ModelContextSetting | null): boolean {
  return contextValue(a) === contextValue(b);
}

/** A draft count as typed; undefined for a blank field or text that is not a whole number within range. */
function draftOf(text: string, max: number): number | undefined {
  const typed = text.trim();
  const value = /^\d+$/.test(typed) ? Number(typed) : NaN;
  return value <= max ? value : undefined;
}

function storedContextLabel(context: ModelContextSetting): string {
  if (context.mode === 'fixed') return contextSizeLabel(context.tokens);
  return context.maxTokens === undefined ? 'Auto' : `Auto, up to ${contextSizeLabel(context.maxTokens)}`;
}

const KEEP_ALIVE_LABELS: Record<KeepAliveSeconds, string> = {
  300: '5 minutes',
  1800: '30 minutes',
  3600: '1 hour',
  14400: '4 hours',
  [-1]: 'Until Ollama stops',
};

/** One model's defaults: the per-request options its controls list, then the load-time options main offers. */
export function ModelDefaultsDialog({
  option,
  onClose,
  onSaved,
}: {
  option: ChatModelOption | null;
  onClose: () => void;
  /** After a save, so what rates the model (its fit badge) can read it again. */
  onSaved?: () => void;
}) {
  return <ModelDefaultsForm key={option?.id ?? ''} option={option} onClose={onClose} onSaved={onSaved} />;
}

/** An IPC rejection arrives wrapped in Electron's "Error invoking remote method" text. */
function reasonText(reason: unknown): string {
  const text = reason instanceof Error ? reason.message : String(reason);
  return text.replace(/^Error invoking remote method '[^']*': (?:Error: )?/, '');
}

function ModelDefaultsForm({
  option,
  onClose,
  onSaved,
}: {
  option: ChatModelOption | null;
  onClose: () => void;
  onSaved?: () => void;
}) {
  const [loaded, setLoaded] = useState<ModelSettings | null>(null);
  const [readFailed, setReadFailed] = useState(false);
  const [drafts, setDrafts] = useState<Drafts>({});
  // Each field's last parseable text, which a blur puts back over text the input cannot parse.
  const lastGood = useRef<Drafts>({});
  const [effort, setEffort] = useState<ModelEffort | null>(null);
  const [context, setContext] = useState<ModelContextSetting | null>(null);
  const [draftText, setDraftText] = useState('');
  const [keepAlive, setKeepAlive] = useState<KeepAliveSeconds | null>(null);
  const [offer, setOffer] = useState<ModelLoadOffer | null>(null);
  const [loadedContext, setLoadedContext] = useState<number | undefined>(undefined);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const modelId = option?.id ?? null;
  const draftTokens = draftOf(draftText, offer?.draft?.max ?? MAX_DRAFT_TOKENS);
  const draftInvalid = draftText.trim() !== '' && draftTokens === undefined;

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
        lastGood.current = draftsOf(current.generation);
        setDrafts({ ...lastGood.current });
        setEffort(current.effort ?? null);
        setContext(current.context ?? null);
        setDraftText(current.draftTokens !== undefined ? String(current.draftTokens) : '');
        setKeepAlive(current.keepAlive ?? null);
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

  useEffect(() => {
    setLoadedContext(undefined);
    if (!modelId) return;
    let live = true;
    window.b4m.models.getLoadedState(modelId).then(
      state => {
        if (live && state.kind === 'loaded') setLoadedContext(state.contextLength);
      },
      () => undefined
    );
    return () => {
      live = false;
    };
  }, [modelId]);

  // Rated again for the draft count typed, since a speculating model needs more memory at each size;
  // debounced after the model's first offer, as each one probes the model and rates every size.
  const offeredFor = useRef<string | null>(null);
  useEffect(() => {
    if (!modelId) return;
    let live = true;
    const fetchOffer = () =>
      window.b4m.chat.getModelLoadOffer(modelId, draftTokens).then(
        next => {
          if (live) setOffer(next ?? {});
        },
        () => {
          if (live) setOffer(current => current ?? {});
        }
      );
    const typed = offeredFor.current === modelId;
    offeredFor.current = modelId;
    const timer = typed ? setTimeout(fetchOffer, OFFER_DEBOUNCE_MS) : undefined;
    if (!typed) void fetchOffer();
    return () => {
      live = false;
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [modelId, draftTokens]);

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
    // Load-time choices are kept as read even when the offer could not be fetched, so a save never drops them.
    const next: ModelSettings = {
      ...(Object.keys(generation).length > 0 ? { generation } : {}),
      ...(effort && levels.includes(effort) ? { effort } : {}),
      ...(context ? { context } : {}),
      ...(draftTokens !== undefined ? { draftTokens } : {}),
      ...(keepAlive !== null ? { keepAlive } : {}),
    };
    setSaving(true);
    try {
      const saved = await window.b4m.chat.setModelSettings(option.id, next);
      if (saved) {
        onSaved?.();
        onClose();
      } else setError('Desktop could not save these settings.');
    } catch (reason) {
      setError(`Desktop could not save these settings: ${reasonText(reason)}`);
    } finally {
      setSaving(false);
    }
  };

  const touched =
    fields.some(({ field }) => drafts[field]?.trim()) ||
    effort !== null ||
    context !== null ||
    draftText.trim() !== '' ||
    keepAlive !== null;

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
                      onChange={event => {
                        if (!event.target.validity.badInput) lastGood.current[field] = event.target.value;
                        setDrafts(current => ({ ...current, [field]: event.target.value }));
                      }}
                      onBlur={event => {
                        // A number input reads text it cannot parse, such as "1e" or "-", as blank, which is not a clear.
                        const text = event.currentTarget.validity.badInput
                          ? (lastGood.current[field] ?? '')
                          : event.currentTarget.value.trim();
                        const value = text
                          ? requestGeneration({ [field]: Number(text) }, { [field]: control })[field]
                          : undefined;
                        const shown = value !== undefined ? String(value) : text;
                        event.currentTarget.value = shown;
                        lastGood.current[field] = shown;
                        setDrafts(current => ({ ...current, [field]: shown }));
                      }}
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
              {offer && (
                <LoadOptionRows
                  offer={offer}
                  saved={loaded}
                  context={context}
                  onContext={setContext}
                  draftText={draftText}
                  onDraftText={setDraftText}
                  draftInvalid={draftInvalid}
                  keepAlive={keepAlive}
                  onKeepAlive={setKeepAlive}
                  loadedContext={loadedContext}
                  disabled={saving}
                />
              )}
            </Stack>
          )}
        </DialogContent>
        <DialogActions>
          <Button
            loading={saving}
            disabled={loaded === null || readFailed || draftInvalid}
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
              lastGood.current = {};
              setDrafts({});
              setEffort(null);
              setContext(null);
              setDraftText('');
              setKeepAlive(null);
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

function OptionRow({
  label,
  note,
  testId,
  children,
}: {
  label: string;
  note: ReactNode;
  testId: string;
  children: ReactNode;
}) {
  return (
    <Stack direction="row" alignItems="center" justifyContent="space-between" spacing={2} sx={{ py: 0.5 }}>
      <Stack sx={{ minWidth: 0 }}>
        <Typography level="body-sm">{label}</Typography>
        <Typography level="body-xs" textColor="text.tertiary" id={`${testId}-note`} data-testid={`${testId}-note`}>
          {note}
        </Typography>
      </Stack>
      {children}
    </Stack>
  );
}

/** Load-time options: only those `offer` lists, each the same for every chat on the model. */
function LoadOptionRows({
  offer,
  saved,
  context,
  onContext,
  draftText,
  onDraftText,
  draftInvalid,
  keepAlive,
  onKeepAlive,
  loadedContext,
  disabled,
}: {
  offer: ModelLoadOffer;
  saved: ModelSettings | null;
  context: ModelContextSetting | null;
  onContext: (context: ModelContextSetting | null) => void;
  draftText: string;
  onDraftText: (text: string) => void;
  draftInvalid: boolean;
  keepAlive: KeepAliveSeconds | null;
  onKeepAlive: (keepAlive: KeepAliveSeconds | null) => void;
  /** The num_ctx `/api/ps` says the model is loaded with now; undefined when it is not loaded or unknown. */
  loadedContext: number | undefined;
  disabled: boolean;
}) {
  const offered = offer.context;
  if (!offered && !offer.draft && !offer.keepAlive && !offer.kvCache) return null;
  const options = offered ? contextOptions(offered) : [];
  const sent = contextSent(offer, context);
  const reloads =
    loadedContext !== undefined &&
    sent !== undefined &&
    sent !== loadedContext &&
    !sameContext(context, saved?.context ?? null);
  const tooLarge =
    offered?.kind === 'ollama' && offered.sizes.find(candidate => candidate.tokens === sent)?.loads === false;
  return (
    <>
      <Divider sx={{ my: 1 }} />
      <Typography level="body-xs" textColor="text.tertiary" data-testid="model-defaults-load-section">
        {offered?.kind === 'budget'
          ? 'Applies on this computer only.'
          : 'Sent by every request to this model, from chats, titles and summaries alike, and not set per chat.'}
      </Typography>
      {offered && (
        <OptionRow
          label="Context"
          testId="model-defaults-context"
          note={
            offered.kind === 'budget' ? (
              'The server sets the context. A smaller one here makes chats on this model summarise sooner.'
            ) : (
              <>
                {sent !== undefined ? `Runs at ${contextSizeLabel(sent)}.` : ''}
                {tooLarge ? " May not load in this computer's memory." : ''}
                {reloads && (
                  <Typography component="span" color="warning" data-testid="model-defaults-context-reload">
                    {` Reloads the model, which is loaded at ${contextSizeLabel(loadedContext)} now.`}
                  </Typography>
                )}
              </>
            )
          }
        >
          <Select
            size="sm"
            value={contextValue(context)}
            disabled={disabled}
            onChange={(_event, value) => value && onContext(contextOf(value))}
            sx={{ width: 180, flexShrink: 0 }}
            slotProps={{
              button: {
                'aria-label': 'Context',
                'aria-describedby': 'model-defaults-context-note',
                'data-testid': 'model-defaults-context-select',
              },
            }}
          >
            {options.map(({ value, label, testId, warning }) => (
              <Option key={value} value={value} label={label} data-testid={testId}>
                {warning ? (
                  <Stack>
                    {label}
                    <Typography level="body-xs" color="warning" data-testid={`${testId}-note`}>
                      {warning}
                    </Typography>
                  </Stack>
                ) : (
                  label
                )}
              </Option>
            ))}
            {offered && context && !options.some(option => option.value === contextValue(context)) && (
              <Option
                value={contextValue(context)}
                label={storedContextLabel(context)}
                data-testid="model-defaults-context-option-stored"
              >
                {storedContextLabel(context)}
              </Option>
            )}
          </Select>
        </OptionRow>
      )}
      {offer.draft && (
        <OptionRow
          label="Draft tokens"
          testId="model-defaults-draft"
          note={
            draftInvalid
              ? `Enter a whole number from 0 to ${offer.draft.max}.`
              : `Model default: ${offer.draft.modelDefault}. 0 turns drafting off; a change reloads the model.`
          }
        >
          <Input
            size="sm"
            type="text"
            value={draftText}
            placeholder={String(offer.draft.modelDefault)}
            disabled={disabled}
            color={draftInvalid ? 'danger' : 'neutral'}
            onChange={event => onDraftText(event.target.value)}
            sx={{ width: 112, flexShrink: 0, '& input::placeholder': { fontStyle: 'italic' } }}
            slotProps={{
              input: {
                inputMode: 'numeric',
                'aria-label': 'Draft tokens',
                'aria-invalid': draftInvalid,
                'aria-describedby': 'model-defaults-draft-note',
                'data-testid': 'model-defaults-draft-input',
              },
            }}
          />
        </OptionRow>
      )}
      {offer.keepAlive && (
        <OptionRow label="Keep loaded" testId="model-defaults-keep-alive" note="After its last request.">
          <Select
            size="sm"
            value={keepAlive === null ? 'default' : String(keepAlive)}
            disabled={disabled}
            onChange={(_event, value) =>
              onKeepAlive(KEEP_ALIVE_CHOICES.find(choice => String(choice) === value) ?? null)
            }
            sx={{ width: 180, flexShrink: 0 }}
            slotProps={{
              button: { 'aria-label': 'Keep loaded', 'data-testid': 'model-defaults-keep-alive-select' },
            }}
          >
            <Option value="default" data-testid="model-defaults-keep-alive-option-default">
              Server default
            </Option>
            {KEEP_ALIVE_CHOICES.map(choice => (
              <Option key={choice} value={String(choice)} data-testid={`model-defaults-keep-alive-option-${choice}`}>
                {KEEP_ALIVE_LABELS[choice]}
              </Option>
            ))}
          </Select>
        </OptionRow>
      )}
      {offer.kvCache && (
        <OptionRow
          label="KV cache"
          testId="model-defaults-kv-cache"
          note={
            offer.kvCache.type === 'f16'
              ? "Ollama's default, or what Desktop assumes when it can't read the server's settings. Set it for the whole server under Settings, Model servers, Launch settings, for an Ollama that Desktop starts."
              : 'Set for the whole server with OLLAMA_KV_CACHE_TYPE, which this Ollama runs with.'
          }
        >
          <Typography level="body-sm" sx={{ flexShrink: 0 }} data-testid="model-defaults-kv-cache-value">
            {offer.kvCache.type}
          </Typography>
        </OptionRow>
      )}
    </>
  );
}
