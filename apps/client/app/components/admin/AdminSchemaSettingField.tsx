import { useUpdateSettings } from '@client/app/hooks/data/settings';
import { getErrorMessage } from '@client/app/utils/error';
import type { SettingKey } from '@bike4mind/common';
import RestartAltIcon from '@mui/icons-material/RestartAlt';
import SaveIcon from '@mui/icons-material/Save';
import {
  Alert,
  Box,
  Button,
  FormControl,
  FormHelperText,
  FormLabel,
  Grid,
  IconButton,
  Input,
  Option,
  Select,
  Stack,
  Switch,
  Textarea,
  Tooltip,
  Typography,
} from '@mui/joy';
import { useMemo, useRef, useState } from 'react';
import { useSettingsDraft } from './SettingsDraftProvider';
import { AdminDialog } from './shared/AdminDialog';
import { SettingsSection } from './shared/SettingsSection';
import { useAdminSaveShortcut } from './shared/adminKeyboard';
import {
  describeFields,
  formatValue,
  getAtPath,
  numberRangeText,
  pathId,
  setAtPath,
  toConfigObject,
  validateConfig,
  type ConfigObject,
  type FieldSpec,
  type StructuredSetting,
} from './schemaSettingForm';

type SettingValue = Parameters<ReturnType<typeof useUpdateSettings>['mutateAsync']>[0]['value'];
type LeafField = Exclude<FieldSpec, { kind: 'group' }>;

const NONE_OPTION = '__none__';
const FIX_FIELDS = 'Fix the highlighted fields before saving.';

/** The stored value, which arrives as an object or as its JSON string, as a config object. */
function readStored(stored: unknown): ConfigObject {
  if (typeof stored !== 'string') return toConfigObject(stored);
  try {
    return toConfigObject(JSON.parse(stored));
  } catch {
    return {};
  }
}

const sameValue = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right);

const parseNumber = (text: string) => (text.trim() === '' ? NaN : Number(text));
const formatNumber = (value: unknown) => (typeof value === 'number' && !Number.isNaN(value) ? String(value) : '');

/**
 * A number input that keeps the admin's raw text while they type ("0." or an emptied field), and
 * reports NaN for text that is not a number so validation flags it instead of saving a guess.
 */
function NumberInput({
  field,
  value,
  testId,
  disabled,
  invalid,
  onChange,
}: {
  field: Extract<FieldSpec, { kind: 'number' }>;
  value: unknown;
  testId: string;
  disabled: boolean;
  invalid: boolean;
  onChange(next: number): void;
}) {
  const [text, setText] = useState(() => formatNumber(value));
  const [syncedValue, setSyncedValue] = useState(value);
  // Follow outside changes (reset to default, JSON view) without clobbering in-progress text
  // such as "0.", which already parses to the new value. Adjusting state during render is
  // React's pattern for state derived from a prop.
  if (!Object.is(syncedValue, value)) {
    setSyncedValue(value);
    if (!Object.is(parseNumber(text), value)) setText(formatNumber(value));
  }
  return (
    <Input
      type="number"
      value={text}
      disabled={disabled}
      error={invalid}
      onChange={event => {
        setText(event.target.value);
        onChange(parseNumber(event.target.value));
      }}
      slotProps={{
        input: {
          'data-testid': testId,
          min: field.min ?? field.exclusiveMin,
          max: field.max,
          step: field.integer ? 1 : 'any',
          inputMode: field.integer ? 'numeric' : 'decimal',
        },
      }}
      sx={{ fontVariantNumeric: 'tabular-nums' }}
    />
  );
}

