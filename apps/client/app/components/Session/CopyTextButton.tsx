import { useCopyToClipboard } from '@client/app/hooks/useCopyToClipboard';
import { IconButton, Tooltip } from '@mui/joy';
import LibraryAddCheckIcon from '@mui/icons-material/LibraryAddCheck';
import ContentCopyIcon from '@mui/icons-material/ContentCopy';

const CopyTextButton: React.FC<{ text: string }> = ({ text }) => {
  const { copied, handleCopyToClipboard } = useCopyToClipboard();

  return (
    <Tooltip title={copied ? 'Copied to Clipboard!' : 'Copy to Clipboard'}>
      <IconButton
        sx={{
          flexShrink: '0',
          borderRadius: '6px',
          '& svg': {
            width: '16px',
            height: '16px',
          },
        }}
        size="sm"
        variant={'outlined'}
        color={copied ? 'success' : 'neutral'}
        onClick={() => handleCopyToClipboard(text)}
      >
        {copied ? <LibraryAddCheckIcon sx={{ fontSize: 16 }} /> : <ContentCopyIcon sx={{ fontSize: 16 }} />}
      </IconButton>
    </Tooltip>
  );
};

export default CopyTextButton;
