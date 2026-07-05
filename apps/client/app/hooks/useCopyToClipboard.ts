import { useEffect, useState } from 'react';
import { toast } from 'sonner';

interface Props {
  showToast?: boolean;
}

export function useCopyToClipboard(
  { showToast }: Props = {
    showToast: false,
  }
) {
  const [copied, setCopied] = useState(false);

  const handleCopyToClipboard = (text: string) => {
    navigator.clipboard
      .writeText(text)
      .then(() => {
        setCopied(true);
        if (showToast) toast.success('Copied to clipboard');
      })
      .catch(err => {
        console.error('Could not copy text: ', err);
      });
  };

  // Reset copied state after 2 seconds
  useEffect(() => {
    if (!copied) return;
    const timeout = setTimeout(() => setCopied(false), 2000);

    return () => {
      clearTimeout(timeout);
    };
  }, [copied]);

  return {
    copied,
    handleCopyToClipboard,
  };
}
