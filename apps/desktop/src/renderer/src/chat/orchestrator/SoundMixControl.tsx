import Slider from '@mui/joy/Slider';
import Stack from '@mui/joy/Stack';
import Switch from '@mui/joy/Switch';
import Typography from '@mui/joy/Typography';
import { SOUND_PACK_EVENTS } from '@shared/mods';
import { SOUND_EVENT_LABEL, setSoundEventEnabled, setSoundVolume, useSoundSettings } from './soundSettings';

/** Settings: the master volume and an on/off per event. The master switch (Play sounds) mutes all of it. */
export function SoundMixControl() {
  const { volume, toggles } = useSoundSettings();
  return (
    <Stack spacing={1.25} sx={{ maxWidth: 420 }} data-testid="sound-mix">
      <Stack direction="row" spacing={1.5} sx={{ alignItems: 'center' }}>
        <Typography level="body-sm" sx={{ width: 64 }}>
          Volume
        </Typography>
        <Slider
          size="sm"
          min={0}
          max={100}
          step={5}
          value={Math.round(volume * 100)}
          onChange={(_event, value) => setSoundVolume((Array.isArray(value) ? (value[0] ?? 0) : value) / 100)}
          valueLabelDisplay="auto"
          slotProps={{ input: { 'aria-label': 'Sound volume', 'data-testid': 'sound-volume-slider' } }}
        />
      </Stack>
      {SOUND_PACK_EVENTS.map(event => (
        <Stack key={event} direction="row" sx={{ alignItems: 'center', justifyContent: 'space-between' }}>
          <Typography level="body-sm">{SOUND_EVENT_LABEL[event]}</Typography>
          <Switch
            size="sm"
            checked={toggles[event]}
            onChange={changed => setSoundEventEnabled(event, changed.target.checked)}
            slotProps={{
              input: { 'aria-label': SOUND_EVENT_LABEL[event], 'data-testid': `sound-event-switch-${event}` },
            }}
          />
        </Stack>
      ))}
    </Stack>
  );
}
