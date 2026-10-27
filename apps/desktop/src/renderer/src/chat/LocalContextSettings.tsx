import { useCallback, useEffect, useState } from 'react';
import { MODE_CONTEXT_TARGETS } from '@bike4mind/common';
import Option from '@mui/joy/Option';
import Select from '@mui/joy/Select';
import Stack from '@mui/joy/Stack';
import Typography from '@mui/joy/Typography';
import {
  AUTO_LOCAL_CONTEXT,
  LOCAL_CONTEXT_SIZES,
  contextSizeLabel,
  parseLocalContextSetting,
  type LocalContextSetting,
} from '@shared/localContextSetting';

export function localContextSummary(setting: LocalContextSetting | null): string {
  if (!setting) return 'Loading';
  return setting.mode === 'auto'
    ? `Auto: ${LOCAL_CONTEXT_SIZES[0] / 1024}K to ${contextSizeLabel(MODE_CONTEXT_TARGETS.chat)}, as this computer's memory allows`
    : `${contextSizeLabel(setting.tokens)} for every local model`;
}

export function useLocalContextSetting() {
  const [setting, setSetting] = useState<LocalContextSetting | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    void window.b4m.chat
      .getLocalContext()
      .then(next => {
        if (live) setSetting(next);
      })
      .catch(err => {
        if (live) setError(`Could not load this setting. ${String(err)}`);
      });
    return () => {
      live = false;
    };
  }, []);
  const save = useCallback(async (next: LocalContextSetting) => {
    setError(null);
    try {
      setSetting(await window.b4m.chat.setLocalContext(next));
    } catch (err) {
      setError(`Could not save this setting. ${String(err)}`);
    }
  }, []);
  return [setting, save, error] as const;
}

const AUTO = 'auto';

/** Joy's Select holds strings, so a fixed size travels as its token count. */
function selectValue(setting: LocalContextSetting): string {
  return setting.mode === 'auto' ? AUTO : String(setting.tokens);
}

export function LocalContextSettings({
  setting,
  onChange,
  error,
}: {
  setting: LocalContextSetting | null;
  onChange: (setting: LocalContextSetting) => void;
  error: string | null;
}) {
  return (
    <Stack spacing={1.25}>
      <Typography level="body-xs" textColor="text.tertiary">
        A larger context lets a local model read longer conversations and uses more memory. Auto also gives one long
        message more room when memory allows. No model goes past the context it was trained on. A model reloads on its
        next message after this changes.
      </Typography>
      <Select
        size="sm"
        value={setting ? selectValue(setting) : null}
        disabled={!setting}
        onChange={(_event, next) => {
          if (next)
            onChange(
              next === AUTO ? AUTO_LOCAL_CONTEXT : parseLocalContextSetting({ mode: 'fixed', tokens: Number(next) })
            );
        }}
        sx={{ alignSelf: 'flex-start', minWidth: 220 }}
        slotProps={{ button: { 'aria-label': 'Local model context', 'data-testid': 'settings-local-context-select' } }}
      >
        <Option value={AUTO} data-testid="settings-local-context-option-auto">
          Auto (fits this computer)
        </Option>
        {LOCAL_CONTEXT_SIZES.map(tokens => (
          <Option key={tokens} value={String(tokens)} data-testid={`settings-local-context-option-${tokens}`}>
            {contextSizeLabel(tokens)}
          </Option>
        ))}
      </Select>
      {error && (
        <Typography level="body-xs" color="danger" role="alert" data-testid="settings-local-context-error">
          {error}
        </Typography>
      )}
    </Stack>
  );
}
