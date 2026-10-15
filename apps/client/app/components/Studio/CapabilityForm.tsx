import { useRef, type ReactNode } from 'react';
import {
  Alert,
  Box,
  Button,
  FormControl,
  FormLabel,
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
import type { CapabilityControl, CapabilityField, CapabilityOption, TextField } from './capabilityFields';
import { insertSnippet } from './insertSnippet';

type CapabilityFormProps = {
  // Every data-testid in the form starts with this, e.g. `video-form-<field id>-select`.
  testIdPrefix: string;
  models: readonly CapabilityOption[];
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

const Control = ({ field, testId }: { field: CapabilityControl; testId: string }) => {
  switch (field.kind) {
    case 'text':
      return <TextControl field={field} testId={testId} />;
    case 'segmented':
      return (
        <FormControl disabled={field.disabled}>
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
              <Button key={option.value} value={option.value} data-testid={`${testId}-${option.value}-btn`}>
                {option.label}
              </Button>
            ))}
          </ToggleButtonGroup>
        </FormControl>
      );
    case 'select':
      return (
        <FormControl disabled={field.disabled}>
          <FormLabel>{field.label}</FormLabel>
          <Select
            value={field.value}
            onChange={(_event, value) => {
              if (isOption(field.options, value)) field.onChange(value);
            }}
            slotProps={{ button: { 'data-testid': `${testId}-select` } }}
          >
            {field.options.map(option => (
              <Option key={option.value} value={option.value}>
                {option.label}
              </Option>
            ))}
          </Select>
        </FormControl>
      );
    case 'range':
      return (
        <FormControl disabled={field.disabled}>
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
          slotProps={{ input: { 'data-testid': `${testId}-switch` } }}
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
 * `-name` (image).
 */
const CapabilityForm = ({
  testIdPrefix,
  models,
  modelId,
  onModelChange,
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
      <FormControl>
        <FormLabel>Model</FormLabel>
        <Select
          value={modelId}
          onChange={(_event, value) => {
            if (isOption(models, value)) onModelChange(value);
          }}
          slotProps={{ button: { 'data-testid': testIdOf('model-select') } }}
        >
          {models.map(model => (
            <Option key={model.value} value={model.value}>
              {model.label}
            </Option>
          ))}
        </Select>
      </FormControl>

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
                <Control field={member} testId={testIdOf(member.id)} />
              </Box>
            ))}
          </Stack>
        ) : (
          <Control key={field.id} field={field} testId={testIdOf(field.id)} />
        )
      )}

      <Stack direction="row" justifyContent="space-between" alignItems="center" gap={2}>
        <Typography level="body-sm" data-testid={testIdOf('estimate')}>
          {estimateCredits === null
            ? 'Cost estimate unavailable'
            : `Estimated cost: ${formatCredits(estimateCredits)} credits`}
        </Typography>
        <Button loading={isSubmitting} disabled={!canSubmit} onClick={onSubmit} data-testid={testIdOf('submit-btn')}>
          {submitLabel}
        </Button>
      </Stack>

      {children}
    </Stack>
  );
};

export default CapabilityForm;
