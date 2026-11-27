import { useState } from 'react';
import { Button, Stack, Typography } from '@mui/joy';
import { defaultStudioTimeline, STUDIO_COMPOSITION_TEMPLATE_DEFINITIONS } from '@bike4mind/common';
import { StudioPanel, StudioSectionLabel } from '../design/StudioPanel';
import TimelinePreview from '../productions/TimelinePreview';
import type { TimelineFile } from '../productions/useTimelineFiles';
import { usePlaybackClock, usePlaybackTime } from '../productions/usePlaybackClock';

const template = STUDIO_COMPOSITION_TEMPLATE_DEFINITIONS.ad_campaign;
const lines = [
  'Make room for your next idea.',
  'Meet your everyday notebook.',
  'Small enough to go everywhere.',
  'Start your next chapter.',
];
const shotDurationMs = template.durationMs / template.starterShots.length;
const timeline = defaultStudioTimeline('ad_campaign');
timeline.backgroundColor = '#172B39';
timeline.tracks = [
  {
    id: 'sample-titles',
    kind: 'captions',
    enabled: true,
    clips: lines.map((text, index) => ({
      id: `sample-title-${index}`,
      text,
      startMs: index * shotDurationMs,
      durationMs: shotDurationMs,
      style: { position: 'center', align: 'center', fontSizePct: 7, maxWidthPct: 80, color: '#FFFFFF' },
    })),
  },
];
const files = new Map<string, TimelineFile>();
const ignoreSourceDuration = () => {};

const ProductionsShowcase = () => {
  const [outputId, setOutputId] = useState(timeline.outputs[0].id);
  const clock = usePlaybackClock(timeline.durationMs);
  const timeMs = usePlaybackTime(clock);
  const output = timeline.outputs.find(candidate => candidate.id === outputId) ?? timeline.outputs[0];

  return (
    <StudioPanel testId="productions-showcase" aria-label="Read-only sample production">
      <Stack spacing={2}>
        <StudioSectionLabel>Read-only sample / Ad campaign / 15s</StudioSectionLabel>
        <Typography level="title-lg" component="h2">
          An everyday notebook, in four shots
        </Typography>
        <Typography level="body-md">
          Explore a text-only template demonstration. Play or scrub the sample and try different output sizes. No media
          is generated, saved or rendered. Upgrade to build, edit and export your own productions.
        </Typography>
        <Stack direction="row" spacing={1} flexWrap="wrap" role="group" aria-label="Sample output size">
          {timeline.outputs.map(candidate => (
            <Button
              key={candidate.id}
              size="sm"
              variant={candidate.id === output.id ? 'solid' : 'outlined'}
              aria-pressed={candidate.id === output.id}
              data-testid={`productions-showcase-output-${candidate.id}`}
              onClick={() => setOutputId(candidate.id)}
            >
              {candidate.aspectRatio}
            </Button>
          ))}
        </Stack>
        <TimelinePreview
          timeline={timeline}
          output={output}
          files={files}
          clock={clock}
          onSourceDuration={ignoreSourceDuration}
        />
        <Stack direction="row" spacing={2} alignItems="center">
          <Button
            size="sm"
            data-testid="productions-showcase-play-btn"
            onClick={clock.isPlaying ? clock.pause : clock.play}
          >
            {clock.isPlaying ? 'Pause' : 'Play sample'}
          </Button>
          <Typography level="body-sm" data-testid="productions-showcase-time">
            {(timeMs / 1000).toFixed(1)}s / {timeline.durationMs / 1000}s
          </Typography>
        </Stack>
        <input
          type="range"
          min={0}
          max={timeline.durationMs}
          step={50}
          value={timeMs}
          aria-label="Scrub sample timeline"
          data-testid="productions-showcase-scrubber"
          onChange={event => clock.seek(Number(event.target.value))}
          style={{ width: '100%', margin: 0 }}
        />
        <Typography level="title-md" component="h3">
          How it is made
        </Typography>
        <Typography level="body-sm">
          Brief: introduce a pocket notebook to people with ideas on the go. End with an invitation to start writing.
          This sample uses one title track; your productions can combine video, voice, music and captions.
        </Typography>
        <Stack component="ol" spacing={1} sx={{ m: 0, pl: 3 }} data-testid="productions-showcase-shots">
          {template.starterShots.map((shot, index) => (
            <li key={shot.title}>
              <Typography level="body-sm">
                <strong>{shot.title}</strong> ({(index * shotDurationMs) / 1000}s -{' '}
                {((index + 1) * shotDurationMs) / 1000}s): {lines[index]}
              </Typography>
            </li>
          ))}
        </Stack>
      </Stack>
    </StudioPanel>
  );
};

export default ProductionsShowcase;
