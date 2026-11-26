import Box from '@mui/joy/Box';
import Dropdown from '@mui/joy/Dropdown';
import ListItemDecorator from '@mui/joy/ListItemDecorator';
import Menu from '@mui/joy/Menu';
import MenuButton from '@mui/joy/MenuButton';
import MenuItem from '@mui/joy/MenuItem';
import { useLayoutEffect, useRef } from 'react';
import { AGENT_STATE_LABEL, type AgentView } from '../roster';
import { AgentPrIndicator } from '../AgentPrIndicator';
import { stateLampColor } from '../statePalette';
import { hueFilter, type SceneArt } from './cast';
import type { ScenePoint } from './sceneDefinition';

/** Above seated sprites (at most 100), below a lifted one (SceneStage's LIFTED_Z). */
const STACK_Z = 101;
/** Tokens drawn on the stack; the count pill covers the rest. */
const STACK_TOKENS = 3;

const TOKEN_ZOOM = 1.8;

/** `sprite` is the agent's art in its current pose, cropped to head and shoulders on the token. */
export type StackedAgent = { agent: AgentView; sprite: SceneArt; name: string };

/**
 * A full zone's extra agents, stacked in place as small tokens with a count. The whole stack is one
 * button opening a menu of every agent in it (arrow keys move, Enter selects, Escape closes), so no
 * agent is out of reach however crowded the room gets.
 */
export function OverflowStack({
  testId,
  zone,
  place,
  point,
  stacked,
  selectedId,
  onSelect,
  onOpenPr,
  faceY,
}: {
  /** Prefixes the test ids: `<testId>-overflow-<zone>`, its `-count` and `-list`. */
  testId: string;
  zone: string;
  /** Completes "3 more ...", e.g. "at the bar". */
  place: string;
  point: ScenePoint;
  stacked: readonly StackedAgent[];
  selectedId: string | null;
  onSelect(id: string): void;
  onOpenPr?(id: string): void;
  /** The cast's `faceY`; without one the token shows the head and shoulders of a standing figure. */
  faceY?: number;
}) {
  const needing = stacked.filter(({ agent }) => agent.state === 'needs-you').length;
  const urgent = needing > 0;
  const holdsSelection = stacked.some(({ agent }) => agent.id === selectedId);
  const count = stacked.length;
  const needsYou = urgent ? `, ${needing} ${needing === 1 ? 'needs' : 'need'} you` : '';
  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  // The stack goes once its last agent takes a seat, open menu and all; keep focus in the scene, not on body.
  useLayoutEffect(
    () => () => {
      const focused = document.activeElement;
      const scene = buttonRef.current?.parentElement;
      if (!focused || !scene) return;
      if (buttonRef.current?.contains(focused) || menuRef.current?.contains(focused)) scene.focus();
    },
    []
  );
  return (
    <Dropdown>
      <MenuButton
        ref={buttonRef}
        data-testid={`${testId}-overflow-${zone}`}
        data-agent-avatar={holdsSelection ? selectedId : undefined}
        data-urgent={urgent || undefined}
        aria-label={`${count} more ${place}${needsYou}; list them`}
        variant="plain"
        style={{ left: `${point.x}%`, top: `${point.y}%` }}
        sx={{
          position: 'absolute',
          zIndex: STACK_Z,
          transform: 'translate(-50%, -100%)',
          display: 'flex',
          alignItems: 'flex-end',
          gap: '0.2cqh',
          minHeight: 0,
          p: 0,
          border: 0,
          bgcolor: 'transparent',
          '&:hover, &:active, &[aria-expanded="true"]': { bgcolor: 'transparent' },
          cursor: 'pointer',
          '&:focus-visible': { outline: '2px solid #f5c542', outlineOffset: 2, borderRadius: '6px' },
        }}
      >
        <Box sx={{ display: 'flex', alignItems: 'flex-end' }}>
          {stacked.slice(0, STACK_TOKENS).map(({ agent, sprite }, index) => (
            <Box
              key={agent.id}
              component="span"
              aria-hidden
              data-overflow-token={agent.id}
              data-state={agent.state}
              sx={{
                position: 'relative',
                width: '7cqh',
                height: '7cqh',
                ml: index === 0 ? 0 : '-2.8cqh',
                zIndex: STACK_TOKENS - index,
                borderRadius: '50%',
                overflow: 'hidden',
                bgcolor: '#2a1d10',
                border: `2px solid ${stateLampColor(agent.state)}`,
                boxShadow:
                  agent.id === selectedId
                    ? '0 0 0 2px #f5c542, 0 2px 0 rgba(0, 0, 0, 0.45)'
                    : '0 2px 0 rgba(0, 0, 0, 0.45)',
              }}
            >
              <Box
                component="img"
                src={sprite.src}
                alt=""
                draggable={false}
                sx={{
                  filter: hueFilter(sprite),
                  // The head and shoulders: the art's feet sit at the bottom of a square canvas.
                  position: 'absolute',
                  left: '-40%',
                  top: faceY === undefined ? '-8%' : `${50 - faceY * TOKEN_ZOOM}%`,
                  width: `${TOKEN_ZOOM * 100}%`,
                  height: `${TOKEN_ZOOM * 100}%`,
                  imageRendering: 'pixelated',
                }}
              />
            </Box>
          ))}
        </Box>
        <Box
          component="span"
          data-testid={`${testId}-overflow-${zone}-count`}
          sx={{
            px: '0.5em',
            borderRadius: '999px',
            bgcolor: urgent ? stateLampColor('needs-you') : 'rgba(20, 12, 6, 0.85)',
            color: urgent ? '#2a1d10' : '#fbe9c8',
            outline: holdsSelection ? '2px solid #f5c542' : 'none',
            fontWeight: 700,
            fontSize: 'clamp(10px, 2.2cqh, 14px)',
            lineHeight: 1.5,
            whiteSpace: 'nowrap',
          }}
        >
          {`${urgent ? '!' : ''}+${count}`}
        </Box>
      </MenuButton>
      <Menu
        ref={menuRef}
        size="sm"
        placement="bottom"
        data-testid={`${testId}-overflow-${zone}-list`}
        sx={{ maxHeight: 280, overflowY: 'auto', minWidth: 200, zIndex: 'var(--joy-zIndex-popup)' }}
      >
        {stacked.map(({ agent, name }) => (
          <MenuItem
            key={agent.id}
            data-testid={`${testId}-overflow-item-${agent.id}`}
            selected={agent.id === selectedId}
            onClick={() => onSelect(agent.id)}
            aria-label={`${name}: ${AGENT_STATE_LABEL[agent.state]}`}
          >
            <ListItemDecorator>
              <Box
                aria-hidden
                sx={{
                  width: 8,
                  height: 8,
                  bgcolor: stateLampColor(agent.state),
                  boxShadow: `0 0 4px ${stateLampColor(agent.state)}`,
                }}
              />
            </ListItemDecorator>
            <Box sx={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 260 }}>{name}</Box>
            <AgentPrIndicator agentId={agent.id} pr={agent.pr} onOpen={() => onOpenPr?.(agent.id)} compact />
          </MenuItem>
        ))}
      </Menu>
    </Dropdown>
  );
}