function FieldControl({
  field,
  value,
  testId,
  disabled,
  invalid,
  onChange,
}: {
  field: LeafField;
  value: unknown;
  testId: string;
  disabled: boolean;
  invalid: boolean;
  onChange(next: unknown): void;
}) {
  switch (field.kind) {
    case 'enum':
      return (
        <Select
          value={value === null ? NONE_OPTION : typeof value === 'string' ? value : null}
          disabled={disabled}
          color={invalid ? 'danger' : 'neutral'}
          onChange={(_, next) => onChange(next === NONE_OPTION ? null : next)}
          slotProps={{ button: { 'data-testid': testId } }}
        >
          {field.nullable && (
            <Option value={NONE_OPTION} data-testid={`${testId}-option-none`}>
              None
            </Option>
          )}
          {field.options.map(option => (
            <Option key={option} value={option} data-testid={`${testId}-option-${option}`}>
              {option}
            </Option>
          ))}
        </Select>
      );
    case 'number':
      return (
        <NumberInput
          field={field}
          value={value}
          testId={testId}
          disabled={disabled}
          invalid={invalid}
          onChange={onChange}
        />
      );
    case 'boolean':
      return (
        <Switch
          checked={value === true}
          disabled={disabled}
          color={invalid ? 'danger' : undefined}
          onChange={event => onChange(event.target.checked)}
          endDecorator={value === true ? 'On' : 'Off'}
          slotProps={{ input: { 'data-testid': testId } }}
          sx={{ alignSelf: 'flex-start', mt: 0.5 }}
        />
      );
    case 'unsupported':
      return (
        <Typography level="body-sm" data-testid={testId}>
          {JSON.stringify(value)} (edit in the JSON view)
        </Typography>
      );
  }
}

type FieldsProps = {
  fields: FieldSpec[];
  value: ConfigObject;
  defaults: ConfigObject;
  errors: Record<string, string>;
  disabled: boolean;
  testIdPrefix: string;
  onChange(field: FieldSpec, next: unknown): void;
};

function FieldGrid({ fields, value, defaults, errors, disabled, testIdPrefix, onChange }: FieldsProps) {
  return (
    <Grid container spacing={2}>
      {fields.map(field => {
        const id = pathId(field.path);
        const testId = `${testIdPrefix}-${id}`;
        if (field.kind === 'group') {
          return (
            <Grid xs={12} key={id}>
              <Box
                component="fieldset"
                data-testid={`${testId}-group`}
                sx={{ border: '1px solid', borderColor: 'divider', borderRadius: 'md', m: 0, px: 2, pb: 2, pt: 1 }}
              >
                <Typography component="legend" level="title-sm" sx={{ px: 0.5 }}>
                  {field.label}
                </Typography>
                {field.help && (
                  <Typography level="body-sm" sx={{ mb: 1.5 }}>
                    {field.help}
                  </Typography>
                )}
                <FieldGrid
                  fields={field.fields}
                  value={value}
                  defaults={defaults}
                  errors={errors}
                  disabled={disabled}
                  testIdPrefix={testIdPrefix}
                  onChange={onChange}
                />
              </Box>
            </Grid>
          );
        }
        const current = getAtPath(value, field.path);
        const defaultValue = getAtPath(defaults, field.path);
        const error = errors[id];
        const hints = [`Default ${formatValue(defaultValue)}`];
        if (field.kind === 'number') hints.push(numberRangeText(field));
        return (
          <Grid xs={12} md={6} key={id}>
            <FormControl error={Boolean(error)} data-testid={`${testId}-field`}>
              <Stack direction="row" alignItems="center" justifyContent="space-between" gap={1}>
                <FormLabel sx={{ mb: 0 }}>{field.label}</FormLabel>
                {!sameValue(current, defaultValue) && (
                  <Tooltip title={`Reset to default (${formatValue(defaultValue)})`} placement="top">
                    <IconButton
                      size="sm"
                      variant="plain"
                      disabled={disabled}
                      aria-label={`Reset ${field.label} to default (${formatValue(defaultValue)})`}
                      data-testid={`${testId}-reset-btn`}
                      onClick={() => onChange(field, defaultValue)}
                    >
                      <RestartAltIcon />
                    </IconButton>
                  </Tooltip>
                )}
              </Stack>
              <FieldControl
                field={field}
                value={current}
                testId={`${testId}-input`}
                disabled={disabled}
                invalid={Boolean(error)}
                onChange={next => onChange(field, next)}
              />
              <FormHelperText data-testid={`${testId}-helper`} sx={{ display: 'block' }}>
                {error ?? field.help}
                <Typography component="span" level="body-xs" display="block" data-testid={`${testId}-hint`}>
                  {hints.join('. ')}.
                </Typography>
              </FormHelperText>
            </FormControl>
          </Grid>
        );
      })}
    </Grid>
  );
}

