import Box from '@mui/joy/Box';
import Button from '@mui/joy/Button';
import Input from '@mui/joy/Input';
import Link from '@mui/joy/Link';
import Modal from '@mui/joy/Modal';
import Sheet from '@mui/joy/Sheet';
import Stack from '@mui/joy/Stack';
import Typography from '@mui/joy/Typography';
import { useEffect, useId, useRef, useState } from 'react';
import type { ChatModelOption, ReasoningEffortSetting } from '@shared/chat';
import type { ModelSettings } from '@shared/modelSettings';
import { turnEffortSetting, turnGeneration, turnThinks } from '@shared/modelDefaults';
import {
  effectiveControls,
  effortSent,
  GENERATION_FIELDS,
  GENERATION_LABELS,
  requestGeneration,
  type GenerationField,
  type GenerationSettings,
  type NumericControl,
} from '@shared/generation';

const WIDTH = 360;
const numberFormat = new Intl.NumberFormat('en-US', { maximumFractionDigits: 3 });

function shown(value: number | undefined): string {
  return value === undefined ? '' : String(value);
}

function defaultText(control: NumericControl, fallback: number | undefined): string {
  if (fallback !== undefined) return `Model default: ${numberFormat.format(fallback)}`;
  return control.unlimitedDefault ? 'Model default: no limit' : 'Model default';
}

/** The line under a field: its default or lock, a stored value this model adjusts, and whether thinking counts. */
function noteFor(
  control: NumericControl,
  fallback: number | undefined,
  stored: number | undefined,
  sent: number | undefined
): string {
  if (control.locked) return control.locked.reason;
  const parts = [defaultText(control, fallback)];
  if (stored !== undefined && sent !== undefined && sent !== stored) {
    parts.push(`Saved as ${numberFormat.format(stored)}, sent as ${numberFormat.format(sent)} on this model`);
  }
  if (control.includesThinking) parts.push('Thinking counts toward it');
  return `${parts.join('. ')}.`;
}

/**
 * One override. It shows what the next turn sends; a typed number is clamped into the control's
 * range when committed, and blank is the model default. A field left as shown commits nothing.
 */
