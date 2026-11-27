import React, { useRef, useState } from 'react';
import { Box, Button, IconButton, Input, Stack, Typography } from '@mui/joy';
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutline';
import InsertDriveFileOutlinedIcon from '@mui/icons-material/InsertDriveFileOutlined';
import { toast } from 'sonner';
import {
  CALLABLE_FUNCTION_DATA_LIMITS,
  CALLABLE_FUNCTION_DATA_PIN_NAME_PATTERN,
  type ICallableFunctionPublic,
  type IFabFileDocument,
} from '@bike4mind/common';
import EmbeddedFileBrowser, { type EmbeddedFileBrowserHandle } from '@client/app/components/Files/EmbeddedFileBrowser';
import {
  callableFunctionErrorMessage,
  usePinCallableFunctionData,
  useUnpinCallableFunctionData,
} from '@client/app/hooks/data/callableFunctions';

const sizeText = (bytes: number) => {
  if (bytes < 1024) return `${bytes} ${bytes === 1 ? 'byte' : 'bytes'}`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
};

/** The picked file's name as a `/data` name, or empty when nothing of it fits the pattern. */
const dataName = (fileName: string) => {
  const name = fileName
    .replace(/[^A-Za-z0-9._-]+/g, '_')
    .replace(/^[^A-Za-z0-9]+/, '')
    .slice(0, 64);
  return CALLABLE_FUNCTION_DATA_PIN_NAME_PATTERN.test(name) ? name : '';
};

/** The saved tool's data files: each read-only at `/data/<name>` in every call, browser and server alike. */
export default function FunctionDataSection({ tool }: { tool: ICallableFunctionPublic }) {
  const pin = usePinCallableFunctionData();
  const unpin = useUnpinCallableFunctionData();
  const browser = useRef<EmbeddedFileBrowserHandle>(null);
  const [file, setFile] = useState<Pick<IFabFileDocument, 'id' | 'fileName'> | null>(null);
  const [name, setName] = useState('');
  const autoName = useRef('');
  const used = tool.dataPins.length;
  const full = used >= CALLABLE_FUNCTION_DATA_LIMITS.maxPins;
  const onError = (error: unknown) =>
    toast.error(callableFunctionErrorMessage(error, 'Could not change the data files.'));

  const onPicked = (files: IFabFileDocument[]) => {
    if (files.length !== 1) {
      toast.error('Pick one file at a time.');
      return;
    }
    const [picked] = files;
    setFile({ id: picked!.id, fileName: picked!.fileName });
    if (!name.trim() || name === autoName.current) {
      autoName.current = dataName(picked!.fileName);
      setName(autoName.current);
    }
  };

  return (
    <Stack spacing={1} data-testid="python-function-data">
      <Typography level="title-sm">Data files</Typography>
      <Typography level="body-xs" sx={{ color: 'text.secondary' }}>
        Copied when pinned, so later changes to the file do not reach the tool. Changing them returns the tool to draft.{' '}
        {used} of {CALLABLE_FUNCTION_DATA_LIMITS.maxPins} used.
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
          if (!file) return;
          pin.mutate(
            { id: tool.id, fileId: file.id, name: name.trim() },
            {
              onSuccess: () => {
                setFile(null);
                setName('');
              },
              onError,
            }
          );
        }}
      >
        <Button
          size="sm"
          variant="outlined"
          color="neutral"
          startDecorator={<InsertDriveFileOutlinedIcon />}
          disabled={full}
          onClick={() => browser.current?.handleOpen()}
          data-testid="python-function-data-choose-btn"
          sx={{ flex: '1 1 160px', justifyContent: 'flex-start', minWidth: 0 }}
        >
          <Box
            component="span"
            sx={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
            data-testid="python-function-data-chosen"
          >
            {file ? file.fileName : 'Choose a file'}
          </Box>
        </Button>
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
          disabled={full || !file || !name.trim()}
          data-testid="python-function-data-pin-btn"
        >
          Pin file
        </Button>
      </Box>
      <EmbeddedFileBrowser ref={browser} addButtonLabelKey="file_browser.use_files_as_data" onAdd={onPicked} />
    </Stack>
  );
}