function JsonDialog({
  value,
  testIdPrefix,
  onApply,
  onClose,
}: {
  value: ConfigObject;
  testIdPrefix: string;
  onApply(next: ConfigObject): void;
  onClose(): void;
}) {
  const [text, setText] = useState(() => JSON.stringify(value, null, 2));
  const [error, setError] = useState<string>();
  const apply = () => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      setError('Enter valid JSON to apply it.');
      return;
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      setError('Enter a JSON object, in braces.');
      return;
    }
    onApply(toConfigObject(parsed));
  };
  return (
    <AdminDialog title="Edit as JSON" width={640} onClose={onClose} data-testid={`${testIdPrefix}-json-dialog`}>
      <FormControl error={Boolean(error)}>
        <Textarea
          minRows={10}
          maxRows={24}
          value={text}
          onChange={event => {
            setText(event.target.value);
            setError(undefined);
          }}
          sx={{ fontFamily: 'code' }}
          slotProps={{ textarea: { 'data-testid': `${testIdPrefix}-json-input`, spellCheck: false } }}
        />
        <FormHelperText data-testid={`${testIdPrefix}-json-helper`}>
          {error ?? 'Applying updates the form; nothing is saved until you save the setting.'}
        </FormHelperText>
      </FormControl>
      <Stack direction="row" gap={1} justifyContent="flex-end">
        <Button variant="plain" color="neutral" onClick={onClose} data-testid={`${testIdPrefix}-json-cancel-btn`}>
          Cancel
        </Button>
        <Button onClick={apply} data-testid={`${testIdPrefix}-json-apply-btn`}>
          Apply JSON
        </Button>
      </Stack>
    </AdminDialog>
  );
}

/**
 * Form editor for a structured object setting (an operator config such as abuseAssessmentConfig),
 * generated from the setting's Zod schema (its STRUCTURED_SETTINGS entry): labels, help, bounds and defaults
 * all come from the schema. The value is checked with the same schema the server parses it with,
 * and a change with real-world consequences (see `confirmations`) is confirmed before it saves.
 */
