import React, { useState } from 'react';
import {
  Alert,
  Box,
  Button,
  Chip,
  ChipDelete,
  FormControl,
  FormHelperText,
  FormLabel,
  Input,
  Stack,
  Switch,
  Typography,
} from '@mui/joy';
import type { ReleaseNotesConfig } from '@bike4mind/common';
import { getErrorMessage } from '@client/app/utils/error';
import { useSettingsDraft } from '../SettingsDraftProvider';
import { ErrorState, LoadingState, SettingsSection } from '../shared';
import { useReleaseNotesConfig, useSaveReleaseNotesConfig } from './useReleaseNotes';

const fieldSx = { maxWidth: '40rem' } as const;

/**
 * The release notes settings as one section of the page. The whole config is one staged draft for
 * the page's SaveBar (the SettingsDraftProvider in AdminReleaseNotesTab), because the endpoint takes
 * the full object in a single PUT.
 */
const ReleaseNotesConfigEditor: React.FC = () => {
  const { data, isLoading, error, refetch, isFetching } = useReleaseNotesConfig();
  return (
    <SettingsSection component="section" sx={{ mb: 0 }} data-testid="release-notes-config-section">
      <Stack sx={{ gap: 0.5, mb: 2 }}>
        <Typography level="title-md" component="h2" sx={{ color: 'admin.ink' }}>
          Settings
        </Typography>
        <Typography level="body-sm" sx={{ color: 'admin.inkMuted' }}>
          Generation, the embargo before a note goes live, the Slack announcement and terms customer copy must never
          mention.
        </Typography>
      </Stack>
      {isLoading ? (
        <LoadingState label="Loading release notes settings" testId="release-notes-config-loading" />
      ) : error || !data ? (
        <ErrorState
          message={`Could not load release notes settings: ${getErrorMessage(error)}`}
          onRetry={() => void refetch()}
          retrying={isFetching}
        />
      ) : (
        <ConfigForm stored={data.config} malformed={data.malformed} />
      )}
    </SettingsSection>
  );
};

const ConfigForm: React.FC<{ stored: ReleaseNotesConfig; malformed: boolean }> = ({ stored, malformed }) => {
  const save = useSaveReleaseNotesConfig();
  // An unreadable stored value has no baseline (null): the form shows the defaults, and any edit, or
  // "Use these defaults", stages a draft so Save can replace it.
  const draft = useSettingsDraft<ReleaseNotesConfig | null>('releaseNotesConfig', malformed ? null : stored, {
    name: 'Release notes settings',
    save: next => save.mutateAsync(next ?? stored),
  });
  const config = draft.value ?? stored;
  const [term, setTerm] = useState('');

  const set = <K extends keyof ReleaseNotesConfig>(key: K, value: ReleaseNotesConfig[K]) =>
    draft.setValue(previous => ({ ...(previous ?? stored), [key]: value }));
  const addTerm = () => {
    const next = term.trim();
    if (next && !config.denylist.includes(next)) set('denylist', [...config.denylist, next]);
    setTerm('');
  };

  return (
    <Stack spacing={2} data-testid="release-notes-config">
      {malformed && (
        <Alert
          color="warning"
          data-testid="release-notes-config-malformed"
          endDecorator={
            draft.value === null && (
              <Button
                size="sm"
                variant="outlined"
                onClick={() => draft.setValue(stored)}
                data-testid="release-notes-config-use-defaults-btn"
              >
                Use these defaults
              </Button>
            )
          }
        >
          The stored settings could not be read, so defaults are shown. Saving replaces the stored value.
        </Alert>
      )}
      <FormControl orientation="horizontal" sx={{ gap: 1 }}>
        <Switch
          checked={config.enabled}
          disabled={draft.pending}
          onChange={event => set('enabled', event.target.checked)}
          slotProps={{ input: { 'data-testid': 'release-notes-config-enabled' } as Record<string, string> }}
        />
        <FormLabel>Generate and publish release notes</FormLabel>
      </FormControl>
      <FormControl sx={fieldSx}>
        <FormLabel>Model id</FormLabel>
        <Input
          value={config.modelId}
          disabled={draft.pending}
          onChange={event => set('modelId', event.target.value)}
          slotProps={{ input: { 'data-testid': 'release-notes-config-model-id' } }}
        />
      </FormControl>
      <FormControl sx={fieldSx}>
        <FormLabel>Embargo (hours, 0 to 168)</FormLabel>
        <Input
          type="number"
          value={config.embargoHours}
          disabled={draft.pending}
          onChange={event => set('embargoHours', Number(event.target.value))}
          slotProps={{ input: { min: 0, max: 168, 'data-testid': 'release-notes-config-embargo' } }}
        />
      </FormControl>
      <FormControl sx={fieldSx}>
        <FormLabel>Slack team id</FormLabel>
        <Input
          value={config.slackTeamId ?? ''}
          disabled={draft.pending}
          onChange={event => set('slackTeamId', event.target.value)}
          slotProps={{ input: { 'data-testid': 'release-notes-config-slack-team-id' } }}
        />
      </FormControl>
      <FormControl sx={fieldSx}>
        <FormLabel>Slack channel id</FormLabel>
        <Input
          value={config.slackChannelId ?? ''}
          disabled={draft.pending}
          onChange={event => set('slackChannelId', event.target.value)}
          slotProps={{ input: { 'data-testid': 'release-notes-config-slack-channel-id' } }}
        />
      </FormControl>
      <FormControl sx={fieldSx}>
        <FormLabel>Denylist (terms that must never appear in customer copy)</FormLabel>
        {config.denylist.length > 0 && (
          <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 1, mb: 1 }} data-testid="release-notes-config-denylist">
            {config.denylist.map(entry => (
              <Chip
                key={entry}
                variant="soft"
                disabled={draft.pending}
                endDecorator={
                  <ChipDelete
                    onDelete={() =>
                      set(
                        'denylist',
                        config.denylist.filter(t => t !== entry)
                      )
                    }
                  />
                }
              >
                {entry}
              </Chip>
            ))}
          </Box>
        )}
        <Input
          value={term}
          placeholder="Add a term and press Enter"
          disabled={draft.pending}
          onChange={event => setTerm(event.target.value)}
          onKeyDown={event => {
            if (event.key === 'Enter') {
              event.preventDefault();
              addTerm();
            }
          }}
          slotProps={{ input: { 'data-testid': 'release-notes-config-denylist-input' } }}
        />
        <FormHelperText sx={{ color: 'admin.inkMuted' }}>
          Applies to existing notes too: the public feed withholds any note that matches until it is edited.
        </FormHelperText>
      </FormControl>
    </Stack>
  );
};

export default ReleaseNotesConfigEditor;
