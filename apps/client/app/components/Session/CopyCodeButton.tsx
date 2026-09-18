import { IconButton, Tooltip } from '@mui/joy';
import { Check, ContentCopy } from '@mui/icons-material';
import { useCopyToClipboard } from '@client/app/hooks/useCopyToClipboard';
import { CopyCodeButtonProps } from './types/UserPromptTypes';
import { actionButtonSx } from '@client/app/components/common/actionButtonSx';

/**
 * Copy control for a fenced code block. An icon, and an ordinary element in the flow - it
 * sits at the right of the block's header opposite the language.
 *
 * It used to be a labelled pill absolutely positioned over the block's top-right corner,
 * which forced 32px of top padding into every block to clear it - so the left side of every
 * snippet was pushed down by a control sitting on the right.
 */
export const CopyCodeButton: React.FC<CopyCodeButtonProps> = ({ code }) => {
  const { copied, handleCopyToClipboard } = useCopyToClipboard();

  return (
    <Tooltip title={copied ? 'Copied!' : 'Copy code to clipboard'} placement="top">
      <IconButton
        variant="plain"
        color="neutral"
        size="sm"
        aria-label="Copy code to clipboard"
        // The same recipe every artifact card's actions use, so a copy button is a copy
        // button wherever a reply puts one.
        // The same recipe every artifact card action uses, so a copy button is a copy
        // button wherever a reply puts one.
        sx={theme => ({ ...actionButtonSx(theme), flexShrink: 0 })}
        onClick={async () => handleCopyToClipboard(code)}
      >
        {copied ? <Check /> : <ContentCopy />}
      </IconButton>
    </Tooltip>
  );
};
