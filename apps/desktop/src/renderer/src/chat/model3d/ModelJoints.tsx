import Button from '@mui/joy/Button';
import Slider from '@mui/joy/Slider';
import Stack from '@mui/joy/Stack';
import Typography from '@mui/joy/Typography';
import { useEffect, useRef, useState } from 'react';
import type { ModelJoint } from '@shared/model3d';

/** One open-and-close swing, in ms: as long as the GLB's clip takes each way, twice. */
const SWING_MS = 2000;

/** Each joint's angle `phase` of the way through a swing: eased out along its range and back. */
export function swingAngles(joints: ModelJoint[], phase: number): Record<string, number> {
  const open = 0.5 - 0.5 * Math.cos(2 * Math.PI * phase);
  return Object.fromEntries(joints.map(({ name, range: [from, to] }) => [name, from + (to - from) * open]));
}

type Props = {
  joints: ModelJoint[];
  angles: Record<string, number>;
  onChange(angles: Record<string, number>): void;
};

/** Sliders that pose the viewer's joints, and a play button that swings them all open and shut. */
export function ModelJoints({ joints, angles, onChange }: Props) {
  const [playing, setPlaying] = useState(false);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  useEffect(() => {
    if (!playing) return;
    const started = performance.now();
    let frame = requestAnimationFrame(function step(now) {
      onChangeRef.current(swingAngles(joints, ((now - started) % SWING_MS) / SWING_MS));
      frame = requestAnimationFrame(step);
    });
    return () => cancelAnimationFrame(frame);
  }, [playing, joints]);

  return (
    <Stack spacing={0.5} sx={{ px: 1.5, pt: 1 }} data-testid="model-pane-joints">
      <Stack direction="row" alignItems="center" justifyContent="space-between">
        <Typography level="body-xs" fontWeight="lg">
          Joints
        </Typography>
        <Button
          size="sm"
          variant={playing ? 'soft' : 'plain'}
          color="neutral"
          onClick={() => setPlaying(value => !value)}
          data-testid="model-pane-joints-play-btn"
        >
          {playing ? 'Stop' : 'Play'}
        </Button>
      </Stack>
      {joints.map(({ name, range: [from, to] }) => {
        const angle = angles[name] ?? 0;
        return (
          <Stack key={name} direction="row" alignItems="center" spacing={1.25}>
            <Typography level="body-xs" noWrap sx={{ width: 96, flexShrink: 0 }} title={name}>
              {name}
            </Typography>
            <Slider
              size="sm"
              min={Math.min(from, to)}
              max={Math.max(from, to)}
              step={1}
              value={angle}
              onChange={(_event, value) => {
                if (typeof value !== 'number') return;
                setPlaying(false);
                onChange({ ...angles, [name]: value });
              }}
              slotProps={{ input: { 'aria-label': `${name} angle` } }}
              data-testid={`model-pane-joint-${name}`}
            />
            <Typography level="body-xs" sx={{ width: 44, flexShrink: 0, textAlign: 'right' }}>
              {Math.round(angle)}&deg;
            </Typography>
          </Stack>
        );
      })}
    </Stack>
  );
}
