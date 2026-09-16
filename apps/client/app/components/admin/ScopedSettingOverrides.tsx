import { CreditHolderType, SettingOwnerType, SettingScopeLevel, settingsMap } from '@bike4mind/common';
import {
  useClearScopedSettingOverride,
  useScopedSettingOverrides,
  useSetScopedSettingOverride,
} from '@client/app/hooks/data/settings';
import { getErrorMessage } from '@client/app/utils/error';
import {
  Alert,
  Box,
  Button,
  FormControl,
  FormHelperText,
  FormLabel,
  Input,
  Option,
  Select,
  Stack,
  Switch,
  Typography,
} from '@mui/joy';
import { useState } from 'react';
import { rangeMessage } from './settingFieldHelpers';

export type AdminSetting = (typeof settingsMap)[keyof typeof settingsMap];

/** The override altitudes. `platform` is the base value and is written by PUT /api/settings/update. */
export type OverrideLevel = Exclude<SettingScopeLevel, SettingScopeLevel.Platform>;

export const LEVEL_LABELS: Record<OverrideLevel, string> = {
  [SettingScopeLevel.Organization]: 'Organization',
  [SettingScopeLevel.Owner]: 'Owner',
  [SettingScopeLevel.Lake]: 'Lake',
};

/**
 * The propagation bound an operator will otherwise read as a broken lever. Wording follows
 * EnforceLakeAdmission's own description, which is where it is already documented.
 */
export const OVERRIDE_STALENESS_NOTE =
  'A change applies immediately on the instance that served it and within ~5 min (one cache TTL) everywhere else.';

/**
 * A stored override outlives the rung it was written at: dropping a level from a setting's
 * `settableAt` leaves rows already saved there in the collection, where the resolver no longer
 * looks for them (#2624 did exactly that to the data-lake scan budgets). Presenting one as a value
 * that applies would repeat the lie the removal was meant to end, so both override views label it
 * and both keep offering Clear. Shared so the two cannot drift into saying different things.
 */
export const INERT_RUNG_NOTE = 'inert - no longer settable at this rung, so nothing reads it';

/** Booleans are stored as 'true'/'false'; show the operator the switch position, not the string. */
export const displayValue = (setting: AdminSetting, storedValue: string): string =>
  setting.type === 'boolean' ? (storedValue === 'true' ? 'On' : 'Off') : storedValue;

/**
 * The org/owner/lake overrides of ONE setting, with the controls to add, change and clear them.
 * Rendered only for a setting that declares `scope`, so a platform-only setting's card is untouched.
 *
 * Scope ids are entered raw - there is no org/user/lake picker in this pass.
 */
