import Box from '@mui/joy/Box';
import { keyframes } from '@mui/system';
import type { CSSProperties } from 'react';

/**
 * The room's mood: `day` for the light theme, `night` for the dark one, and `last-call` while the
 * chrome has settled out (ambient.ts), when the lamps burn low over an empty-looking room.
 */
export type TavernMood = 'day' | 'night' | 'last-call';

type Light = {
  /** Centre, in percent of the scene box. */
  x: number;
  y: number;
  /** Glow radius, in percent of the scene width. */
  size: number;
  kind: 'fire' | 'candle';
};

// Picked for backdrop.png (1280x720); re-pick with TAVERN_SLOTS whenever the backdrop is regenerated.
export const TAVERN_LIGHTS: readonly Light[] = [
  { x: 92, y: 36, size: 22, kind: 'fire' },
  { x: 11.5, y: 18.5, size: 7, kind: 'candle' },
  { x: 30.6, y: 23.5, size: 6, kind: 'candle' },
  { x: 44, y: 11.5, size: 6, kind: 'candle' },
  { x: 55, y: 9.5, size: 6, kind: 'candle' },
  { x: 69.1, y: 9.5, size: 6, kind: 'candle' },
  { x: 71.7, y: 26, size: 5, kind: 'candle' },
  { x: 85.6, y: 17.2, size: 6, kind: 'candle' },
  { x: 95.3, y: 19.5, size: 6, kind: 'candle' },
  { x: 88.1, y: 45.4, size: 5, kind: 'candle' },
  { x: 24.8, y: 63.5, size: 9, kind: 'candle' },
  { x: 62, y: 69.8, size: 9, kind: 'candle' },
];

const WINDOW = { x: 23.8, y: 7.5 };
const HEARTH = { x: 92, y: 40 };
const EMBERS = 7;
const NO_MOTION = '@media (prefers-reduced-motion: reduce)';
const MOOD_FADE = 'opacity 2.4s ease-in-out';

const flicker = keyframes`
  0%, 100% { opacity: 0.85; transform: translate(-50%, -50%) scale(1); }
  18% { opacity: 1; transform: translate(-50%, -50%) scale(1.04); }
  37% { opacity: 0.72; transform: translate(-50%, -50%) scale(0.97); }
  55% { opacity: 0.95; transform: translate(-50%, -50%) scale(1.02); }
  78% { opacity: 0.8; transform: translate(-50%, -50%) scale(0.99); }
`;

const rise = keyframes`
  0% { opacity: 0; transform: translate(0, 0); }
  12% { opacity: 1; }
  100% { opacity: 0; transform: translate(var(--ember-drift), -14cqh); }
`;

/** How much each layer shows per mood: the room's shade, the lamps' glow and the moonlight at the window. */
const MOOD: Record<TavernMood, { shade: number; vignette: number; glow: number; moon: number }> = {
  day: { shade: 0, vignette: 0.25, glow: 0.45, moon: 0 },
  night: { shade: 0.55, vignette: 0.55, glow: 0.85, moon: 0.7 },
  'last-call': { shade: 1, vignette: 0.9, glow: 1, moon: 1 },
};

// A fixed spread so each lamp keeps its own rhythm without a re-render ever changing it.
const flickerTiming = (index: number) => ({
  duration: `${(2.1 + ((index * 0.73) % 1.6)).toFixed(2)}s`,
  delay: `-${((index * 1.37) % 2).toFixed(2)}s`,
});

const layer = { position: 'absolute', inset: 0, pointerEvents: 'none' } as const;

/**
 * The light over the backdrop, under the sprites: a mood shade with warm pools where the lamps are,
 * flickering glows, and embers off the hearth. Purely decorative; under reduced motion the light holds still.
 */
