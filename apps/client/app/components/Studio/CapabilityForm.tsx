import { useRef, type ReactNode } from 'react';
import {
  Alert,
  Box,
  Button,
  Chip,
  FormControl,
  FormLabel,
  IconButton,
  Option,
  Select,
  Slider,
  Stack,
  Switch,
  Textarea,
  ToggleButtonGroup,
  Typography,
} from '@mui/joy';
import { formatCredits } from '@client/app/utils/formatUsd';
import CloseIcon from '@mui/icons-material/Close';
import {
  hasInvalidField,
  type AspectField,
  type CapabilityControl,
  type CapabilityField,
  type CapabilityOption,
  type ChipsField,
  type ReferencesField,
  type TextField,
} from './capabilityFields';
import { insertSnippet } from './insertSnippet';
import StudioModelPicker from './StudioModelPicker';
import type { StudioModelCard } from './studioModelCard';

// The model picker: a dropdown of names, or (Create v2) a compact row with a panel of ranked model cards.
type ModelPickerProps =
  | { models: readonly CapabilityOption[]; modelCards?: never }
  | { modelCards: readonly StudioModelCard[]; models?: never };

type CapabilityFormProps = ModelPickerProps & {
  // Every data-testid in the form starts with this, e.g. `video-form-<field id>-select`.
  testIdPrefix: string;
  modelId: string;
  onModelChange: (modelId: string) => void;
  // What the form moved when the model changed; shown so a switch never silently alters a value.
  changes: readonly string[];
  fields: readonly CapabilityField[];
  estimateCredits: number | null;
  submitLabel: string;
  canSubmit: boolean;
  isSubmitting: boolean;
  onSubmit: () => void;
  // Modality-owned UI that is not a field, such as an image picker modal.
  children?: ReactNode;
};

const isOption = (options: readonly CapabilityOption[], value: string | null): value is string =>
  value !== null && options.some(option => option.value === value);

const snippetSlug = (snippet: string): string =>
  snippet
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');

const TextControl = ({ field, testId }: { field: TextField; testId: string }) => {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const insert = (snippet: string) => {
    const textarea = textareaRef.current;
    const start = textarea?.selectionStart ?? field.value.length;
    const end = textarea?.selectionEnd ?? field.value.length;
    const next = insertSnippet(field.value, snippet, start, end);
    if (next.value.length > field.maxLength) return;
    field.onChange(next.value);
    // After React writes the new value, put the caret right after the inserted tag so typing continues there.
    requestAnimationFrame(() => {
      textarea?.focus();
      textarea?.setSelectionRange(next.caret, next.caret);
    });
  };

  return (
    <FormControl disabled={field.disabled}>
      <FormLabel>{field.label}</FormLabel>
      {field.snippets && field.snippets.length > 0 && (
        <Stack direction="row" gap={1} flexWrap="wrap" sx={{ mb: 1 }}>
          {field.snippets.map(snippet => (
            <Button
              key={snippet}
              size="sm"
              variant="outlined"
              color="neutral"
              disabled={field.disabled}
              onClick={() => insert(snippet)}
              data-testid={`${testId}-${snippetSlug(snippet)}-snippet-btn`}
            >
              {snippet}
            </Button>
          ))}
        </Stack>
      )}
      <Textarea
        minRows={field.minRows ?? 3}
        value={field.value}
        placeholder={field.placeholder}
        onChange={event => field.onChange(event.target.value)}
        slotProps={{ textarea: { ref: textareaRef, 'data-testid': `${testId}-input`, maxLength: field.maxLength } }}
      />
      <Typography level="body-xs" sx={{ alignSelf: 'flex-end' }}>
        {field.value.trim().length}/{field.maxLength}
      </Typography>
    </FormControl>
  );
};

// Longest side of an aspect tile's shape, in px.
const ASPECT_TILE_SIZE = 28;

