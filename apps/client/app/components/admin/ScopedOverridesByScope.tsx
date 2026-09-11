import { settingsMap, SettingScopeLevel } from '@bike4mind/common';
import {
  useClearScopedSettingOverride,
  useScopedSettingOverrides,
  useSettingsFromServer,
} from '@client/app/hooks/data/settings';
import { getErrorMessage } from '@client/app/utils/error';
import TuneIcon from '@mui/icons-material/Tune';
import { Alert, Box, Button, Card, FormControl, FormLabel, Input, Option, Select, Stack, Typography } from '@mui/joy';
import { useMemo, useState } from 'react';
import {
  displayValue,
  INERT_RUNG_NOTE,
  LEVEL_LABELS,
  OVERRIDE_STALENESS_NOTE,
  type AdminSetting,
  type OverrideLevel,
} from './ScopedSettingOverrides';

const ALL_LEVELS: OverrideLevel[] = [SettingScopeLevel.Organization, SettingScopeLevel.Owner, SettingScopeLevel.Lake];

/** See INERT_RUNG_NOTE for why a stored value at an unsettable rung is not reported as applying. */
function describeOverride(
  setting: AdminSetting,
  storedValue: string | undefined,
  isSettableHere: boolean,
  platformValue: string
): string {
  if (storedValue === undefined) {
    return isSettableHere
      ? `no override at this rung (platform: ${displayValue(setting, platformValue)})`
      : 'not settable at this rung';
  }
  return isSettableHere
    ? `overridden here: ${displayValue(setting, storedValue)}`
    : `${displayValue(setting, storedValue)} is stored here, but it is ${INERT_RUNG_NOTE}`;
}

/**
 * The inverse view of the per-setting sections: given one scope address, which scope-capable
 * settings carry an override THERE and which do not.
 *
 * Deliberately reports what is set AT the named rung, not the value a consumer would resolve. A
 * consumer builds the whole scope chain (for a lake, `scopeForLake` pulls in its org and owner
 * rungs), so a lake with no lake-rung row can still be overridden at its org - which is why the
 * no-override case is worded as "no override at this rung" and the platform value is labelled as
 * the platform value rather than as the effective one. A true effective-value read needs a resolve
 * endpoint and is not part of this view.
 */
export function ScopedOverridesByScope() {
  const { data: allOverrides } = useScopedSettingOverrides();
  const { data: platformSettings } = useSettingsFromServer();
  const clearOverride = useClearScopedSettingOverride();

  const [level, setLevel] = useState<OverrideLevel>(SettingScopeLevel.Organization);
  const [scopeId, setScopeId] = useState('');

  // `scope` is an opt-in field on every setting, so the scope-capable set is derived rather than
  // listed - a setting that opts in later appears here with no change needed.
  const scopeCapableSettings = useMemo(
    () =>
      Object.values(settingsMap)
        .filter(s => s.scope)
        .sort((a, b) => a.name.localeCompare(b.name)),
    []
  );

  const address = scopeId.trim();
  const clearError = clearOverride.error ? getErrorMessage(clearOverride.error) : undefined;

  return (
    <Card variant="outlined" sx={{ mb: 2 }} data-testid="scoped-overrides-by-scope">
      <Stack direction="row" alignItems="center" spacing={1}>
        <TuneIcon />
        <Typography level="title-lg">Overrides by scope</Typography>
      </Stack>
      <Typography level="body-sm" sx={{ color: 'text.secondary' }}>
        What one organization, owner or lake has set for itself. {OVERRIDE_STALENESS_NOTE}
      </Typography>

      <Box sx={{ display: 'flex', alignItems: 'flex-end', gap: 1, flexWrap: 'wrap' }}>
        <FormControl size="sm">
          <FormLabel>Scope</FormLabel>
          <Select
            value={level}
            onChange={(_e, next) => next && setLevel(next)}
            slotProps={{ button: { 'data-testid': 'scoped-overrides-by-scope-level-select' } }}
            sx={{ minWidth: 140 }}
          >
            {ALL_LEVELS.map(option => (
              <Option key={option} value={option} data-testid={`scoped-overrides-by-scope-level-option-${option}`}>
                {LEVEL_LABELS[option]}
              </Option>
            ))}
          </Select>
        </FormControl>

        <FormControl size="sm">
          <FormLabel>Scope id</FormLabel>
          <Input
            slotProps={{ input: { 'data-testid': 'scoped-overrides-by-scope-id-input' } }}
            value={scopeId}
            onChange={e => setScopeId(e.target.value)}
            placeholder="id"
            sx={{ minWidth: 240 }}
          />
        </FormControl>
      </Box>

      {clearError && (
        <Alert color="danger" variant="soft" data-testid="scoped-overrides-by-scope-error">
          {clearError}
        </Alert>
      )}

      {!address ? (
        <Typography level="body-sm" sx={{ color: 'text.secondary' }} data-testid="scoped-overrides-by-scope-prompt">
          Enter a scope id to see what it overrides.
        </Typography>
      ) : (
        <Stack spacing={0.5}>
          {scopeCapableSettings.map(setting => {
            const override = (allOverrides ?? []).find(
              row => row.settingName === setting.key && row.scopeLevel === level && row.scopeId === address
            );
            const isSettableHere = setting.scope?.settableAt.includes(level) === true;
            const platformValue =
              platformSettings?.find(stored => stored.settingName === setting.key)?.settingValue ??
              setting.defaultValue;

            return (
              <Box
                key={setting.key}
                data-testid={`scoped-overrides-by-scope-row-${setting.key}`}
                sx={{ display: 'flex', alignItems: 'center', gap: 1, flexWrap: 'wrap' }}
              >
                <Typography level="body-sm" sx={{ flex: 1, minWidth: 0 }}>
                  <strong>{setting.name}</strong>
                  {' - '}
                  {describeOverride(setting, override?.settingValue, isSettableHere, String(platformValue))}
                </Typography>
                {override && (
                  <Button
                    data-testid={`scoped-overrides-by-scope-clear-btn-${setting.key}`}
                    size="sm"
                    variant="soft"
                    color="danger"
                    loading={clearOverride.isPending}
                    onClick={() =>
                      clearOverride.mutate({
                        settingName: override.settingName,
                        scopeLevel: override.scopeLevel,
                        scopeId: override.scopeId,
                      })
                    }
                  >
                    Clear
                  </Button>
                )}
              </Box>
            );
          })}
        </Stack>
      )}
    </Card>
  );
}
