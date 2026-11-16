import Box from '@mui/joy/Box';
import Typography from '@mui/joy/Typography';
import { keyframes } from '@mui/system';
import { AGENT_STATE_LABEL, describeAgentStates } from '@shared/agentState';
import type { ViewAction, ViewSnapshot } from '@shared/viewSnapshot';
import { AQUARIUM_BACKDROP, fishLook, fishSprite } from './aquariumArt';
import { MIDWATER_LANE, lampAction, placeFish, type FishPlacement } from './aquariumScene';

/*
 * Built on the view contract alone, like TileWall: the snapshot in, ViewActions out (snapshotView.tsx
 * hosts it and pauses it while the window is hidden). Slow and low contrast on purpose: it is meant to
 * sit on a second monitor and be glanced at.
 */

const NO_MOTION = '@media (prefers-reduced-motion: reduce)';

/** There and back across the open water (cqw: percent of the tank's width), easing at each end. */
const HALF_LANE_CQW = (MIDWATER_LANE.to - MIDWATER_LANE.from) / 2;
const swimAcross = keyframes`
  0%, 100% { transform: translateX(-${HALF_LANE_CQW}cqw); }
  50% { transform: translateX(${HALF_LANE_CQW}cqw); }
`;
/** Faces the way it swims: right on the way out, left on the way back. */
const faceTheWay = keyframes`
  0%, 49.9% { transform: scaleX(1); }
  50%, 100% { transform: scaleX(-1); }
`;
const bob = keyframes`
  0%, 100% { transform: translateY(0); }
  50% { transform: translateY(-6%); }
`;
const rise = keyframes`
  0% { transform: translateY(0) scale(0.6); opacity: 0; }
  15% { opacity: 0.8; }
  100% { transform: translateY(-160px) scale(1); opacity: 0; }
`;
const glow = keyframes`
  0%, 100% { opacity: 0.75; }
  50% { opacity: 1; }
`;

const FISH_WIDTH = 'clamp(48px, 6.5cqw, 104px)';
/** Nose to the glass is closer to the viewer, so bigger. */
const GLASS_SCALE = 1.5;
const BUBBLE_DELAYS_S = [0, 0.35, 0.8, 1.2];

/** Done: a few bubbles rise once from the fish. Remounted (so replayed) only when it becomes done. */
function Bubbles() {
  return (
    <Box
      aria-hidden
      data-testid="orchestrator-fish-bubbles"
      sx={{ position: 'absolute', left: '55%', bottom: '70%', width: 0, height: 0, [NO_MOTION]: { display: 'none' } }}
    >
      {BUBBLE_DELAYS_S.map((delay, index) => (
        <Box
          key={delay}
          sx={{
            position: 'absolute',
            left: index % 2 === 0 ? -4 : 4,
            width: 6 + (index % 3) * 2,
            height: 6 + (index % 3) * 2,
            borderRadius: '50%',
            border: '1px solid rgba(220, 240, 255, 0.8)',
            bgcolor: 'rgba(220, 240, 255, 0.15)',
            opacity: 0,
            animation: `${rise} 2.6s ease-out ${delay}s 1 both`,
          }}
        />
      ))}
    </Box>
  );
}

function Fish({ placement, onAction }: { placement: FishPlacement; onAction(action: ViewAction): void }) {
  const { agent, pose, zone, swim } = placement;
  const look = fishLook(agent.id);
  const detail = agent.decision?.question ?? agent.now;
  const label = `${agent.title}: ${AGENT_STATE_LABEL[agent.state]}`;
  const atGlass = zone === 'glass';

  // The outer box keeps one element per agent, so a change of state glides it to its new spot (a failed
  // fish sinking to the sand); the button inside it is what swims, so the click target moves with the fish.
  return (
    <Box
      sx={{
        position: 'absolute',
        left: `${placement.x}%`,
        top: `${placement.y}%`,
        width: FISH_WIDTH,
        aspectRatio: '1',
        zIndex: atGlass ? 3 : 1,
        transform: `translate(-50%, -100%) scale(${atGlass ? GLASS_SCALE : 1})`,
        transformOrigin: 'bottom center',
        transition: 'top 2.5s ease-in-out, left 2.5s ease-in-out, transform 1.5s ease-in-out',
        [NO_MOTION]: { transition: 'none' },
      }}
    >
      <Box
        component="button"
        type="button"
        onClick={() => onAction({ kind: 'open-agent', agentId: agent.id })}
        aria-label={label}
        title={detail ? `${label}\n${detail}` : label}
        data-testid={`orchestrator-fish-${agent.id}`}
        data-state={agent.state}
        data-pose={pose}
        data-zone={zone}
        sx={{
          display: 'block',
          width: '100%',
          height: '100%',
          p: 0,
          border: 0,
          bgcolor: 'transparent',
          cursor: 'pointer',
          animation: swim ? `${swimAcross} ${swim.durationS}s ease-in-out ${swim.delayS}s infinite` : undefined,
          '&:focus-visible': { outline: '2px solid', outlineColor: 'focusVisible', borderRadius: 'md' },
          [NO_MOTION]: { animation: 'none' },
        }}
      >
        <Box
          sx={{
            width: '100%',
            height: '100%',
            animation:
              swim || atGlass ? `${bob} ${atGlass ? 2.2 : 3.4}s ease-in-out ${swim?.delayS ?? 0}s infinite` : undefined,
            [NO_MOTION]: { animation: 'none' },
          }}
        >
          <Box
            component="img"
            src={fishSprite(look, pose)}
            alt=""
            draggable={false}
            sx={{
              display: 'block',
              width: '100%',
              height: '100%',
              imageRendering: 'pixelated',
              filter: look.hue ? `hue-rotate(${look.hue}deg)` : undefined,
              animation: swim ? `${faceTheWay} ${swim.durationS}s linear ${swim.delayS}s infinite` : undefined,
              [NO_MOTION]: { animation: 'none' },
            }}
          />
        </Box>
      </Box>
      {agent.state === 'done' && <Bubbles key={`${agent.id}-done`} />}
      {atGlass && (
        <Typography
          level="body-xs"
          noWrap
          sx={{
            position: 'absolute',
            top: '100%',
            left: '50%',
            transform: `translateX(-50%) scale(${1 / GLASS_SCALE})`,
            transformOrigin: 'top center',
            maxWidth: 220,
            px: 0.75,
            borderRadius: 'sm',
            pointerEvents: 'none',
            color: 'rgba(255, 244, 220, 0.95)',
            bgcolor: 'rgba(10, 24, 32, 0.55)',
          }}
        >
          {agent.title}
        </Typography>
      )}
    </Box>
  );
}