const aspectShape = (value: string): { width: number; height: number } => {
  const [width, height] = value.split(':').map(Number);
  if (!width || !height) return { width: ASPECT_TILE_SIZE, height: ASPECT_TILE_SIZE };
  const scale = ASPECT_TILE_SIZE / Math.max(width, height);
  return { width: Math.round(width * scale), height: Math.round(height * scale) };
};

const AspectControl = ({ field, testId }: { field: AspectField; testId: string }) => (
  <FormControl disabled={field.disabled} error={field.invalidReason !== undefined}>
    <FormLabel>{field.label}</FormLabel>
    <ToggleButtonGroup
      size="sm"
      value={field.value}
      disabled={field.disabled}
      onChange={(_event, value) => {
        if (isOption(field.options, value)) field.onChange(value);
      }}
      data-testid={`${testId}-toggle`}
      sx={{ flexWrap: 'wrap' }}
    >
      {field.options.map(option => {
        const shape = aspectShape(option.value);
        return (
          <Button
            key={option.value}
            value={option.value}
            color={option.invalid ? 'danger' : 'neutral'}
            data-testid={`${testId}-${option.value}-btn`}
            data-invalid={option.invalid === true}
            sx={{ flexDirection: 'column', gap: 0.5, minWidth: 56, py: 1 }}
          >
            <Box
              aria-hidden
              sx={{
                width: shape.width,
                height: shape.height,
                border: '2px solid',
                borderColor: 'currentColor',
                borderRadius: '3px',
              }}
            />
            <Typography level="body-xs" textColor="inherit">
              {option.label}
            </Typography>
          </Button>
        );
      })}
    </ToggleButtonGroup>
  </FormControl>
);

const ReferencesControl = ({ field, testId }: { field: ReferencesField; testId: string }) => (
  <FormControl disabled={field.disabled} error={field.invalidReason !== undefined}>
    <FormLabel>
      {field.label} ({field.files.length}/{field.max})
    </FormLabel>
    <Stack direction="row" gap={1} flexWrap="wrap" alignItems="center">
      {field.files.map(file => (
        <Chip
          key={file.fileId}
          variant="soft"
          data-testid={`${testId}-file-${file.fileId}`}
          endDecorator={
            <IconButton
              size="sm"
              variant="plain"
              aria-label={`Remove ${file.fileName}`}
              disabled={field.disabled}
              onClick={() => field.onRemove(file.fileId)}
              data-testid={`${testId}-remove-${file.fileId}-btn`}
            >
              <CloseIcon fontSize="small" />
            </IconButton>
          }
        >
          {file.fileName}
        </Chip>
      ))}
      {field.files.length < field.max && (
        <Button
          size="sm"
          variant="outlined"
          disabled={field.disabled}
          onClick={field.onAdd}
          data-testid={`${testId}-add-btn`}
        >
          Add image
        </Button>
      )}
    </Stack>
  </FormControl>
);

// Diameter of a chip's swatch dot, in px.
const CHIP_SWATCH_SIZE = 14;

const ChipsControl = ({ field, testId }: { field: ChipsField; testId: string }) => (
  <FormControl disabled={field.disabled}>
    <FormLabel>{field.label}</FormLabel>
    <Stack direction="row" gap={1} flexWrap="wrap" data-testid={`${testId}-chips`}>
      {field.options.map(option => {
        const selected = option.value === field.value;
        return (
          <Chip
            key={option.value}
            size="md"
            variant={selected ? 'solid' : 'outlined'}
            color={selected ? 'primary' : 'neutral'}
            disabled={field.disabled || option.disabled}
            onClick={() => field.onChange(selected ? null : option.value)}
            startDecorator={
              option.swatch && (
                <Box
                  aria-hidden
                  sx={{
                    width: CHIP_SWATCH_SIZE,
                    height: CHIP_SWATCH_SIZE,
                    borderRadius: '50%',
                    border: '1px solid',
                    borderColor: 'neutral.outlinedBorder',
                    background: `linear-gradient(135deg, ${option.swatch.from}, ${option.swatch.to})`,
                  }}
                />
              )
            }
            slotProps={{
              action: {
                'data-testid': `${testId}-${option.value}-chip`,
                'aria-label': option.label,
                'aria-pressed': selected,
              },
            }}
          >
            {option.label}
          </Chip>
        );
      })}
    </Stack>
  </FormControl>
);

