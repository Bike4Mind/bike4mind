import { useEffect, useState } from 'react';
import Tooltip from '@mui/joy/Tooltip';
import Typography from '@mui/joy/Typography';
import type { ChatProject } from '@shared/chat';
import { projectSubtitle } from './projectSubtitle';

type CopyState = 'idle' | 'copied' | 'failed';

/** How long the copy outcome replaces the path in the tooltip, in ms. */
const FEEDBACK_MS = 1500;

/**
 * Project and branch under a Code session's title. The full working directory is one hover
 * away, and a click copies it, since that path is what a user wants to paste into a terminal.
 */
export function ProjectSubtitleLine({ project }: { project: ChatProject }) {
  const { label, path } = projectSubtitle(project);
  const [copy, setCopy] = useState<CopyState>('idle');

  useEffect(() => {
    if (copy === 'idle') return;
    const timer = window.setTimeout(() => setCopy('idle'), FEEDBACK_MS);
    return () => window.clearTimeout(timer);
  }, [copy]);

  const copyPath = async () => {
    try {
      await navigator.clipboard.writeText(path);
      setCopy('copied');
    } catch (error) {
      console.error('Copying the working directory to the clipboard failed', error);
      setCopy('failed');
    }
  };

  const tip = copy === 'copied' ? 'Copied the path' : copy === 'failed' ? 'Could not copy the path' : path;

  return (
    <Tooltip title={tip} size="sm" variant="soft" placement="bottom-start">
      <Typography
        component="button"
        type="button"
        level="body-xs"
        textColor="text.tertiary"
        noWrap
        onClick={() => void copyPath()}
        aria-label={`${label}. Copy the path ${path}`}
        data-copy-state={copy}
        data-testid="chat-project-cwd"
        sx={{
          display: 'block',
          maxWidth: '100%',
          p: 0,
          border: 0,
          background: 'none',
          textAlign: 'left',
          cursor: 'copy',
          '&:hover': { color: 'text.secondary' },
        }}
      >
        {label}
      </Typography>
    </Tooltip>
  );
}
