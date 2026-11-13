import { Typography } from '@mui/joy';
import { settingsMap, type SettingKey } from '@bike4mind/common';
import AdminSettingInputField from '../../AdminSettingInputField';

const formatValue = (value: unknown): string => {
  if (value === undefined || value === null || value === '') return 'not set';
  if (typeof value === 'number') return value.toLocaleString();
  return String(value);
};

type SettingKeyRowProps = {
  settingKey: SettingKey;
  /** The stored row's value; undefined when no row exists. */
  stored: unknown;
  index: number;
  /** Prefixes the current/derived line testids: `${testIdPrefix}-current-${key}`. */
  testIdPrefix: string;
  derived?: string | null;
  lockedNote?: string;
};

/** One setting editor with its current and default value, for pages that edit a fixed list of keys. */
export function SettingKeyRow({ settingKey, stored, index, testIdPrefix, derived, lockedNote }: SettingKeyRowProps) {
  const setting = settingsMap[settingKey];
  const current = stored ?? setting.defaultValue;
  return (
    <AdminSettingInputField
      // Remount when the stored value changes so the editor never shows a stale draft.
      key={`${settingKey}-${JSON.stringify(stored ?? null)}`}
      index={index}
      setting={setting}
      defaultValue={current}
      lockedNote={lockedNote}
      valueHelper={
        <>
          <Typography
            component="span"
            level="body-xs"
            display="block"
            sx={{ color: 'admin.inkMuted' }}
            data-testid={`${testIdPrefix}-current-${settingKey}`}
          >
            Current: {formatValue(current)}
            {stored === undefined ? ' (default)' : ` - default ${formatValue(setting.defaultValue)}`}
          </Typography>
          {derived && (
            <Typography
              component="span"
              level="body-xs"
              display="block"
              sx={{ color: 'admin.inkMuted' }}
              data-testid={`${testIdPrefix}-derived-${settingKey}`}
            >
              {derived}
            </Typography>
          )}
        </>
      }
    />
  );
}