/** The reason a kept value does not fit the model, with its one-click fix. */
const InvalidReason = ({ field, testId }: { field: CapabilityControl; testId: string }) => {
  if (field.invalidReason === undefined) return null;
  return (
    <Stack direction="row" gap={1} alignItems="center" flexWrap="wrap" sx={{ mt: 0.5 }}>
      <Typography level="body-xs" color="danger" data-testid={`${testId}-invalid`}>
        {field.invalidReason}
      </Typography>
      {field.fix && (
        <Button size="sm" variant="plain" color="danger" onClick={field.fix.apply} data-testid={`${testId}-fix-btn`}>
          {field.fix.label}
        </Button>
      )}
    </Stack>
  );
};

const FieldControl = ({ field, testId }: { field: CapabilityControl; testId: string }) => (
  <Box>
    <Control field={field} testId={testId} />
    <InvalidReason field={field} testId={testId} />
  </Box>
);

const Control = ({ field, testId }: { field: CapabilityControl; testId: string }) => {
  switch (field.kind) {
    case 'text':
      return <TextControl field={field} testId={testId} />;
    case 'segmented':
      return (
        <FormControl disabled={field.disabled} error={field.invalidReason !== undefined}>
          <FormLabel>{field.label}</FormLabel>
          <ToggleButtonGroup
            size="sm"
            value={field.value}
            disabled={field.disabled}
            onChange={(_event, value) => {
              if (isOption(field.options, value)) field.onChange(value);
            }}
            data-testid={`${testId}-toggle`}
          >
            {field.options.map(option => (
              <Button
                key={option.value}
                value={option.value}
                color={option.invalid ? 'danger' : 'neutral'}
                data-testid={`${testId}-${option.value}-btn`}
                data-invalid={option.invalid === true}
              >
                {option.label}
              </Button>
            ))}
          </ToggleButtonGroup>
        </FormControl>
      );
    case 'select':
      return (
        <FormControl disabled={field.disabled} error={field.invalidReason !== undefined}>
          <FormLabel>{field.label}</FormLabel>
          <Select
            value={field.value}
            onChange={(_event, value) => {
              if (isOption(field.options, value)) field.onChange(value);
            }}
            slotProps={{ button: { 'data-testid': `${testId}-select` } }}
          >
            {field.options.map(option => (
              <Option key={option.value} value={option.value} color={option.invalid ? 'danger' : 'neutral'}>
                {option.label}
              </Option>
            ))}
          </Select>
        </FormControl>
      );
    case 'aspect':
      return <AspectControl field={field} testId={testId} />;
    case 'references':
      return <ReferencesControl field={field} testId={testId} />;
    case 'chips':
      return <ChipsControl field={field} testId={testId} />;
    case 'range':
      return (
        <FormControl disabled={field.disabled} error={field.invalidReason !== undefined}>
          <FormLabel>{field.label}</FormLabel>
          <Slider
            min={field.min}
            max={field.max}
            step={field.step}
            value={field.value}
            disabled={field.disabled}
            valueLabelDisplay="auto"
            onChange={(_event, value) => {
              if (typeof value === 'number') field.onChange(value);
            }}
            slotProps={{ input: { 'data-testid': `${testId}-slider` } }}
          />
        </FormControl>
      );
    case 'switch':
      return (
        <Switch
          checked={field.checked}
          disabled={field.disabled}
          onChange={event => field.onChange(event.target.checked)}
          endDecorator={field.label}
          slotProps={{ input: { 'data-testid': `${testId}-switch`, 'aria-label': field.label } }}
        />
      );
    case 'note':
      return (
        <Typography level="body-sm" data-testid={`${testId}-note`}>
          {field.label}
        </Typography>
      );
    case 'image':
      return (
        <FormControl disabled={field.disabled}>
          <FormLabel>{field.label}</FormLabel>
          <Stack direction="row" gap={1} alignItems="center">
            <Button
              size="sm"
              variant="outlined"
              disabled={field.disabled}
              onClick={field.onPick}
              data-testid={`${testId}-pick-btn`}
            >
              {field.fileName !== null ? 'Change image' : 'Choose image'}
            </Button>
            {field.fileName !== null && (
              <Typography level="body-sm" data-testid={`${testId}-name`}>
                {field.fileName}
              </Typography>
            )}
          </Stack>
        </FormControl>
      );
    default: {
      // A new CapabilityControl kind must be handled above or this assignment fails to compile; if a kind is ever
      // cast past the type check, render nothing rather than hand React an object child and crash the route.
      const unhandled: never = field;
      void unhandled;
      return null;
    }
  }
};

