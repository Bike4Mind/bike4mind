import Box from '@mui/joy/Box';
import Dropdown from '@mui/joy/Dropdown';
import ListItemDecorator from '@mui/joy/ListItemDecorator';
import Menu from '@mui/joy/Menu';
import MenuButton from '@mui/joy/MenuButton';
import MenuItem from '@mui/joy/MenuItem';
import { useLayoutEffect, useRef } from 'react';
import { AGENT_STATE_LABEL, type AgentState, type AgentView } from '../roster';
import { poseFor, type SlotPoint, type TavernZone } from './scene';
import { characterSprite, type CharacterId } from './tavernArt';

/** The lamp on each nameplate and token: the agent's state at a glance, without the bubble. */
export const STATE_LAMP: Record<AgentState, string> = {
  'needs-you': '#f5c542',
  working: '#ff9d3c',
  done: '#7ed07a',
  failed: '#e5534b',
  stopped: '#a89a88',
  idle: '#a89a88',
};

const ZONE_PLACE: Record<TavernZone, string> = {
  workbench: 'at the workbenches',
  bar: 'at the bar',
  hearth: 'by the hearth',
  benches: 'on the benches',
};

/** Above seated sprites (at most 100), below a lifted one (TavernView's LIFTED_Z). */
const STACK_Z = 101;
/** Tokens drawn on the stack; the count pill covers the rest. */
const STACK_TOKENS = 3;

export type StackedAgent = { agent: AgentView; character: CharacterId; name: string };

/**
 * A full zone's extra agents, stacked in place as small tokens with a count. The whole stack is one
 * button opening a menu of every agent in it (arrow keys move, Enter selects, Escape closes), so no
 * agent is out of reach however crowded the room gets.
 */
export function OverflowStack({
  zone,
  point,
  stacked,
  selectedId,
  onSelect,
}: {
  zone: TavernZone;
  point: SlotPoint;
  stacked: readonly StackedAgent[];
  selectedId: string | null;
  onSelect(id: string): void;
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
        data-testid={`orchestrator-tavern-overflow-${zone}`}
        data-urgent={urgent || undefined}
        aria-label={`${count} more ${ZONE_PLACE[zone]}${needsYou}; list them`}
        variant="plain"
        style={{ left: `${point.x}%`, top: `${point.y}%` }}
        sx={{
          position: 'absolute',
          // Above every seated sprite (zIndex is its y), so a sprite standing nearby never covers it.
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
          {stacked.slice(0, STACK_TOKENS).map(({ agent, character }, index) => (
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
                border: `2px solid ${STATE_LAMP[agent.state]}`,
                boxShadow:
                  agent.id === selectedId
                    ? '0 0 0 2px #f5c542, 0 2px 0 rgba(0, 0, 0, 0.45)'
                    : '0 2px 0 rgba(0, 0, 0, 0.45)',
              }}
            >
              <Box
                component="img"
                src={characterSprite(character, poseFor(agent.state))}
                alt=""
                draggable={false}
                sx={{
                  // The head and shoulders: the art's feet sit at the bottom of a square canvas.
                  position: 'absolute',
                  left: '-40%',
                  top: '-8%',
                  width: '180%',
                  height: '180%',
                  imageRendering: 'pixelated',
                }}
              />
            </Box>
          ))}
        </Box>
        <Box
          component="span"
          data-testid={`orchestrator-tavern-overflow-${zone}-count`}
          sx={{
            px: '0.5em',
            borderRadius: '999px',
            bgcolor: urgent ? '#f5c542' : 'rgba(20, 12, 6, 0.85)',
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
        data-testid={`orchestrator-tavern-overflow-${zone}-list`}
        sx={{ maxHeight: 280, overflowY: 'auto', minWidth: 200, zIndex: 'var(--joy-zIndex-popup)' }}
      >
        {stacked.map(({ agent, name }) => (
          <MenuItem
            key={agent.id}
            data-testid={`orchestrator-tavern-overflow-item-${agent.id}`}
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
                  bgcolor: STATE_LAMP[agent.state],
                  boxShadow: `0 0 4px ${STATE_LAMP[agent.state]}`,
                }}
              />
            </ListItemDecorator>
            <Box sx={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 260 }}>{name}</Box>
          </MenuItem>
        ))}
      </Menu>
    </Dropdown>
  );
}
