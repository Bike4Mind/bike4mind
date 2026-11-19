import React from 'react';
import { Box, Text } from 'ink';
import { planProgress, type PlanItem, type PlanItemStatus } from '@bike4mind/common';
import { useCliStore } from '../store';
import { sanitizeTerminalText } from '../utils/sanitizeTerminalText.js';

const GLYPH: Record<PlanItemStatus, { symbol: string; color?: string }> = {
  completed: { symbol: '\u2714', color: 'green' },
  in_progress: { symbol: '\u25B6', color: 'cyan' },
  pending: { symbol: '\u25CB' },
  cancelled: { symbol: '\u2715', color: 'gray' },
};

function Row({ item, indent }: { item: PlanItem; indent: boolean }) {
  const { symbol, color } = GLYPH[item.status];
  const label = sanitizeTerminalText(item.status === 'in_progress' ? (item.activeForm ?? item.content) : item.content);
  return (
    <Box marginLeft={indent ? 2 : 0}>
      <Text color={color}>{symbol} </Text>
      <Text
        color={item.status === 'in_progress' ? 'cyan' : undefined}
        dimColor={item.status === 'pending' || item.status === 'cancelled'}
        strikethrough={item.status === 'cancelled'}
      >
        {label}
      </Text>
    </Box>
  );
}

/** Plan above the prompt: full list while a turn runs, `n/m - current` once it ends. */
export function PlanBlock() {
  const items = useCliStore(state => state.plan);
  const active = useCliStore(state => state.isThinking || state.turnInFlight);
  if (items.length === 0) return null;

  if (!active) {
    const { done, total, current } = planProgress({ version: 1, source: 'write_todos', items, updatedAt: 0 });
    return (
      <Text dimColor>
        {done}/{total}
        {current ? ` - ${sanitizeTerminalText(current)}` : ''}
      </Text>
    );
  }

  return (
    <Box flexDirection="column">
      {items.map(item => (
        <React.Fragment key={item.id}>
          <Row item={item} indent={false} />
          {item.children?.map(child => (
            <Row key={child.id} item={child} indent />
          ))}
        </React.Fragment>
      ))}
    </Box>
  );
}
