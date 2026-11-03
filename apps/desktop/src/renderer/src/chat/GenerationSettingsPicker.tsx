import Box from '@mui/joy/Box';
import Button from '@mui/joy/Button';
import Dropdown from '@mui/joy/Dropdown';
import Input from '@mui/joy/Input';
import Link from '@mui/joy/Link';
import Menu from '@mui/joy/Menu';
import MenuButton from '@mui/joy/MenuButton';
import Stack from '@mui/joy/Stack';
import Typography from '@mui/joy/Typography';
import { useEffect, useState } from 'react';
import type { ChatModelOption } from '@shared/chat';
import {
  GENERATION_FIELDS,
  requestGeneration,
  type GenerationField,
  type GenerationSettings,
  type NumericControl,
} from '@shared/generation';

const LABELS: Record<GenerationField, string> = {
  temperature: 'Temperature',
  topP: 'Top P',
  topK: 'Top K',
  minP: 'Min P',
  repeatPenalty: 'Repeat penalty',
  maxOutputTokens: 'Max output tokens',
  thinkingBudgetTokens: 'Thinking budget',
};

const numberFormat = new Intl.NumberFormat('en-US', { maximumFractionDigits: 3 });

function shown(value: number | undefined): string {
  return value === undefined ? '' : String(value);
}

/** One override: blank is the model default, a number is clamped into the control's range when it is committed. */
function FieldRow({
  field,
  control,
  value,
  disabled,
  onCommit,
}: {
  field: GenerationField;
  control: NumericControl;
  value: number | undefined;
  disabled?: boolean;
  onCommit: (value: number | undefined) => void;
}) {
  const [draft, setDraft] = useState(shown(value));
  useEffect(() => setDraft(shown(value)), [value]);
  const locked = control.locked;

  const commit = () => {
    const text = draft.trim();
    if (!text) {
      if (value !== undefined) onCommit(undefined);
      return;
    }
    const next = requestGeneration({ [field]: Number(text) }, { [field]: control })[field];
    setDraft(shown(next ?? value));
    if (next !== undefined && next !== value) onCommit(next);
  };

  const fallback =
    control.default === undefined ? 'Model default' : `Model default: ${numberFormat.format(control.default)}`;
  return (
    <Stack
      direction="row"
      alignItems="center"
      justifyContent="space-between"
      spacing={2}
      sx={{ px: 1, py: 0.5 }}
      data-testid={`generation-settings-${field}-row`}
    >
      <Stack sx={{ minWidth: 0 }}>
        <Typography level="body-sm">{LABELS[field]}</Typography>
        <Typography
          level="body-xs"
          textColor="text.tertiary"
          sx={{ maxWidth: 200 }}
          data-testid={`generation-settings-${field}-default`}
        >
          {locked ? locked.reason : fallback}
          {!locked && value !== undefined && (
            <Link
              component="button"
              level="body-xs"
              disabled={disabled}
              onClick={() => onCommit(undefined)}
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
        value={locked ? String(locked.value) : draft}
        placeholder={control.default === undefined ? 'Default' : String(control.default)}
        disabled={disabled || locked !== undefined}
        onChange={event => setDraft(event.target.value)}
        onBlur={commit}
        onKeyDown={event => {
          if (event.key === 'Enter') commit();
          // Joy's menu reads printable and arrow keys as list navigation; Escape still closes it.
          if (event.key !== 'Escape') event.stopPropagation();
        }}
        sx={{ width: 112, flexShrink: 0 }}
        slotProps={{
          input: {
            min: control.min,
            max: control.max,
            step: control.step,
            'aria-label': LABELS[field],
            'data-testid': `generation-settings-${field}-input`,
          },
        }}
      />
    </Stack>
  );
}

/**
 * This conversation's sampling and output overrides, beside the effort picker. Draws only the
 * fields the model's `controls` list; a blank field sends nothing, so the model's own default applies.
 */
export function GenerationSettingsPicker({
  model,
  generation,
  disabled,
  onChange,
}: {
  model: ChatModelOption | undefined;
  generation: GenerationSettings | undefined;
  disabled?: boolean;
  onChange: (generation: GenerationSettings) => void;
}) {
  const controls = model?.controls;
  const fields = GENERATION_FIELDS.flatMap(field => {
    const control = controls?.[field];
    return control ? [{ field, control }] : [];
  });
  if (fields.length === 0) return null;

  const applied = Object.keys(requestGeneration(generation, controls)).length;
  const touched = fields.some(({ field, control }) => !control.locked && generation?.[field] !== undefined);
  const set = (field: GenerationField, value: number | undefined) => {
    const next: GenerationSettings = { ...generation };
    if (value === undefined) delete next[field];
    else next[field] = value;
    onChange(next);
  };

  return (
    <Dropdown>
      <MenuButton
        size="sm"
        variant="plain"
        color="neutral"
        disabled={disabled}
        sx={{ fontWeight: 'normal', minWidth: 0 }}
        slotProps={{ root: { 'data-testid': 'generation-settings-btn' } }}
      >
        <Typography level="body-xs" noWrap textColor="inherit">
          Params: {applied > 0 ? `${applied} set` : 'Default'}
        </Typography>
      </MenuButton>
      <Menu size="sm" placement="top-start" sx={{ minWidth: 320, py: 0.5 }} data-testid="generation-settings-menu">
        <Typography level="body-xs" textColor="text.tertiary" sx={{ px: 1, pt: 0.5, pb: 0.75 }}>
          For this chat only. A blank field uses the model default.
        </Typography>
        {fields.map(({ field, control }) => (
          <FieldRow
            key={field}
            field={field}
            control={control}
            value={generation?.[field]}
            disabled={disabled}
            onCommit={value => set(field, value)}
          />
        ))}
        {touched && (
          <Box sx={{ display: 'flex', justifyContent: 'flex-end', px: 0.5, pt: 0.5 }}>
            <Button
              size="sm"
              variant="plain"
              color="neutral"
              disabled={disabled}
              onClick={() => onChange({})}
              data-testid="generation-settings-reset-all-btn"
            >
              <Typography level="body-xs" textColor="inherit">
                Reset all
              </Typography>
            </Button>
          </Box>
        )}
      </Menu>
    </Dropdown>
  );
}
