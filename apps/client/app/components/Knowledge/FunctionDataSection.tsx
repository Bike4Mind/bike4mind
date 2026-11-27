import React, { useState } from 'react';
import { Box, Button, IconButton, Input, Stack, Typography } from '@mui/joy';
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutline';
import { toast } from 'sonner';
import { CALLABLE_FUNCTION_DATA_LIMITS, type ICallableFunctionPublic } from '@bike4mind/common';
import {
  callableFunctionErrorMessage,
  usePinCallableFunctionData,
  useUnpinCallableFunctionData,
} from '@client/app/hooks/data/callableFunctions';

const sizeText = (bytes: number) =>
  bytes >= 1024 * 1024 ? `${(bytes / (1024 * 1024)).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;

/** The saved tool's data files: each read-only at `/data/<name>` in every call, browser and server alike. */
export default function FunctionDataSection({ tool }: { tool: ICallableFunctionPublic }) {
  const pin = usePinCallableFunctionData();
  const unpin = useUnpinCallableFunctionData();
  const [fileId, setFileId] = useState('');
  const [name, setName] = useState('');
  const used = tool.dataPins.length + (tool.sources?.length ?? 0);
  const full = used >= CALLABLE_FUNCTION_DATA_LIMITS.maxPins;
  const onError = (error: unknown) =>
    toast.error(callableFunctionErrorMessage(error, 'Could not change the data files.'));

  return (
    <Stack spacing={1} data-testid="python-function-data">
      <Typography level="title-sm">Data files</Typography>
      <Typography level="body-xs" sx={{ color: 'text.secondary' }}>
        Copied when pinned, so later changes to the file do not reach the tool. Changing them returns the tool to draft.{' '}
        {used} of {CALLABLE_FUNCTION_DATA_LIMITS.maxPins} with the sources.
      </Typography>
      {tool.dataPins.map(entry => (
        <Stack key={entry.name} direction="row" spacing={1} alignItems="center" data-testid="python-function-data-pin">
          <Typography level="body-sm" sx={{ flex: 1, minWidth: 0 }} title={entry.sha256}>
            <code>/data/{entry.name}</code>{' '}
            <Typography component="span" level="body-xs" sx={{ color: 'text.secondary' }}>
              {sizeText(entry.bytes)}, sha256 <code>{entry.sha256.slice(0, 12)}...</code>
            </Typography>
          </Typography>
          <IconButton
            size="sm"
            variant="plain"
            color="neutral"
            aria-label={`Remove ${entry.name}`}
            data-testid="python-function-data-unpin-btn"
            disabled={unpin.isPending}
            onClick={() => unpin.mutate({ id: tool.id, name: entry.name }, { onError })}
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
          pin.mutate(
            { id: tool.id, fileId: fileId.trim(), name: name.trim() },
            {
              onSuccess: () => {
                setFileId('');
                setName('');
              },
              onError,
            }
          );
        }}
      >
        <Input
          size="sm"
          placeholder="File id"
          value={fileId}
          onChange={event => setFileId(event.target.value)}
          slotProps={{ input: { 'aria-label': 'File id', 'data-testid': 'python-function-data-file-id' } }}
          sx={{ flex: '1 1 160px' }}
        />
        <Input
          size="sm"
          placeholder="Name under /data"
          value={name}
          onChange={event => setName(event.target.value)}
          slotProps={{ input: { 'aria-label': 'Name under /data', 'data-testid': 'python-function-data-name' } }}
          sx={{ flex: '1 1 140px' }}
        />
        <Button
          size="sm"
          variant="outlined"
          color="neutral"
          type="submit"
          loading={pin.isPending}
          disabled={full || !fileId.trim() || !name.trim()}
          data-testid="python-function-data-pin-btn"
        >
          Pin file
        </Button>
      </Box>
    </Stack>
  );
}
