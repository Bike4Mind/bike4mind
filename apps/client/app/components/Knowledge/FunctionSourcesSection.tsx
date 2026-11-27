import React, { useState } from 'react';
import { Box, Button, IconButton, Input, Option, Select, Stack, Typography } from '@mui/joy';
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutline';
import { toast } from 'sonner';
import {
  CALLABLE_FUNCTION_DATA_LIMITS,
  type CallableFunctionSourceMode,
  type ICallableFunctionPublic,
} from '@bike4mind/common';
import { callableFunctionErrorMessage, useSetCallableFunctionSources } from '@client/app/hooks/data/callableFunctions';

const MODE_TEXT: Record<CallableFunctionSourceMode, string> = {
  live: 'fetched on every call',
  pinned: 'fetched at promotion',
};

/** The saved tool's sources: URLs on the listed data origins, read-only at `/data/<name>` in every call. */
export default function FunctionSourcesSection({ tool }: { tool: ICallableFunctionPublic }) {
  const save = useSetCallableFunctionSources();
  const [name, setName] = useState('');
  const [url, setUrl] = useState('');
  const [mode, setMode] = useState<CallableFunctionSourceMode>('live');
  const sources = tool.sources ?? [];
  const declared = sources.map(({ name: sourceName, url: sourceUrl, mode: sourceMode }) => ({
    name: sourceName,
    url: sourceUrl,
    mode: sourceMode,
  }));
  const full = tool.dataPins.length + sources.length >= CALLABLE_FUNCTION_DATA_LIMITS.maxPins;
  const onError = (error: unknown) => toast.error(callableFunctionErrorMessage(error, 'Could not change the sources.'));

  return (
    <Stack spacing={1} data-testid="python-function-sources">
      <Typography level="title-sm">Sources</Typography>
      <Typography level="body-xs" sx={{ color: 'text.secondary' }}>
        Read outside the sandbox from the data origins an administrator listed. Live sources are fetched on every call;
        pinned ones are fetched once at promotion. Changing them returns the tool to draft.
      </Typography>
      {sources.map(entry => (
        <Stack key={entry.name} direction="row" spacing={1} alignItems="center" data-testid="python-function-source">
          <Typography level="body-sm" sx={{ flex: 1, minWidth: 0, overflowWrap: 'anywhere' }} title={entry.url}>
            <code>/data/{entry.name}</code>{' '}
            <Typography component="span" level="body-xs" sx={{ color: 'text.secondary' }}>
              {entry.mode}, {MODE_TEXT[entry.mode]}, {entry.url}
              {entry.pinned ? `, sha256 ${entry.pinned.sha256.slice(0, 12)}...` : ''}
            </Typography>
          </Typography>
          <IconButton
            size="sm"
            variant="plain"
            color="neutral"
            aria-label={`Remove ${entry.name}`}
            disabled={save.isPending}
            onClick={() =>
              save.mutate({ id: tool.id, sources: declared.filter(source => source.name !== entry.name) }, { onError })
            }
          >
            <DeleteOutlineIcon />
          </IconButton>
        </Stack>
      ))}
      <Box
        component="form"
        sx={{ display: 'flex', gap: 1, flexWrap: 'wrap' }}
        onSubmit={(event: React.FormEvent) => {
          event.preventDefault();
          save.mutate(
            { id: tool.id, sources: [...declared, { name: name.trim(), url: url.trim(), mode }] },
            {
              onSuccess: () => {
                setName('');
                setUrl('');
              },
              onError,
            }
          );
        }}
      >
        <Input
          size="sm"
          placeholder="https://data.example.com/file.csv"
          value={url}
          onChange={event => setUrl(event.target.value)}
          slotProps={{ input: { 'aria-label': 'Source URL', 'data-testid': 'python-function-source-url' } }}
          sx={{ flex: '2 1 220px' }}
        />
        <Input
          size="sm"
          placeholder="Name under /data"
          value={name}
          onChange={event => setName(event.target.value)}
          slotProps={{ input: { 'aria-label': 'Source name', 'data-testid': 'python-function-source-name' } }}
          sx={{ flex: '1 1 140px' }}
        />
        <Select
          size="sm"
          value={mode}
          onChange={(_, value) => value && setMode(value)}
          aria-label="Source mode"
          data-testid="python-function-source-mode"
          sx={{ flex: '0 0 110px' }}
        >
          <Option value="live">Live</Option>
          <Option value="pinned">Pinned</Option>
        </Select>
        <Button
          size="sm"
          variant="outlined"
          color="neutral"
          type="submit"
          loading={save.isPending}
          disabled={full || !name.trim() || !url.trim()}
          data-testid="python-function-source-add-btn"
        >
          Add source
        </Button>
      </Box>
    </Stack>
  );
}
