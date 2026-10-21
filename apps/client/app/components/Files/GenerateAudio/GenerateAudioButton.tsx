import { Button } from '@mui/joy';
import GraphicEqIcon from '@mui/icons-material/GraphicEq';
import { useNavigate } from '@tanstack/react-router';
import { useFileBrowserInstance } from '@client/app/components/Files/Browser/instanceContext';

/**
 * Audio is made in Studio now. Kept for one release so the old entry point still leads there, then removed along with
 * this folder.
 */
const GenerateAudioButton: React.FC = () => {
  const navigate = useNavigate();
  const { setOpen } = useFileBrowserInstance();

  const openSpeechStudio = () => {
    // The file browser is a modal over the page, so it has to close or it would cover Studio.
    setOpen(false);
    void navigate({ to: '/studio/$modality', params: { modality: 'speech' } });
  };

  return (
    <Button
      variant="outlined"
      color="neutral"
      size="sm"
      startDecorator={<GraphicEqIcon />}
      onClick={openSpeechStudio}
      data-testid="file-browser-generate-audio-btn"
    >
      Generate Audio
    </Button>
  );
};

export default GenerateAudioButton;