const AdminSchemaSettingField = ({
  setting,
  structured: { schema, confirmations },
  storedValue,
  index,
}: {
  setting: { key: SettingKey; name: string; description: string };
  structured: StructuredSetting;
  storedValue: unknown;
  index: number;
}) => {
  const testIdPrefix = `admin-setting-${setting.key}`;
  const saveRef = useRef<HTMLDivElement>(null);
  useAdminSaveShortcut(saveRef);
  const fields = useMemo(() => describeFields(schema), [schema]);
  const defaults = useMemo(() => schema.parse({}), [schema]);
  const stored = useMemo(() => {
    const raw = readStored(storedValue);
    const parsed = schema.safeParse(raw);
    return parsed.success ? parsed.data : raw;
  }, [schema, storedValue]);
  const warningsFor = (next: ConfigObject) => confirmations?.(next, stored) ?? [];
  const isInvalid = (next: ConfigObject) => Object.keys(validateConfig(schema, fields, next)).length > 0;

  const updateSettings = useUpdateSettings();
  const save = (next: ConfigObject) => {
    const parsed = schema.safeParse(next);
    if (!parsed.success) throw new Error(FIX_FIELDS);
    // The hook's value type is for transport only: the server parses it with the same schema.
    return updateSettings.mutateAsync({ key: setting.key, value: parsed.data as SettingValue });
  };
  const draft = useSettingsDraft<ConfigObject>(setting.key, stored, {
    name: setting.name,
    equals: sameValue,
    save,
    blocked: next => (isInvalid(next) ? FIX_FIELDS : undefined),
    warning: warningsFor,
  });
  const { value, setValue } = draft;
  const [jsonOpen, setJsonOpen] = useState(false);
  const [confirming, setConfirming] = useState(false);

  const errors = validateConfig(schema, fields, value);
  const formError = errors[''];
  const hasErrors = Object.keys(errors).length > 0;
  const warnings = warningsFor(value);
  const isDirty = !sameValue(value, stored);
  const disabled = updateSettings.isPending || draft.pending;
  const saveError = updateSettings.error ? getErrorMessage(updateSettings.error) : undefined;

  const commit = () => {
    setConfirming(false);
    const parsed = schema.safeParse(value);
    if (!parsed.success) return;
    updateSettings.mutate(
      { key: setting.key, value: parsed.data as SettingValue },
      { onSuccess: (data: { settingValue?: unknown } | undefined) => setValue(readStored(data?.settingValue)) }
    );
  };
  const handleSave = () => (warnings.length ? setConfirming(true) : commit());

  return (
    <SettingsSection
      variant="outlined"
      data-testid={`${testIdPrefix}-form`}
      sx={{ width: '100%', mb: 1, bgcolor: index % 2 ? 'background.level1' : 'background.level2', p: 2 }}
    >
      <Stack
        ref={draft.staged ? null : saveRef}
        data-admin-settings-editor
        tabIndex={0}
        aria-label={`${setting.name} settings editor`}
        gap={2}
      >
        <Stack direction={{ xs: 'column', sm: 'row' }} justifyContent="space-between" gap={1}>
          <Box sx={{ minWidth: 0 }}>
            <Typography level="title-md" component="h3">
              {setting.name}
            </Typography>
            <Typography level="body-sm">{setting.description}</Typography>
          </Box>
          <Button
            size="sm"
            variant="outlined"
            color="neutral"
            onClick={() => setJsonOpen(true)}
            disabled={disabled}
            data-testid={`${testIdPrefix}-view-json-btn`}
            sx={{ alignSelf: 'flex-start', flexShrink: 0 }}
          >
            View JSON
          </Button>
        </Stack>
        {warnings.length > 0 && (
          <Alert color="warning" variant="soft" data-testid={`${testIdPrefix}-risk-alert`}>
            <Stack gap={0.5}>
              {warnings.map(warning => (
                <Typography key={warning} level="body-sm">
                  {warning}
                </Typography>
              ))}
              <Typography level="body-sm" fontWeight="lg">
                You will be asked to confirm before this saves.
              </Typography>
            </Stack>
          </Alert>
        )}
        <FieldGrid
          fields={fields}
          value={value}
          defaults={defaults}
          errors={errors}
          disabled={disabled}
          testIdPrefix={testIdPrefix}
          onChange={(field, next) => setValue(previous => setAtPath(previous, field.path, next))}
        />
        {(formError || saveError) && (
          <Typography level="body-sm" color="danger" data-testid={`${testIdPrefix}-error`}>
            {formError ?? saveError}
          </Typography>
        )}
        {!draft.staged && (
          <Stack direction="row" alignItems="center" justifyContent="flex-end" gap={1}>
            {hasErrors && isDirty && (
              <Typography level="body-sm" color="danger">
                {FIX_FIELDS}
              </Typography>
            )}
            <Tooltip title="Save setting (Cmd/Ctrl+S, including from inputs)" placement="top">
              <Button
                data-testid={`${testIdPrefix}-save-btn`}
                data-admin-save
                aria-label={`Save ${setting.name} (Cmd/Ctrl+S)`}
                aria-keyshortcuts="Meta+s Control+s"
                color="success"
                size="sm"
                type="button"
                loading={updateSettings.isPending}
                onClick={handleSave}
                disabled={!isDirty || hasErrors}
              >
                <SaveIcon sx={{ marginX: 1 }} />
              </Button>
            </Tooltip>
          </Stack>
        )}
      </Stack>
      {jsonOpen && (
        <JsonDialog
          value={value}
          testIdPrefix={testIdPrefix}
          onClose={() => setJsonOpen(false)}
          onApply={next => {
            setValue(next);
            setJsonOpen(false);
          }}
        />
      )}
      {confirming && (
        <AdminDialog
          role="alertdialog"
          title={`Save ${setting.name}?`}
          onClose={() => setConfirming(false)}
          data-testid={`${testIdPrefix}-confirm-dialog`}
        >
          <Stack gap={1}>
            {warnings.map(warning => (
              <Typography key={warning} level="body-sm">
                {warning}
              </Typography>
            ))}
          </Stack>
          <Stack direction="row" gap={1} justifyContent="flex-end">
            <Button
              variant="plain"
              color="neutral"
              onClick={() => setConfirming(false)}
              data-testid={`${testIdPrefix}-confirm-cancel-btn`}
            >
              Keep editing
            </Button>
            <Button color="danger" onClick={commit} data-testid={`${testIdPrefix}-confirm-save-btn`}>
              Save and apply
            </Button>
          </Stack>
        </AdminDialog>
      )}
    </SettingsSection>
  );
};

export default AdminSchemaSettingField;
