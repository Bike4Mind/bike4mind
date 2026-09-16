import { useCopyToClipboard } from '@client/app/hooks/useCopyToClipboard';
import { IconButton, Tooltip } from '@mui/joy';
import LibraryAddCheckIcon from '@mui/icons-material/LibraryAddCheck';
import ContentCopyIcon from '@mui/icons-material/ContentCopy';
import { chatActionButtonSx } from './chatActionButtonSx';

const CopyTextButton: React.FC<{ text: string }> = ({ text }) => {
  const { copied, handleCopyToClipboard } = useCopyToClipboard();

  return (
    <Tooltip title={copied ? 'Copied to Clipboard!' : 'Copy to Clipboard'}>
      <IconButton
        sx={chatActionButtonSx}
        size="sm"
        variant="plain"
        color={copied ? 'success' : 'neutral'}
        onClick={() => handleCopyToClipboard(text)}
      >
        {copied ? <LibraryAddCheckIcon /> : <ContentCopyIcon />}
      </IconButton>
    </Tooltip>
  );
};

export default CopyTextButton;