function FieldRow({
  field,
  control,
  fallback,
  stored,
  sent,
  autoFocus,
  disabled,
  onCommit,
}: {
  field: GenerationField;
  control: NumericControl;
  /** What a blank field sends: the Models-screen default, catalog sampling or the control's own. */
  fallback: number | undefined;
  stored: number | undefined;
  sent: number | undefined;
  autoFocus: boolean;
  disabled?: boolean;
  onCommit: (value: number | undefined) => Promise<boolean | void>;
}) {
  const noteId = useId();
  const [draft, setDraft] = useState(shown(sent));
  // The value last asked for, so Enter and the blur after it save once.
  const committed = useRef<string | null>(null);
  const attempt = useRef(0);
  const discarded = useRef(false);
  // Whether the field was typed in since it last showed what the turn sends.
  const edited = useRef(false);
  useEffect(() => {
    committed.current = null;
    edited.current = false;
    setDraft(shown(sent));
  }, [sent]);
  const locked = control.locked;

  const save = (value: number | undefined) => {
    if (shown(value) === committed.current) return;
    committed.current = shown(value);
    const mine = ++attempt.current;
    void onCommit(value).then(saved => {
      if (saved !== false || mine !== attempt.current) return;
      committed.current = null;
      setDraft(shown(sent));
    });
  };

  const commit = (input: HTMLInputElement) => {
    if (discarded.current) return;
    // A number input reads text it cannot parse, such as "1e" or "-", as blank, which is not a clear.
    if (input.validity.badInput) {
      input.value = shown(sent);
      setDraft(shown(sent));
      return;
    }
    const text = draft.trim();
    if (!edited.current && text === shown(sent)) return;
    edited.current = false;
    if (!text) {
      if (stored !== undefined) save(undefined);
      return;
    }
    const next = requestGeneration({ [field]: Number(text) }, { [field]: control })[field];
    setDraft(shown(next ?? sent));
    // Against what is stored, so typing the value this model adjusts a stored one to saves it.
    if (next !== undefined && next !== stored) save(next);
  };

  return (
    <Stack
      direction="row"
      alignItems="center"
      justifyContent="space-between"
      spacing={2}
      sx={{ py: 0.5 }}
      data-testid={`generation-settings-${field}-row`}
    >
      <Stack sx={{ minWidth: 0 }}>
        <Typography level="body-sm">{GENERATION_LABELS[field]}</Typography>
        <Typography level="body-xs" textColor="text.tertiary" sx={{ maxWidth: 200 }}>
          <span id={noteId} data-testid={`generation-settings-${field}-default`}>
            {noteFor(control, fallback, stored, sent)}
          </span>
          {!locked && stored !== undefined && (
            <Link
              component="button"
              level="body-xs"
              disabled={disabled}
              onClick={() => onCommit(undefined)}
              aria-label={`Reset ${GENERATION_LABELS[field]}`}
              sx={{ ml: 1 }}
              data-testid={`generation-settings-${field}-reset-btn`}
            >
              Reset
            </Link>
          )}
        </Typography>
      </Stack>
      <Input
        size="sm"
        type="number"
        variant={locked ? 'soft' : 'outlined'}
        value={locked ? String(locked.value) : draft}
        placeholder={fallback !== undefined ? String(fallback) : control.unlimitedDefault ? 'No limit' : 'Default'}
        disabled={disabled}
        readOnly={locked !== undefined}
        autoFocus={autoFocus}
        onChange={event => {
          edited.current = true;
          setDraft(event.target.value);
        }}
        onBlur={locked ? undefined : event => commit(event.currentTarget)}
        onKeyDown={event => {
          if (event.key === 'Enter' && !locked) commit(event.currentTarget);
          // Escape closes the dialog, and the typed value goes with it even if a blur fires first.
          if (event.key === 'Escape' && !event.nativeEvent.isComposing) discarded.current = true;
        }}
        sx={{
          width: 112,
          flexShrink: 0,
          '--Input-placeholderColor': 'var(--joy-palette-text-tertiary)',
          '& input::placeholder': { fontStyle: 'italic' },
          ...(locked ? { color: 'text.tertiary' } : {}),
        }}
        slotProps={{
          input: {
            min: control.min,
            max: control.max,
            step: control.step,
            'aria-label': GENERATION_LABELS[field],
            'aria-describedby': noteId,
            'data-testid': `generation-settings-${field}-input`,
          },
        }}
      />
    </Stack>
  );
}

/**
 * This conversation's sampling and output overrides, beside the effort picker: a button that opens
 * a dialog of the fields the model's `controls` list. The button and every field show what the next
 * turn sends, which across a model switch can differ from what is stored (see requestGeneration).
 * `modelDefaults` are the model's defaults from the Models screen, which a blank field sends.
 * `onChange` answers false when the set was not saved.
 */
