import { Button, Tooltip } from '@mui/joy';
import { Check, ContentCopy } from '@mui/icons-material';
import { useCopyToClipboard } from '@client/app/hooks/useCopyToClipboard';
import { CopyCodeButtonProps } from './types/UserPromptTypes';

export const CopyCodeButton: React.FC<CopyCodeButtonProps> = ({ code, language = 'plain' }) => {
  const { copied, handleCopyToClipboard } = useCopyToClipboard();

  return (
    <Tooltip title={copied ? 'Copied!' : 'Copy code to clipboard'} placement="top">
      <Button
        variant="soft"
        size="sm"
        sx={_theme => ({
          position: 'absolute',
          right: 0,
          top: 0,
          borderRadius: '0 0 0 5px',
          backgroundColor: 'neutral.500',
          color: 'neutral.50',
          '&:hover': {
            backgroundColor: 'neutral.600',
            color: 'neutral.100',
          },
          '&:active': {
            color: 'neutral.50',
          },
        })}
        onClick={async () => handleCopyToClipboard(code)}
        endDecorator={copied ? <Check /> : <ContentCopy />}
      >
        <code>{language}</code>
      </Button>
    </Tooltip>
  );
};