/**
 * The Studio form for any modality: a model picker, the fields the selected model's capabilities produce, the credit
 * estimate and the submit button. Field test ids are `<prefix>-<id>` plus a per-kind suffix: `-input` (text),
 * `-toggle` and `-<value>-btn` (segmented), `-select`, `-slider` (range), `-switch`, `-note`, `-pick-btn` and
 * `-name` (image), `-<value>-btn` (aspect), `-add-btn`, `-file-<id>` and `-remove-<id>-btn` (references), `-chips` and
 * `-<value>-chip` (chips). A field holding a value the model does not take adds `-invalid` and, with a fix,
 * `-fix-btn`, and holds submit.
 */
const CapabilityForm = ({
  testIdPrefix,
  models,
  modelId,
  onModelChange,
  modelCards,
  changes,
  fields,
  estimateCredits,
  submitLabel,
  canSubmit,
  isSubmitting,
  onSubmit,
  children,
}: CapabilityFormProps) => {
  const testIdOf = (id: string) => `${testIdPrefix}-${id}`;

  return (
    <Stack gap={2} data-testid={testIdPrefix}>
      {modelCards ? (
        <FormControl>
          <FormLabel>Model</FormLabel>
          <StudioModelPicker
            testIdPrefix={testIdPrefix}
            cards={modelCards}
            selectedId={modelId}
            onSelect={onModelChange}
          />
        </FormControl>
      ) : (
        <FormControl>
          <FormLabel>Model</FormLabel>
          <Select
            value={modelId}
            onChange={(_event, value) => {
              if (models && isOption(models, value)) onModelChange(value);
            }}
            slotProps={{ button: { 'data-testid': testIdOf('model-select') } }}
          >
            {models?.map(model => (
              <Option key={model.value} value={model.value}>
                {model.label}
              </Option>
            ))}
          </Select>
        </FormControl>
      )}

      {changes.length > 0 && (
        <Alert color="warning" variant="soft" data-testid={testIdOf('changes')}>
          <Stack>
            {changes.map(change => (
              <Typography key={change} level="body-sm">
                {change}
              </Typography>
            ))}
          </Stack>
        </Alert>
      )}

      {fields.map(field =>
        field.kind === 'group' ? (
          <Stack key={field.id} direction={{ xs: 'column', sm: 'row' }} gap={2}>
            {field.fields.map(member => (
              <Box key={member.id} sx={{ flex: 1 }}>
                <FieldControl field={member} testId={testIdOf(member.id)} />
              </Box>
            ))}
          </Stack>
        ) : (
          <FieldControl key={field.id} field={field} testId={testIdOf(field.id)} />
        )
      )}

      <Stack direction="row" justifyContent="space-between" alignItems="center" gap={2}>
        <Typography level="body-sm" data-testid={testIdOf('estimate')}>
          {estimateCredits === null
            ? 'Cost estimate unavailable'
            : `Estimated cost: ${formatCredits(estimateCredits)} credits`}
        </Typography>
        <Button
          loading={isSubmitting}
          disabled={!canSubmit || hasInvalidField(fields)}
          onClick={onSubmit}
          data-testid={testIdOf('submit-btn')}
        >
          {submitLabel}
        </Button>
      </Stack>

      {children}
    </Stack>
  );
};

export default CapabilityForm;