const ScopedSettingOverrides = ({ setting }: { setting: AdminSetting }) => {
  const settableAt = setting.scope?.settableAt;
  const { data: allOverrides } = useScopedSettingOverrides();
  const setOverride = useSetScopedSettingOverride();
  const clearOverride = useClearScopedSettingOverride();

  const [level, setLevel] = useState<OverrideLevel>(settableAt?.[0] ?? SettingScopeLevel.Organization);
  const [scopeId, setScopeId] = useState('');
  const [ownerType, setOwnerType] = useState<SettingOwnerType>(CreditHolderType.User);
  const [value, setValue] = useState<string | boolean>(setting.type === 'boolean' ? false : '');

  if (!settableAt) return null;

  const rows = (allOverrides ?? []).filter(row => row.settingName === setting.key);

  // Only number settings declare bounds, and only some of those, so they are read through the
  // type discriminant rather than off the union - same as the platform field in
  // AdminSettingInputField.
  const bounds: { min?: number; max?: number } = setting.type === 'number' ? setting : {};
  const valueError =
    setting.type !== 'number'
      ? undefined
      : // Number('') is 0, which a `min: 0` setting would accept as a genuine zero, so an emptied
        // field is refused here rather than silently stored.
        String(value).trim() === ''
        ? 'Enter a number.'
        : rangeMessage(Number(value), bounds.min, bounds.max);

  const canSet = Boolean(scopeId.trim()) && !valueError;
  // A rejected write is otherwise silent: the button just stops spinning.
  const writeError = setOverride.error ? getErrorMessage(setOverride.error) : undefined;
  const clearError = clearOverride.error ? getErrorMessage(clearOverride.error) : undefined;

  const handleSet = () => {
    if (!canSet) return;
    setOverride.mutate({
      settingName: setting.key,
      scopeLevel: level,
      scopeId: scopeId.trim(),
      // ownerType is attribution, required at the owner rung and refused at every other one.
      ...(level === SettingScopeLevel.Owner ? { ownerType } : {}),
      value: setting.type === 'boolean' ? Boolean(value) : setting.type === 'number' ? Number(value) : String(value),
    });
  };

  return (
    <Stack spacing={1} sx={{ mt: 1 }}>
      <Typography level="title-sm" data-testid={`scoped-override-${setting.key}-header`}>
        Scoped overrides ({rows.length})
      </Typography>

      {rows.length === 0 ? (
        <Typography
          level="body-xs"
          sx={{ color: 'text.secondary' }}
          data-testid={`scoped-override-${setting.key}-empty`}
        >
          No overrides - every scope uses the platform value above.
        </Typography>
      ) : (
        <Stack spacing={0.5}>
          {rows.map(row => (
            <Box
              key={`${row.scopeLevel}-${row.scopeId}`}
              data-testid={`scoped-override-${setting.key}-row-${row.scopeLevel}-${row.scopeId}`}
              sx={{ display: 'flex', alignItems: 'center', gap: 1, flexWrap: 'wrap' }}
            >
              <Typography level="body-sm" sx={{ flex: 1, minWidth: 0 }}>
                <strong>{LEVEL_LABELS[row.scopeLevel]}</strong> {row.scopeId}
                {row.ownerType ? ` (${row.ownerType})` : ''} = {displayValue(setting, row.settingValue)}
                {settableAt.includes(row.scopeLevel) ? '' : ` - ${INERT_RUNG_NOTE}`}
              </Typography>
              <Button
                data-testid={`scoped-override-${setting.key}-clear-btn-${row.scopeLevel}-${row.scopeId}`}
                size="sm"
                variant="soft"
                color="danger"
                loading={clearOverride.isPending}
                onClick={() =>
                  clearOverride.mutate({
                    settingName: row.settingName,
                    scopeLevel: row.scopeLevel,
                    scopeId: row.scopeId,
                  })
                }
              >
                Clear
              </Button>
            </Box>
          ))}
        </Stack>
      )}

      <Box sx={{ display: 'flex', alignItems: 'flex-end', gap: 1, flexWrap: 'wrap' }}>
        <FormControl size="sm">
          <FormLabel>Scope</FormLabel>
          <Select
            value={level}
            onChange={(_e, next) => next && setLevel(next)}
            slotProps={{ button: { 'data-testid': `scoped-override-${setting.key}-level-select` } }}
            sx={{ minWidth: 140 }}
          >
            {settableAt.map(option => (
              <Option key={option} value={option} data-testid={`scoped-override-${setting.key}-level-option-${option}`}>
                {LEVEL_LABELS[option]}
              </Option>
            ))}
          </Select>
        </FormControl>

        <FormControl size="sm">
          <FormLabel>Scope id</FormLabel>
          <Input
            slotProps={{ input: { 'data-testid': `scoped-override-${setting.key}-scope-id-input` } }}
            value={scopeId}
            onChange={e => setScopeId(e.target.value)}
            placeholder="id"
            sx={{ minWidth: 200 }}
          />
        </FormControl>

        {level === SettingScopeLevel.Owner && (
          <FormControl size="sm">
            <FormLabel>Owner type</FormLabel>
            <Select
              value={ownerType}
              onChange={(_e, next) => next && setOwnerType(next)}
              slotProps={{ button: { 'data-testid': `scoped-override-${setting.key}-owner-type-select` } }}
              sx={{ minWidth: 140 }}
            >
              {[CreditHolderType.User, CreditHolderType.Organization].map(option => (
                <Option
                  key={option}
                  value={option}
                  data-testid={`scoped-override-${setting.key}-owner-type-option-${option}`}
                >
                  {option}
                </Option>
              ))}
            </Select>
          </FormControl>
        )}

        <FormControl size="sm" error={Boolean(valueError)}>
          <FormLabel>Value</FormLabel>
          {setting.type === 'boolean' ? (
            <Switch
              sx={{ alignSelf: 'center', py: 1 }}
              slotProps={{ input: { 'data-testid': `scoped-override-${setting.key}-value-switch` } }}
              checked={value === true}
              onChange={e => setValue(e.target.checked)}
            />
          ) : setting.type === 'number' ? (
            <Input
              slotProps={{
                input: {
                  'data-testid': `scoped-override-${setting.key}-value-input`,
                  min: bounds.min,
                  max: bounds.max,
                },
              }}
              type="number"
              value={String(value)}
              onChange={e => setValue(e.target.value)}
              sx={{ minWidth: 140 }}
            />
          ) : setting.type === 'string' && setting.options ? (
            <Select
              value={String(value) || null}
              onChange={(_e, next) => setValue(next ?? '')}
              slotProps={{ button: { 'data-testid': `scoped-override-${setting.key}-value-select` } }}
              sx={{ minWidth: 200 }}
            >
              {Array.from(new Set(setting.options)).map(option => (
                <Option
                  key={option}
                  value={option}
                  data-testid={`scoped-override-${setting.key}-value-option-${option}`}
                >
                  {option}
                </Option>
              ))}
            </Select>
          ) : (
            <Input
              slotProps={{ input: { 'data-testid': `scoped-override-${setting.key}-value-input` } }}
              value={String(value)}
              onChange={e => setValue(e.target.value)}
              sx={{ minWidth: 200 }}
            />
          )}
        </FormControl>

        <Button
          data-testid={`scoped-override-${setting.key}-set-btn`}
          size="sm"
          color="primary"
          loading={setOverride.isPending}
          disabled={!canSet}
          onClick={handleSet}
        >
          Set
        </Button>
      </Box>

      <FormHelperText data-testid={`scoped-override-${setting.key}-helper`}>
        {valueError ?? `Overrides this setting for one scope. ${OVERRIDE_STALENESS_NOTE}`}
      </FormHelperText>

      {(writeError ?? clearError) && (
        <Alert color="danger" variant="soft" data-testid={`scoped-override-${setting.key}-error`}>
          {writeError ?? clearError}
        </Alert>
      )}
    </Stack>
  );
};

export default ScopedSettingOverrides;
