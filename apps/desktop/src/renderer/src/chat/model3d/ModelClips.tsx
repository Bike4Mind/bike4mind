import Button from '@mui/joy/Button';
import Stack from '@mui/joy/Stack';
import Typography from '@mui/joy/Typography';

type Props = {
  clips: string[];
  /** The clip looping in the viewer, if any. */
  playing: string | null;
  onPlay(clip: string | null): void;
};

/** An opened asset's animations, one play button each; starting one stops the other. */
export function ModelClips({ clips, playing, onPlay }: Props) {
  return (
    <Stack spacing={0.5} sx={{ px: 1.5, pt: 1 }} data-testid="model-pane-clips">
      <Typography level="body-xs" fontWeight="lg">
        Animations
      </Typography>
      {clips.map(clip => (
        <Stack key={clip} direction="row" alignItems="center" justifyContent="space-between" spacing={1.25}>
          <Typography level="body-xs" noWrap title={clip}>
            {clip}
          </Typography>
          <Button
            size="sm"
            variant={playing === clip ? 'soft' : 'plain'}
            color="neutral"
            onClick={() => onPlay(playing === clip ? null : clip)}
            data-testid={`model-pane-clip-${clip}`}
          >
            {playing === clip ? 'Stop' : 'Play'}
          </Button>
        </Stack>
      ))}
    </Stack>
  );
}
