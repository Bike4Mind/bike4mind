import { useCallback, useEffect, useState } from 'react';
import Option from '@mui/joy/Option';
import Select from '@mui/joy/Select';
import Stack from '@mui/joy/Stack';
import Typography from '@mui/joy/Typography';
import {
  AUTO_LOCAL_CONTEXT,
  LOCAL_CONTEXT_SIZES,
  contextSizeLabel,
  parseLocalContextSetting,
  type LocalContextFit,
  type LocalContextSize,
  type LocalContextSetting,
} from '@shared/localContextSetting';

export function localContextSummary(setting: LocalContextSetting | null): string {
  if (!setting) return 'Loading';
  return setting.mode === 'auto'
    ? `Auto: ${contextSizeLabel(LOCAL_CONTEXT_SIZES[0])} or more as this computer's memory allows, less for a model trained on less`
    : `${contextSizeLabel(setting.tokens)} for every local model, less for a model trained on less`;
}

/** The note beside a fixed size the memory estimate says some local model would not fit. */
export function localContextFitNote(fit: LocalContextFit, tokens: LocalContextSize): string | null {
  const models = fit[tokens] ?? [];
  if (models.length === 0) return null;
  const which = models.length <= 2 ? models.join(' and ') : `${models.length} local models`;
  return `May not fit this computer's memory with ${which}`;
}

export function useLocalContextSetting() {
  const [setting, setSetting] = useState<LocalContextSetting | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [fit, setFit] = useState<LocalContextFit>({});
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
    void window.b4m.chat
      .getLocalContextFit()
      .then(next => {
        if (live) setFit(next);
      })
      .catch(() => undefined);
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
  return [setting, save, error, fit] as const;
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
  fit = {},
}: {
  setting: LocalContextSetting | null;
  onChange: (setting: LocalContextSetting) => void;
  error: string | null;
  fit?: LocalContextFit;
}) {
  const chosenNote = setting?.mode === 'fixed' ? localContextFitNote(fit, setting.tokens) : null;
  return (
    <Stack spacing={1.25}>
      <Typography level="body-xs" textColor="text.tertiary">
        A larger context lets a local model read longer conversations and uses more memory. Auto starts each model at
        16K tokens, or at the largest size that fits this computer&apos;s GPU (up to 32K when there is no GPU), and
        gives a conversation that outgrows it more room before summarising it. When Desktop cannot measure the GPU,
        every model starts at 16K and grows one size at a time. No model goes past the context it was trained on. A
        model reloads on its next message after this changes.
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
        {LOCAL_CONTEXT_SIZES.map(tokens => {
          const note = localContextFitNote(fit, tokens);
          return (
            <Option
              key={tokens}
              value={String(tokens)}
              label={contextSizeLabel(tokens)}
              data-testid={`settings-local-context-option-${tokens}`}
            >
              <Stack>
                {contextSizeLabel(tokens)}
                {note && (
                  <Typography
                    level="body-xs"
                    color="warning"
                    data-testid={`settings-local-context-option-${tokens}-note`}
                  >
                    {note}
                  </Typography>
                )}
              </Stack>
            </Option>
          );
        })}
      </Select>
      {chosenNote && (
        <Typography level="body-xs" color="warning" data-testid="settings-local-context-fit-note">
          {chosenNote}
        </Typography>
      )}
      {error && (
        <Typography level="body-xs" color="danger" role="alert" data-testid="settings-local-context-error">
          {error}
        </Typography>
      )}
    </Stack>
  );
}
