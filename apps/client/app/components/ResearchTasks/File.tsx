import { IResearchDataWithFiles } from '@bike4mind/common';
import { useSessions, useWorkBenchStore } from '@client/app/contexts/SessionsContext';
import { useChunkFile } from '@client/app/hooks/data/fabFiles';
import { useDeleteResearchData } from '@client/app/hooks/data/researchData';
import { useConfirmation } from '@client/app/hooks/useConfirmation';
import { IFabFileDocument } from '@bike4mind/common';
import { AttachFile } from '@mui/icons-material';
import { Box, Button, Chip, IconButton, Tooltip, Typography } from '@mui/joy';
import VisibilityOutlinedIcon from '@mui/icons-material/VisibilityOutlined';
import DeleteOutlinedIcon from '@mui/icons-material/DeleteOutlined';
import FileDownloadOutlinedIcon from '@mui/icons-material/FileDownloadOutlined';
import GroupOutlinedIcon from '@mui/icons-material/GroupOutlined';
import { FC } from 'react';
import { useUser } from '@client/app/contexts/UserContext';

interface ResearchTaskFileProps {
  researchData: IResearchDataWithFiles;
  onView: () => void;
}

const ResearchTaskFile: FC<ResearchTaskFileProps> = ({ researchData, onView }) => {
  const { fabFile } = researchData;
  const { currentSessionId } = useSessions();
  const { currentUser } = useUser();
  const { setWorkBenchFiles } = useWorkBenchStore();
  const { mutate: chunkFile, isPending } = useChunkFile();
  const { mutate: deleteResearchData, isPending: isDeleting } = useDeleteResearchData();
  const confirm = useConfirmation();

  async function handleAttachFile() {
    if (!currentSessionId) return;
    setWorkBenchFiles(currentSessionId, prev => [...prev, fabFile as unknown as IFabFileDocument]);
  }

  async function handleDeleteFile() {
    confirm({
      title: 'Delete Research Data',
      description: 'Are you sure you want to delete this data?',
      type: 'danger',
      onOk: () => {
        deleteResearchData(researchData);
      },
    });
  }

  async function handleDownloadFile() {
    try {
      if (!fabFile.fileUrl) return;

      const response = await fetch(fabFile.fileUrl);
      const blob = await response.blob();

      const url = window.URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = fabFile.fileName || 'download';
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      window.URL.revokeObjectURL(url);
    } catch (error) {
      console.error('Download failed:', error);
    }
  }

  const notOwned = fabFile.userId !== currentUser?.id;

  return (
    <Box
      sx={{
        display: 'flex',
        alignItems: 'center',
        paddingX: '10px',
        paddingY: '5px',
        marginBottom: '10px',
        borderRadius: '8px',
        backgroundColor: 'background.level1',
      }}
    >
      {/* File information */}
      <Typography
        level="body-sm"
        sx={{ flex: '1 1 auto', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
      >
        {fabFile.fileName}
      </Typography>

      {/* File size */}
      <Typography level="body-xs" sx={{ flex: '0 0 10%', color: 'text.secondary', marginLeft: '10px' }}>
        {fabFile.fileSize ? `${(fabFile.fileSize / 1024).toFixed(1)} KB` : 'Unknown size'}
      </Typography>

      {/* Status chips */}
      <Box sx={{ flex: '0 0 20%', display: 'flex', gap: '5px', marginLeft: '10px' }}>
        {fabFile.chunked && (
          <Chip variant="soft" color="success" size="sm">
            Chunked
          </Chip>
        )}
        {fabFile.isChunking && (
          <Chip variant="soft" color="warning" size="sm">
            Chunking...
          </Chip>
        )}
        {fabFile.vectorized && (
          <Chip variant="soft" color="primary" size="sm">
            Vectorized
          </Chip>
        )}
        {notOwned && (
          <Tooltip title="Shared with me">
            <GroupOutlinedIcon />
          </Tooltip>
        )}
      </Box>

      {/* Actions */}
      <Box
        sx={{
          flex: '0 0 20%',
          display: 'flex',
          justifyContent: 'flex-end',
          gap: '10px',
          ml: 'auto',
          alignItems: 'center',
        }}
      >
        {!fabFile.chunked && !fabFile.isChunking && (
          <Button
            variant="outlined"
            color="primary"
            onClick={() => chunkFile({ fabFileId: fabFile.id, chunkSize: 1000 })}
            loading={isPending}
            size="sm"
            sx={{ flexShrink: 0 }}
          >
            Chunk
          </Button>
        )}
        <Tooltip title="View file">
          <IconButton variant="outlined" color="primary" size="sm" sx={{ gap: '5px', flexShrink: 0 }} onClick={onView}>
            <VisibilityOutlinedIcon />
          </IconButton>
        </Tooltip>
        <Tooltip title="Download file">
          <IconButton
            variant="outlined"
            color="primary"
            size="sm"
            sx={{ gap: '5px', flexShrink: 0 }}
            onClick={handleDownloadFile}
          >
            <FileDownloadOutlinedIcon />
          </IconButton>
        </Tooltip>
        <Tooltip title="Attach file">
          <IconButton
            variant="outlined"
            color="primary"
            size="sm"
            sx={{ gap: '5px', flexShrink: 0 }}
            onClick={handleAttachFile}
          >
            <AttachFile />
          </IconButton>
        </Tooltip>
        <Tooltip title="Delete file">
          <IconButton
            variant="outlined"
            color="danger"
            size="sm"
            sx={{ gap: '5px', flexShrink: 0 }}
            onClick={handleDeleteFile}
            loading={isDeleting}
          >
            <DeleteOutlinedIcon />
          </IconButton>
        </Tooltip>
      </Box>
    </Box>
  );
};

export default ResearchTaskFile;
