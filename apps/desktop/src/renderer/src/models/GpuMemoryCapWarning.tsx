import { useEffect, useState } from 'react';
import Alert from '@mui/joy/Alert';
import Box from '@mui/joy/Box';
import Button from '@mui/joy/Button';
import Typography from '@mui/joy/Typography';
import { formatMemory, type GpuMemoryCap } from '@shared/models';

// Survives leaving the screen; a server's entry goes once main reports no limit there, so a new one shows again.
const dismissed = new Set<string>();

function loadedText(cap: GpuMemoryCap): string {
  const known = (bytes: number) => Number.isFinite(bytes) && bytes > 0;
  return known(cap.sizeBytes) && known(cap.gpuBytes)
    ? `${cap.model} loaded with ${formatMemory(cap.gpuBytes)} of its ${formatMemory(cap.sizeBytes)} on the GPU`
    : `${cap.model} loaded partly on the CPU`;
}

/** `cap` undefined: not known yet, which neither shows nor clears a dismissal. */
export function GpuMemoryCapWarning({ serverId, cap }: { serverId: string; cap: GpuMemoryCap | null | undefined }) {
  const [, setDismissals] = useState(0);
  useEffect(() => {
    if (cap === null) dismissed.delete(serverId);
  }, [serverId, cap]);
  if (!cap || dismissed.has(serverId)) return null;
  return (
    <Alert
      color="warning"
      variant="soft"
      data-testid="models-gpu-cap-warning"
      sx={{ alignItems: 'flex-start' }}
      endDecorator={
        <Button
          size="sm"
          variant="plain"
          color="warning"
          onClick={() => {
            dismissed.add(serverId);
            setDismissals(count => count + 1);
          }}
          data-testid="models-gpu-cap-dismiss-btn"
        >
          Dismiss
        </Button>
      }
    >
      <Box>
        <Typography level="title-sm">Ollama in WSL is using less GPU memory than this computer has</Typography>
        <Typography level="body-sm" sx={{ mt: 0.5 }}>
          {loadedText(cap)}. This Ollama limits GPU memory to the WSL virtual machine's memory, so models larger than
          that run partly on the CPU and reply slowly, even when their badge here says they fit.
        </Typography>
        <Typography level="body-sm" sx={{ mt: 0.5 }}>
          To use all of the GPU memory, update Ollama in WSL to a version that fixes this. Until then, give WSL more
          memory (the memory setting in .wslconfig, then restart WSL), or pick models that fit in the memory WSL has.
        </Typography>
      </Box>
    </Alert>
  );
}
