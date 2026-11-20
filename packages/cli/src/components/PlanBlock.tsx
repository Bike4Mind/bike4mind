import React from 'react';
import { Box, Text } from 'ink';
import { planLeaves, planProgress, type PlanItem, type PlanItemStatus } from '@bike4mind/common';
import { useCliStore } from '../store';
import { sanitizeTerminalText } from '../utils/sanitizeTerminalText.js';

/** Expanded plan never takes more rows than this, however long the list. */
export const MAX_PLAN_ROWS = 8;

// Glyphs match Desktop's TodoPanel; cancelled is CLI-only (Desktop has no such status).
const GLYPH: Record<PlanItemStatus, { symbol: string; color?: string }> = {
  completed: { symbol: '\u2713' },
  in_progress: { symbol: '\u25CF', color: 'cyan' },
  pending: { symbol: '\u25CB' },
  cancelled: { symbol: '\u2715', color: 'gray' },
};

interface FlatRow {
  item: PlanItem;
  indent: boolean;
}

const flatten = (items: PlanItem[]): FlatRow[] =>
  items.flatMap(item => [
    { item, indent: false },
    ...(item.children ?? []).map(child => ({ item: child, indent: true })),
  ]);

/** Rows the expanded block occupies for a given cap, so App can take them off the live budget. */
export function expandedPlanRows(items: PlanItem[], maxRows: number): number {
  return Math.min(flatten(items).length, Math.max(0, maxRows));
}

const oneLine = (text: string) => sanitizeTerminalText(text).replace(/\s+/g, ' ');

function Row({ item, indent }: FlatRow) {
  const { symbol, color } = GLYPH[item.status];
  const label = oneLine(item.status === 'in_progress' ? (item.activeForm ?? item.content) : item.content);
  return (
    <Box marginLeft={indent ? 2 : 0}>
      <Text wrap="truncate-end">
        <Text color={color} dimColor={item.status === 'completed'}>
          {symbol}{' '}
        </Text>
        <Text
          color={item.status === 'in_progress' ? 'cyan' : undefined}
          dimColor={item.status !== 'in_progress'}
          strikethrough={item.status === 'completed' || item.status === 'cancelled'}
        >
          {label}
        </Text>
      </Text>
    </Box>
  );
}

/** Leaf the summary and the expanded window both centre on: first in progress, else first pending. */
const currentLeaf = (items: PlanItem[]): PlanItem | undefined => {
  const live = planLeaves(items);
  return live.find(item => item.status === 'in_progress') ?? live.find(item => item.status === 'pending');
};

/** Plan above the prompt: list while a turn runs (capped to `maxRows`), `n/m - current` once it ends. */
export function PlanBlock({ maxRows = MAX_PLAN_ROWS }: { maxRows?: number }) {
  const items = useCliStore(state => state.plan);
  const active = useCliStore(state => state.isThinking || state.turnInFlight);
  if (items.length === 0) return null;

  if (!active) {
    if (planLeaves(items).every(item => item.status === 'completed')) return null;
    const { done, total } = planProgress({ version: 1, source: 'write_todos', items, updatedAt: 0 });
    const current = currentLeaf(items);
    return (
      <Text dimColor wrap="truncate-end">
        {done}/{total}
        {current ? ` - ${oneLine(current.content)}` : ''}
      </Text>
    );
  }

  const rows = flatten(items);
  const budget = Math.max(0, maxRows);
  if (budget === 0) return null;
  let shown = rows;
  let hidden = 0;
  if (rows.length > budget) {
    const target = currentLeaf(items);
    const anchor = Math.max(
      0,
      rows.findIndex(row => row.item === target)
    );
    if (budget === 1) {
      // No room for "+N more": the current row alone keeps the height at 1.
      shown = [rows[anchor]];
    } else {
      const visible = budget - 1;
      // One row of context above the current item, unless that would hide the item itself.
      const start = Math.min(Math.max(0, anchor - (visible > 1 ? 1 : 0)), rows.length - visible);
      shown = rows.slice(start, start + visible);
      hidden = rows.length - visible;
    }
  }

  return (
    <Box flexDirection="column">
      {shown.map(row => (
        <Row key={row.item.id} {...row} />
      ))}
      {hidden > 0 && <Text dimColor>+{hidden} more</Text>}
    </Box>
  );
}
