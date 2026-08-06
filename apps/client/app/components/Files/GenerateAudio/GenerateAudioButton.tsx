import { useState } from 'react';
import { Button } from '@mui/joy';
import GraphicEqIcon from '@mui/icons-material/GraphicEq';
import GenerateAudioModal from './GenerateAudioModal';

/**
 * Files Manager entry point for the in-app audio generator (#1055), sitting
 * beside Upload. Owns its own modal-open state so it can drop into the toolbar
 * as a single self-contained affordance.
 */
const GenerateAudioButton: React.FC = () => {
  const [open, setOpen] = useState(false);

  return (
    <>
      <Button
        variant="outlined"
        color="neutral"
        size="sm"
        startDecorator={<GraphicEqIcon />}
        onClick={() => setOpen(true)}
        data-testid="file-browser-generate-audio-btn"
      >
        Generate Audio
      </Button>
      <GenerateAudioModal open={open} onClose={() => setOpen(false)} />
    </>
  );
};

export default GenerateAudioButton;