/** The lamp on the glass rim: dark until someone waits on the user, then a slow amber glow that opens them. */
function Lamp({ action, onAction }: { action?: ViewAction; onAction(action: ViewAction): void }) {
  const lit = action !== undefined;
  return (
    <Box
      component={lit ? 'button' : 'div'}
      type={lit ? 'button' : undefined}
      onClick={lit ? () => onAction(action) : undefined}
      aria-label={lit ? 'Something needs you' : undefined}
      aria-hidden={lit ? undefined : true}
      data-testid="orchestrator-aquarium-lamp"
      data-lit={lit ? 'on' : 'off'}
      sx={{
        position: 'absolute',
        top: 0,
        right: '8%',
        width: 120,
        height: 140,
        p: 0,
        border: 0,
        bgcolor: 'transparent',
        cursor: lit ? 'pointer' : 'default',
        zIndex: 4,
        '&:focus-visible': { outline: '2px solid', outlineColor: 'focusVisible' },
      }}
    >
      <Box
        sx={{
          position: 'absolute',
          top: 0,
          left: '50%',
          transform: 'translateX(-50%)',
          width: 44,
          height: 12,
          borderRadius: '0 0 8px 8px',
          bgcolor: lit ? '#f2c35b' : '#2c3a40',
          boxShadow: lit ? '0 0 12px 4px rgba(242, 195, 91, 0.6)' : 'none',
          transition: 'background-color 600ms, box-shadow 600ms',
        }}
      />
      {lit && (
        <Box
          aria-hidden
          sx={{
            position: 'absolute',
            inset: 0,
            background: 'radial-gradient(ellipse at 50% 0%, rgba(242, 195, 91, 0.45), transparent 70%)',
            animation: `${glow} 3s ease-in-out infinite`,
            [NO_MOTION]: { animation: 'none' },
          }}
        />
      )}
    </Box>
  );
}

/**
 * Aquarium: one fish per agent in a quiet tank. Working fish swim mid-water; a done one lets out a few
 * bubbles and rests; a failed one sinks pale to the sand; idle and stopped ones sleep on the bottom; one
 * that needs the user swims to the front glass and the lamp on the rim lights. Clicking a fish (or the
 * lamp) opens it in the peek drawer, where answering and approving live.
 */
export function Aquarium({ snapshot, onAction }: { snapshot: ViewSnapshot; onAction(action: ViewAction): void }) {
  const placements = placeFish(snapshot.agents);
  const summary = describeAgentStates(
    snapshot.agents.map(agent => agent.state),
    snapshot.root.state === 'needs-you' ? 1 : 0
  );

  return (
    <Box
      role="group"
      aria-label={`Aquarium: ${summary}`}
      data-testid="orchestrator-aquarium"
      sx={{
        position: 'relative',
        flex: 1,
        minHeight: 320,
        overflow: 'hidden',
        containerType: 'size',
        bgcolor: '#0e2a33',
        backgroundImage: `url(${AQUARIUM_BACKDROP})`,
        backgroundSize: 'cover',
        backgroundPosition: 'center bottom',
        imageRendering: 'pixelated',
        // Low contrast for a second monitor: a soft veil over the art, never over the fish.
        '&::before': {
          content: '""',
          position: 'absolute',
          inset: 0,
          bgcolor: 'rgba(8, 22, 30, 0.28)',
          pointerEvents: 'none',
        },
      }}
    >
      {placements.map(placement => (
        <Fish key={placement.agent.id} placement={placement} onAction={onAction} />
      ))}
      <Lamp action={lampAction(snapshot)} onAction={onAction} />
    </Box>
  );
}
