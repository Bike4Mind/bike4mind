import React, { useState } from 'react';
import {
  Alert,
  Box,
  Button,
  Chip,
  ChipDelete,
  FormControl,
  FormLabel,
  Input,
  Stack,
  Switch,
  Typography,
} from '@mui/joy';
import { toast } from 'sonner';
import type { ReleaseNotesConfig } from '@bike4mind/common';
import { getErrorMessage } from '@client/app/utils/error';
import { useReleaseNotesConfig, useSaveReleaseNotesConfig } from './useReleaseNotes';

const ReleaseNotesConfigEditor: React.FC = () => {
  const { data, isLoading, error, dataUpdatedAt } = useReleaseNotesConfig();
  if (isLoading) return <Typography level="body-sm">Loading release notes settings...</Typography>;
  if (error || !data)
    return <Alert color="danger">Could not load release notes settings: {getErrorMessage(error)}</Alert>;
  // Keyed on the fetch time so a save or refetch reseeds the form.
  return <ConfigForm key={dataUpdatedAt} initial={data.config} malformed={data.malformed} />;
};

const ConfigForm: React.FC<{ initial: ReleaseNotesConfig; malformed: boolean }> = ({ initial, malformed }) => {
  const save = useSaveReleaseNotesConfig();
  const [draft, setDraft] = useState<ReleaseNotesConfig>(initial);
  const [term, setTerm] = useState('');

  const set = <K extends keyof ReleaseNotesConfig>(key: K, value: ReleaseNotesConfig[K]) =>
    setDraft(prev => ({ ...prev, [key]: value }));
  const addTerm = () => {
    const next = term.trim();
    if (next && !draft.denylist.includes(next)) set('denylist', [...draft.denylist, next]);
    setTerm('');
  };
  const onSave = () =>
    save.mutate(draft, {
      onSuccess: () => toast.success('Release notes settings saved'),
      onError: err => toast.error(getErrorMessage(err)),
    });

  return (
    <Stack spacing={2} data-testid="release-notes-config">
      {malformed && (
        <Alert color="warning" data-testid="release-notes-config-malformed">
          The stored settings could not be read, so defaults are shown. Saving replaces the stored value.
        </Alert>
      )}
      <FormControl orientation="horizontal" sx={{ gap: 1 }}>
        <Switch
          checked={draft.enabled}
          onChange={event => set('enabled', event.target.checked)}
          slotProps={{ input: { 'data-testid': 'release-notes-config-enabled' } as Record<string, string> }}
        />
        <FormLabel>Generate and publish release notes</FormLabel>
      </FormControl>
      <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2}>
        <FormControl sx={{ flex: 1 }}>
          <FormLabel>Model id</FormLabel>
          <Input value={draft.modelId} onChange={event => set('modelId', event.target.value)} />
        </FormControl>
        <FormControl sx={{ flex: 1 }}>
          <FormLabel>Embargo (hours, 0 to 168)</FormLabel>
          <Input
            type="number"
            value={draft.embargoHours}
            onChange={event => set('embargoHours', Number(event.target.value))}
            slotProps={{ input: { min: 0, max: 168, 'data-testid': 'release-notes-config-embargo' } }}
          />
        </FormControl>
      </Stack>
      <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2}>
        <FormControl sx={{ flex: 1 }}>
          <FormLabel>Slack team id</FormLabel>
          <Input value={draft.slackTeamId ?? ''} onChange={event => set('slackTeamId', event.target.value)} />
        </FormControl>
        <FormControl sx={{ flex: 1 }}>
          <FormLabel>Slack channel id</FormLabel>
          <Input value={draft.slackChannelId ?? ''} onChange={event => set('slackChannelId', event.target.value)} />
        </FormControl>
      </Stack>
      <FormControl>
        <FormLabel>Denylist (terms that must never appear in customer copy)</FormLabel>
        <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 1, mb: 1 }}>
          {draft.denylist.map(entry => (
            <Chip
              key={entry}
              variant="soft"
              endDecorator={
                <ChipDelete
                  onDelete={() =>
                    set(
                      'denylist',
                      draft.denylist.filter(t => t !== entry)
                    )
                  }
                />
              }
            >
              {entry}
            </Chip>
          ))}
        </Box>
        <Input
          value={term}
          placeholder="Add a term and press Enter"
          onChange={event => setTerm(event.target.value)}
          onKeyDown={event => {
            if (event.key === 'Enter') {
              event.preventDefault();
              addTerm();
            }
          }}
          slotProps={{ input: { 'data-testid': 'release-notes-config-denylist-input' } }}
        />
      </FormControl>
      <Box>
        <Button onClick={onSave} loading={save.isPending} data-testid="release-notes-config-save-btn">
          Save settings
        </Button>
      </Box>
    </Stack>
  );
};

export default ReleaseNotesConfigEditor;
