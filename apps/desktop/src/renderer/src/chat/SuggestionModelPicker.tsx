import { useEffect, useState } from 'react';
import Button from '@mui/joy/Button';
import Option from '@mui/joy/Option';
import Select from '@mui/joy/Select';
import Stack from '@mui/joy/Stack';
import Typography from '@mui/joy/Typography';
import { isLocalBackend, type ChatModelOption } from '@shared/chat';
import { usePromptSuggestionModel } from './promptSuggestions';

/** Joy's Select cannot hold null as an option value, so automatic needs a stand-in. */
const AUTOMATIC = '__automatic__';

export interface SuggestionPickerRow {
  id: string;
  label: string;
  local: boolean;
  unavailable: boolean;
}

type CatalogState =
  { status: 'loading' } | { status: 'loaded'; models: ChatModelOption[] } | { status: 'error'; message: string };

/**
 * The picker's rows. A saved pick the server no longer offers stays listed and marked, rather
 * than dropped: main declines to suggest on it, and a picker showing "Automatic" instead would
 * hide why the hint stopped. Before the list arrives the saved pick is shown plainly.
 */
export function suggestionPickerRows(
  offered: readonly ChatModelOption[] | null,
  saved: string | null
): SuggestionPickerRow[] {
  const choices = (offered ?? []).map(model => {
    const local = isLocalBackend(model);
    return { id: model.id, label: local ? `${model.name} (Ollama)` : model.name, local, unavailable: false };
  });
  if (saved && !choices.some(choice => choice.id === saved)) {
    const unavailable = offered !== null;
    choices.push({ id: saved, label: unavailable ? `${saved} (unavailable)` : saved, local: false, unavailable });
  }
  return choices;
}

function caption(selected: SuggestionPickerRow | undefined): string {
  if (!selected) return 'The smallest hosted model this server offers. No hint when it offers none.';
  if (selected.unavailable) return 'This server does not offer this model right now, so no hint is shown.';
  if (selected.local) return "Uses the server's configured Ollama endpoint. The hint can take a few seconds longer.";
  return 'Hosted by the server, and billed like any other request.';
}

/** Which model writes the suggested next prompt. Settings shows it only while the hint is on. */
export function SuggestionModelPicker() {
  const [saved, setSaved] = usePromptSuggestionModel();
  const [catalog, setCatalog] = useState<CatalogState>({ status: 'loading' });
  const [refresh, setRefresh] = useState(0);

  useEffect(() => {
    let live = true;
    setCatalog({ status: 'loading' });
    async function load() {
      try {
        const result = await window.b4m.chat.listSuggestionModels();
        if (!live) return;
        setCatalog(
          result.error ? { status: 'error', message: result.error } : { status: 'loaded', models: result.models }
        );
      } catch {
        if (live) setCatalog({ status: 'error', message: 'Could not load suggestion models. Try again.' });
      }
    }
    void load();
    return () => {
      live = false;
    };
  }, [refresh]);

  const offered = catalog.status === 'loaded' ? catalog.models : null;
  const choices = suggestionPickerRows(offered, saved);
  const selected = saved ? choices.find(choice => choice.id === saved) : undefined;

  return (
    <Stack spacing={0.75} data-testid="settings-suggestions-model">
      <Select
        size="sm"
        value={saved ?? AUTOMATIC}
        onChange={(_event, value) => setSaved(!value || value === AUTOMATIC ? null : value)}
        slotProps={{
          button: {
            'aria-label': 'Model for the suggested next prompt',
            'data-testid': 'settings-suggestions-model-select',
          },
        }}
      >
        <Option value={AUTOMATIC} data-testid="settings-suggestions-model-option">
          Automatic
        </Option>
        {choices.map(choice => (
          <Option key={choice.id} value={choice.id} data-testid="settings-suggestions-model-option">
            {choice.label}
          </Option>
        ))}
      </Select>
      {catalog.status === 'error' && (
        <Typography level="body-xs" color="danger" role="alert">
          {catalog.message}
        </Typography>
      )}
      <Typography level="body-xs" textColor="text.tertiary">
        {catalog.status === 'loading'
          ? 'Loading models...'
          : catalog.status === 'error'
            ? 'Model availability is unknown.'
            : caption(selected)}
      </Typography>
      <Button
        size="sm"
        variant="plain"
        disabled={catalog.status === 'loading'}
        onClick={() => setRefresh(value => value + 1)}
        data-testid="settings-suggestions-model-refresh"
        sx={{ alignSelf: 'flex-start' }}
      >
        Refresh models
      </Button>
    </Stack>
  );
}
