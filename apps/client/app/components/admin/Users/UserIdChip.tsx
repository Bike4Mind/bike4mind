import CheckIcon from '@mui/icons-material/Check';
import ContentCopyIcon from '@mui/icons-material/ContentCopy';
import { Chip, Tooltip } from '@mui/joy';
import React, { useEffect, useRef, useState } from 'react';

interface UserIdChipProps {
  userId: string;
}

export const truncateUserId = (userId: string): string =>
  userId.length > 12 ? `${userId.slice(0, 6)}\u2026${userId.slice(-4)}` : userId;

const UserIdChip: React.FC<UserIdChipProps> = ({ userId }) => {
  const [copied, setCopied] = useState(false);
  const resetTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => () => clearTimeout(resetTimer.current), []);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(userId);
      setCopied(true);
      clearTimeout(resetTimer.current);
      resetTimer.current = setTimeout(() => setCopied(false), 1500);
    } catch (err) {
      console.error('Failed to copy user id:', err);
    }
  };

  return (
    <Tooltip title={copied ? 'Copied' : userId} placement="top">
      <Chip
        data-testid="admin-user-id-chip"
        size="sm"
        variant="outlined"
        color={copied ? 'success' : 'neutral'}
        onClick={handleCopy}
        endDecorator={copied ? <CheckIcon sx={{ fontSize: 12 }} /> : <ContentCopyIcon sx={{ fontSize: 12 }} />}
        sx={{ fontFamily: 'monospace', fontSize: '11px', maxWidth: '100%' }}
      >
        {truncateUserId(userId)}
      </Chip>
    </Tooltip>
  );
};

export default UserIdChip;
