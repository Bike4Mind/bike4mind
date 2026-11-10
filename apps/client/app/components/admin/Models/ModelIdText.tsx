import { useState } from 'react';
import { IconButton, Stack, Tooltip, Typography } from '@mui/joy';
import CheckRoundedIcon from '@mui/icons-material/CheckRounded';
import ContentCopyRoundedIcon from '@mui/icons-material/ContentCopyRounded';

/** A model id on one line: truncated with the full id on hover, and a copy button (DESIGN_GUIDE.md narrow screens). */
export function ModelIdText({
  id,
  'data-testid': testId = 'models-id-copy-btn',
}: {
  id: string;
  'data-testid'?: string;
}) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(id);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };
  return (
    <Stack direction="row" alignItems="center" gap={0.5} sx={{ minWidth: 0 }}>
      <Typography
        component="span"
        title={id}
        sx={{
          fontFamily: 'code',
          fontSize: 12,
          color: 'admin.inkMuted',
          whiteSpace: 'nowrap',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          minWidth: 0,
        }}
      >
        {id}
      </Typography>
      <Tooltip title={copied ? 'Copied' : 'Copy model id'}>
        <IconButton
          size="sm"
          variant="plain"
          aria-label="Copy model id"
          onClick={() => void copy()}
          data-testid={testId}
          sx={{ '--IconButton-size': '22px', minHeight: 22, minWidth: 22, flexShrink: 0, color: 'admin.inkMuted' }}
        >
          {copied ? <CheckRoundedIcon sx={{ fontSize: 14 }} /> : <ContentCopyRoundedIcon sx={{ fontSize: 13 }} />}
        </IconButton>
      </Tooltip>
    </Stack>
  );
}