export function GenerationSettingsPicker({
  model,
  generation,
  modelDefaults,
  effort = 'default',
  disabled,
  onChange,
}: {
  model: ChatModelOption | undefined;
  generation: GenerationSettings | undefined;
  modelDefaults?: ModelSettings;
  effort?: ReasoningEffortSetting;
  disabled?: boolean;
  onChange: (generation: GenerationSettings) => Promise<boolean> | void;
}) {
  const titleId = useId();
  const introId = useId();
  const anchor = useRef<HTMLButtonElement>(null);
  const [place, setPlace] = useState<{ left: number; bottom: number; maxHeight: number } | null>(null);
  // The set last sent, so an edit made before main answers builds on it rather than on stale props.
  const pending = useRef<GenerationSettings | undefined>(undefined);
  useEffect(() => {
    pending.current = undefined;
  }, [generation]);

  const effortSetting = turnEffortSetting(effort, modelDefaults, model);
  const sentEffort = effortSent(effortSetting, model?.controls?.effort?.levels ?? []);
  const inherited = turnGeneration(undefined, modelDefaults, model, turnThinks(effortSetting, model, sentEffort));
  const controls = effectiveControls(model?.controls, { ...inherited, ...generation });
  const fields = GENERATION_FIELDS.flatMap(field => {
    const control = controls?.[field];
    return control ? [{ field, control }] : [];
  });
  if (fields.length === 0) return null;

  const sent = requestGeneration(generation, controls);
  const fallbacks = requestGeneration(inherited, controls);
  const applied = fields.filter(({ field }) => generation?.[field] !== undefined && sent[field] !== undefined).length;
  const resettable = fields.some(({ field, control }) => !control.locked && generation?.[field] !== undefined);
  const firstEditable = fields.find(({ control }) => !control.locked)?.field;

  const save = (next: GenerationSettings) => {
    pending.current = next;
    return Promise.resolve(onChange(next)).then(saved => {
      if (saved === false && pending.current === next) pending.current = undefined;
      return saved;
    });
  };
  const set = (field: GenerationField, value: number | undefined) => {
    const next: GenerationSettings = { ...(pending.current ?? generation) };
    if (value === undefined) delete next[field];
    else next[field] = value;
    return save(next);
  };
  // Overrides for fields this model does not show stay for the model that does.
  const resetShown = () => {
    const next: GenerationSettings = { ...(pending.current ?? generation) };
    for (const { field, control } of fields) if (!control.locked) delete next[field];
    void save(next);
  };
  const open = () => {
    const rect = anchor.current?.getBoundingClientRect();
    if (!rect) return;
    setPlace({
      left: Math.max(8, Math.min(rect.left, window.innerWidth - WIDTH - 8)),
      bottom: window.innerHeight - rect.top + 6,
      maxHeight: Math.max(160, rect.top - 16),
    });
  };

  return (
    <>
      <Button
        ref={anchor}
        size="sm"
        variant="plain"
        color="neutral"
        disabled={disabled}
        aria-haspopup="dialog"
        aria-expanded={place !== null}
        onClick={open}
        sx={{ fontWeight: 'normal', minWidth: 0 }}
        data-testid="generation-settings-btn"
      >
        <Typography level="body-xs" noWrap textColor="inherit">
          Params: {applied > 0 ? `${applied} set` : 'Default'}
        </Typography>
      </Button>
      <Modal
        open={place !== null}
        onClose={() => setPlace(null)}
        slotProps={{ backdrop: { sx: { backgroundColor: 'transparent', backdropFilter: 'none' } } }}
      >
        <Sheet
          role="dialog"
          aria-modal="true"
          aria-labelledby={titleId}
          aria-describedby={introId}
          tabIndex={-1}
          variant="outlined"
          sx={{
            position: 'fixed',
            left: place?.left,
            bottom: place?.bottom,
            maxHeight: place?.maxHeight,
            width: WIDTH,
            overflowY: 'auto',
            borderRadius: 'md',
            boxShadow: 'md',
            px: 1.5,
            py: 1,
            outline: 'none',
          }}
          data-testid="generation-settings-menu"
        >
          <Typography id={titleId} level="title-sm">
            Params
          </Typography>
          <Typography id={introId} level="body-xs" textColor="text.tertiary" sx={{ pb: 0.75 }}>
            For this chat only. A blank field uses the model default.
          </Typography>
          {fields.map(({ field, control }) => (
            <FieldRow
              key={field}
              field={field}
              control={control}
              fallback={fallbacks[field] ?? control.default}
              stored={generation?.[field]}
              sent={sent[field]}
              autoFocus={field === firstEditable}
              disabled={disabled}
              onCommit={value => set(field, value)}
            />
          ))}
          {resettable && (
            <Box sx={{ display: 'flex', justifyContent: 'flex-end', pt: 0.5 }}>
              <Button
                size="sm"
                variant="plain"
                color="neutral"
                disabled={disabled}
                onClick={resetShown}
                data-testid="generation-settings-reset-all-btn"
              >
                <Typography level="body-xs" textColor="inherit">
                  Reset all
                </Typography>
              </Button>
            </Box>
          )}
        </Sheet>
      </Modal>
    </>
  );
}
