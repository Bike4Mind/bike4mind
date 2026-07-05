import { useState } from 'react';
import { Button } from '@mui/joy';
import ContentCopyIcon from '@mui/icons-material/ContentCopy';
import CheckIcon from '@mui/icons-material/Check';

interface CopyButtonProps {
  text: string;
  label?: string;
  size?: 'sm' | 'md' | 'lg';
}

const CopyButton = ({ text, label = 'Copy', size = 'sm' }: CopyButtonProps) => {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (err) {
      console.error('Failed to copy:', err);
    }
  };

  return (
    <Button
      size={size}
      variant="outlined"
      color={copied ? 'success' : 'neutral'}
      startDecorator={copied ? <CheckIcon /> : <ContentCopyIcon />}
      onClick={handleCopy}
    >
      {copied ? 'Copied!' : label}
    </Button>
  );
};

export default CopyButton;
