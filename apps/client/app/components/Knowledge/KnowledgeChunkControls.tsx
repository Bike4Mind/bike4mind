import React, { useEffect, useState } from 'react';
import { Box, Button, CircularProgress, Input, Stack, Tooltip, Typography } from '@mui/joy';
import SegmentIcon from '@mui/icons-material/Segment';
import CheckIcon from '@mui/icons-material/Check';
import { IFabFileDocument } from '@bike4mind/common';
import { useChunkFile } from '@client/app/hooks/data/fabFiles';
import { useServerSettings } from '@client/app/contexts/UserSettingsContext';
import { toast } from 'sonner';
import { updateFileUtility } from '@client/app/utils/filesAPICalls';
import { useQueryClient } from '@tanstack/react-query';

interface IKnowledgeChunkControlsProps {
  fabFile: IFabFileDocument | null;
}

export const KnowledgeChunkControls: React.FC<IKnowledgeChunkControlsProps> = ({ fabFile }) => {
  const { serverSettings } = useServerSettings();
  const defaultChunkSizeSetting = serverSettings.find(setting => setting.settingName === 'DefaultChunkSize');
  const [chunkSize, setChunkSize] = useState<number>(
    defaultChunkSizeSetting ? parseInt(defaultChunkSizeSetting.settingValue, 10) : 2000
  );
  const [chunkSizeDisplay, setChunkSizeDisplay] = useState<string>(`${chunkSize} tokens`);
  const queryClient = useQueryClient();
  const [recheckingVectorization, setRecheckingVectorization] = useState<boolean>(false);

  const chunkFileFn = useChunkFile();

  useEffect(() => {
    setChunkSizeDisplay(`${chunkSize} tokens`);
  }, [chunkSize]);

  return (
    <Box
      sx={{
        display: 'flex',
        flexDirection: 'column',
        flexGrow: 1,
        width: '100%',
        backgroundColor: 'background.level1',
        border: '1px solid',
        borderColor: 'border.solid',
        borderRadius: '5px',
        justifyContent: 'space-between',
        padding: '10px',
        height: '100%',
      }}
    >
      <Stack direction="row" spacing={2} justifyContent="space-between">
        <Typography>Chunks &amp; Vectorize</Typography>
        <Tooltip title="Chunking breaks your file into smaller pieces.">
          <Input
            type="string"
            color="success"
            value={chunkSizeDisplay}
            onChange={e => setChunkSizeDisplay(e.target.value)}
            onBlur={e => {
              setChunkSizeDisplay(`${chunkSize} tokens`);
              setChunkSize(Number(e.target.value));
            }}
            onFocus={() => {
              setChunkSizeDisplay(chunkSizeDisplay.replace(' tokens', ''));
            }}
            onKeyDown={e => {
              if (e.key === 'Enter') e.currentTarget.blur();
            }}
            size="sm"
          />
        </Tooltip>
      </Stack>

      <Typography level="body-sm">
        Break your larger files into chunks with a target token size and vectorize them for semantic search.
      </Typography>
      <Typography level="body-sm">Hint: 300–1200 are good token sizes for chunks.</Typography>
      <Typography level="body-sm">Note: Vectors consume token credits.</Typography>

      <Stack direction="row" spacing={2} justifyContent="space-between">
        <Tooltip title="Chunking breaks your file into smaller pieces, while vectorizing creates a vector representation of your chunks.">
          <Button
            color="success"
            variant="solid"
            fullWidth
            disabled={
              !fabFile ||
              fabFile.isChunking ||
              fabFile.isVectorizing ||
              (fabFile.chunked && fabFile.vectorized) ||
              chunkFileFn.isPending
            }
            onClick={() => {
              toast.info(`Starting to chunk "${fabFile?.fileName}" Please check back in ten minutes.`);
              chunkFileFn.mutate(
                { fabFileId: fabFile?.id || '', chunkSize },
                {
                  onSuccess: () => {
                    toast.success(`Successfully chunked and vectorized "${fabFile?.fileName}"`);
                  },
                  onError: (error: any) => {
                    toast.error(`Failed to chunk and vectorize: ${error?.message || 'Unknown error'}`);
                  },
                }
              );
            }}
          >
            {fabFile?.chunked && fabFile?.vectorized ? <CheckIcon sx={{ marginRight: 1 }} /> : null}
            {chunkFileFn.isPending || fabFile?.isChunking || fabFile?.isVectorizing ? (
              <CircularProgress sx={{ marginRight: 1 }} />
            ) : (
              <SegmentIcon sx={{ marginRight: 1 }} />
            )}
            <Typography>
              {fabFile?.isChunking || fabFile?.isVectorizing
                ? fabFile.isChunking
                  ? 'Chunking...'
                  : 'Vectorizing...'
                : fabFile?.chunked && fabFile?.vectorized
                  ? 'Chunked & Vectorized'
                  : 'Chunk & Vectorize'}
            </Typography>
          </Button>
        </Tooltip>

        {/* Clear file error when vectorize succeeded */}
        {fabFile?.error && fabFile?.vectorized && (
          <Button
            color="success"
            variant="solid"
            onClick={async () => {
              setRecheckingVectorization(true);
              await updateFileUtility(fabFile?.id || '', {
                fileName: fabFile?.fileName,
                mimeType: fabFile?.mimeType,
                type: fabFile?.type,
                error: null,
              });

              await queryClient.invalidateQueries({ queryKey: ['fabFiles'] });

              toast.success(`Successfully vectorized "${fabFile?.fileName}"`);
              setRecheckingVectorization(false);
            }}
          >
            Recheck vectorization error
            {/* add loading state */}
            {recheckingVectorization ? <CircularProgress size="sm" /> : null}
          </Button>
        )}
      </Stack>
    </Box>
  );
};

export default KnowledgeChunkControls;
