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
        sx={{
          ...chatActionButtonSx,
          // 14px, not the row's 16: the copy glyph is two filled sheets and reads larger
          // than the open outlines beside it at the same box size.
          '--Icon-fontSize': '14px',
          '& svg': { width: '14px', height: '14px' },
        }}
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
