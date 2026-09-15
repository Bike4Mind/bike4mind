import { Box, Typography, Link, IconButton, LinearProgress, Chip, Button, Tooltip } from '@mui/joy';
import { FC, useState } from 'react';
import { OpenInNew, FileDownload, AttachFile } from '@mui/icons-material';
import { DiscoveredLink } from '@bike4mind/common';
import axios from 'axios';
import { getFabFileByIdFromServer } from '@client/app/utils/filesAPICalls';
import { useSessions, useWorkBenchActions } from '@client/app/contexts/SessionsContext';

interface ResearchTaskDiscoveredLinkProps {
  link: DiscoveredLink;
  getFabFileId: (researchDataId: string) => string | undefined;
}

const ResearchTaskDiscoveredLink: FC<ResearchTaskDiscoveredLinkProps> = ({ link, getFabFileId }) => {
  const relevanceValue = (link.relevance ?? 0) * 100;
  const { currentSessionId } = useSessions();
  const { setWorkBenchFiles } = useWorkBenchActions();
  const [isAttaching, setIsAttaching] = useState(false);

  const getProgressColor = (value: number) => {
    if (value >= 80) return 'success';
    if (value >= 50) return 'warning';
    return 'danger';
  };

  async function handleAttachFile() {
    setIsAttaching(true);
    if (link.researchDataId) {
      const fabFileId = getFabFileId(link.researchDataId);
      console.log('fabFileId', fabFileId);
      if (fabFileId && currentSessionId) {
        const response = await getFabFileByIdFromServer(fabFileId);
        if (response) {
          setWorkBenchFiles(currentSessionId, prev => [...prev, response]);
        }
      }
    }
    setIsAttaching(false);
  }

  function handleDownload() {
    axios
      .get(link.url, {
        responseType: 'arraybuffer',
      })
      .then(response => {
        // Get file extension from URL or default to .doc for Office documents
        const fileExt = link.url.split('.').pop()?.toLowerCase() || 'doc';
        const mimeType =
          {
            doc: 'application/msword',
            docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
            pdf: 'application/pdf',
            txt: 'text/plain',
            mp4: 'video/mp4',
            mp3: 'audio/mpeg',
            wav: 'audio/wav',
          }[fileExt] || 'application/octet-stream';

        const url = window.URL.createObjectURL(new Blob([response.data], { type: mimeType }));
        const downloadLink = document.createElement('a');
        downloadLink.href = url;
        // Use original filename if available, or create one with proper extension
        const filename = `${link.text || 'document'}.${fileExt}`;
        downloadLink.setAttribute('download', filename);
        document.body.appendChild(downloadLink);
        downloadLink.click();
        document.body.removeChild(downloadLink);
        window.URL.revokeObjectURL(url);
      });
  }

  return (
    <Box
      sx={{
        display: 'flex',
        alignItems: 'center',
        gap: 2,
        p: 2,
        borderRadius: 'sm',
        bgcolor: 'background.level1',
        '&:hover': {
          bgcolor: 'background.level2',
        },
      }}
    >
      {/* Link Title - 40% */}
      <Box sx={{ flex: '0 0 40%', display: 'flex', flexDirection: 'column', gap: 1, minWidth: 0 }}>
        <Link
          href={link.url}
          target="_blank"
          endDecorator={<OpenInNew />}
          sx={{
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            display: 'flex',
            alignItems: 'center',
            gap: 1,
            width: '100%',
            '& svg': {
              flexShrink: 0,
            },
          }}
        >
          <Typography noWrap>{link.text}</Typography>
        </Link>
        <Typography
          level="body-xs"
          sx={{
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            width: '100%',
          }}
        >
          {link.url}
        </Typography>
        {link.sourceUrl && (
          <Typography level="body-xs" sx={{ color: 'text.tertiary' }}>
            <strong>Source:</strong> {link.sourceUrl}
          </Typography>
        )}
      </Box>

      {/* Relevance - 30% */}
      <Box sx={{ flex: '0 0 30%', display: 'flex', flexDirection: 'column', gap: '5px', minWidth: 0 }}>
        {link.isRecommended && (
          <Chip size="sm" variant="soft" color="success" sx={{ maxWidth: 'fit-content' }}>
            Recommended
          </Chip>
        )}
        <Box display="flex" alignItems="center" gap="5px">
          <LinearProgress
            determinate
            value={relevanceValue}
            color={getProgressColor(relevanceValue)}
            sx={{
              flex: 1,
              '--LinearProgress-radius': '8px',
              '--LinearProgress-thickness': '8px',
            }}
          />
          <Typography level="body-xs" sx={{ minWidth: '45px' }}>
            {relevanceValue.toFixed(0)}%
          </Typography>
        </Box>
      </Box>

      {/* File Type - 10% */}
      <Typography
        level="body-xs"
        sx={{ flex: '0 0 10%', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
      >
        {link.fileType}
      </Typography>

      {/* Actions - 20% */}
      <Box sx={{ flex: '0 0 10%', display: 'flex', justifyContent: 'flex-end', gap: '10px', ml: 'auto' }}>
        {link.isDownloadable && !link.researchDataId && (
          <Tooltip title="Save to storage">
            <IconButton size="sm" variant="outlined" color="neutral" onClick={handleDownload}>
              <FileDownload /> Save
            </IconButton>
          </Tooltip>
        )}
        {link.researchDataId && (
          <Tooltip title="Attach file">
            <Button
              variant="outlined"
              color="neutral"
              size="sm"
              sx={{ gap: '5px' }}
              onClick={handleAttachFile}
              loading={isAttaching}
            >
              <AttachFile />
            </Button>
          </Tooltip>
        )}
      </Box>
    </Box>
  );
};

export default ResearchTaskDiscoveredLink;