export function TavernLight({ mood }: { mood: TavernMood }) {
  const level = MOOD[mood];
  return (
    <Box aria-hidden data-testid="orchestrator-tavern-light" data-mood={mood} sx={layer}>
      <Box
        data-light-shade
        sx={{
          ...layer,
          opacity: level.shade,
          transition: MOOD_FADE,
          mixBlendMode: 'multiply',
          // Deep blue dusk with the lamps' pools left warm, so the dim reads as night, not as a grey overlay.
          background: [
            ...TAVERN_LIGHTS.map(
              light =>
                `radial-gradient(circle ${light.size * 1.6}cqw at ${light.x}% ${light.y}%, rgba(255, 214, 160, 1), rgba(255, 214, 160, 0) 70%)`
            ),
            'linear-gradient(rgba(70, 62, 120, 1), rgba(70, 62, 120, 1))',
          ].join(', '),
        }}
      />
      <Box
        data-light-vignette
        sx={{
          ...layer,
          opacity: level.vignette,
          transition: MOOD_FADE,
          background: 'radial-gradient(ellipse 75% 70% at 55% 45%, rgba(8, 4, 2, 0) 55%, rgba(8, 4, 2, 0.85) 100%)',
        }}
      />
      <Box
        data-light-moon
        sx={{
          ...layer,
          opacity: level.moon,
          transition: MOOD_FADE,
          mixBlendMode: 'screen',
          background: `radial-gradient(ellipse 9cqw 10cqh at ${WINDOW.x}% ${WINDOW.y}%, rgba(120, 150, 255, 0.55), rgba(120, 150, 255, 0) 100%)`,
        }}
      />
      <Box sx={{ ...layer, opacity: level.glow, transition: MOOD_FADE, mixBlendMode: 'screen' }}>
        {TAVERN_LIGHTS.map((light, index) => {
          const timing = flickerTiming(index);
          const fire = light.kind === 'fire';
          return (
            <Box
              key={`${light.x}-${light.y}`}
              data-light-glow={light.kind}
              style={{ left: `${light.x}%`, top: `${light.y}%`, width: `${light.size}cqw` }}
              sx={{
                position: 'absolute',
                aspectRatio: '1',
                transform: 'translate(-50%, -50%)',
                borderRadius: '50%',
                background: fire
                  ? 'radial-gradient(closest-side, rgba(255, 150, 60, 0.6), rgba(255, 110, 30, 0.22) 55%, rgba(255, 90, 20, 0) 100%)'
                  : 'radial-gradient(closest-side, rgba(255, 200, 120, 0.55), rgba(255, 170, 80, 0) 100%)',
                animation: `${flicker} ${fire ? '1.3s' : timing.duration} ease-in-out ${timing.delay} infinite`,
                [NO_MOTION]: { animation: 'none' },
              }}
            />
          );
        })}
      </Box>
      <Box sx={{ ...layer, [NO_MOTION]: { display: 'none' } }}>
        {Array.from({ length: EMBERS }, (_, index) => (
          <Box
            key={index}
            data-light-ember
            style={
              {
                left: `${HEARTH.x - 3 + ((index * 1.9) % 6)}%`,
                top: `${HEARTH.y}%`,
                '--ember-drift': `${((index % 3) - 1) * 1.2}cqw`,
                animationDuration: `${(2.4 + ((index * 0.61) % 1.8)).toFixed(2)}s`,
                animationDelay: `-${((index * 0.83) % 3).toFixed(2)}s`,
              } as CSSProperties
            }
            sx={{
              position: 'absolute',
              // A square, not a dot: the backdrop is pixel art.
              width: 'max(2px, 0.25cqw)',
              aspectRatio: '1',
              bgcolor: index % 2 ? '#ffb347' : '#ff7a2a',
              boxShadow: '0 0 4px rgba(255, 140, 40, 0.9)',
              // Duration and delay come per ember from the inline style, which wins over this shorthand.
              animation: `${rise} 3s ease-out infinite`,
            }}
          />
        ))}
      </Box>
    </Box>
  );
}
