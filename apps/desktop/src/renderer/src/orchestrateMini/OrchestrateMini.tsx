import Box from '@mui/joy/Box';
import Chip from '@mui/joy/Chip';
import IconButton from '@mui/joy/IconButton';
import List from '@mui/joy/List';
import ListItem from '@mui/joy/ListItem';
import ListItemButton from '@mui/joy/ListItemButton';
import Typography from '@mui/joy/Typography';
import { useEffect, useMemo, useState } from 'react';
import { AGENT_STATE_LABEL, type AgentState } from '@shared/agentState';
import type { OrchestrateMiniApi } from '@shared/ipc';
import { looksLikeNeedsYou } from '@shared/needsYouColor';
import type { OrchestrateMiniSkin } from '@shared/orchestrateMini';
import type { ViewSnapshot } from '@shared/viewSnapshot';
import { CloseIcon } from '../chat/icons';
import { useApplySkin } from '../chat/orchestrator/skins';
import {
  DEFAULT_SKIN_THEME,
  SKIN_CARD_VARIABLE,
  SKIN_STAGE_VARIABLE,
  stateLampColor,
  type SkinTheme,
} from '../chat/orchestrator/statePalette';
import { orchestrateMiniApi, useOrchestrateMiniPayload } from './useOrchestrateMiniPayload';

const noDrag = { WebkitAppRegion: 'no-drag' } as const;

/** One line of the list: the root's own wait, or an agent. */
interface MiniRow {
  id: string;
  title: string;
  state: AgentState;
  /** A worker's question, or the root's approval: clicking raises the app on it. */
  waiting: boolean;
}

/** The root first when it waits on you, then the agents in the snapshot's most-urgent-first order. */
export function miniRows(snapshot: ViewSnapshot): MiniRow[] {
  const rootRow: MiniRow[] =
    snapshot.root.state === 'needs-you'
      ? [{ id: snapshot.root.id, title: 'The orchestrator', state: 'needs-you', waiting: true }]
      : [];
  return [
    ...rootRow,
    ...snapshot.agents.map(agent => ({
      id: agent.id,
      title: agent.title,
      state: agent.state,
      waiting: agent.state === 'needs-you',
    })),
  ];
}

/**
 * The payload's skin as a theme for useApplySkin. The stage already dropped needs-you lookalikes; this
 * drops them again because the window trusts nothing it was sent beyond the schema.
 */
function toSkinTheme(skin: OrchestrateMiniSkin | undefined): SkinTheme {
  if (!skin || skin.id === null) return DEFAULT_SKIN_THEME;
  const keep = <T extends Record<string, string | undefined>>(colors: T): Partial<T> =>
    Object.fromEntries(
      Object.entries(colors).filter(([, color]) => color !== undefined && !looksLikeNeedsYou(color))
    ) as Partial<T>;
  return {
    id: skin.id,
    states: keep(skin.states),
    surfaces: keep(skin.surfaces),
    ...(skin.fontFamily ? { fontFamily: skin.fontFamily } : {}),
    scenes: {},
    sounds: {},
  };
}

function StateDot({ state }: { state: AgentState }) {
  return (
    <Box aria-hidden sx={{ width: 8, height: 8, borderRadius: '50%', flexShrink: 0, bgcolor: stateLampColor(state) }} />
  );
}

function RowContent({ row }: { row: MiniRow }) {
  return (
    <>
      <StateDot state={row.state} />
      <Typography level="body-sm" noWrap sx={{ flex: 1, minWidth: 0 }} title={row.title}>
        {row.title}
      </Typography>
      <Typography level="body-xs" textColor="text.tertiary" noWrap sx={{ flexShrink: 0 }}>
        {AGENT_STATE_LABEL[row.state]}
      </Typography>
    </>
  );
}

/**
 * The always-on-top Orchestrate mini window (main/orchestrateMini), rendered at #/orchestrate-mini: the
 * needs-you count and the stage's agents with their states. A needs-you row raises the app on that
 * decision; nothing here answers or approves.
 */
export function OrchestrateMini({ api: injected }: { api?: OrchestrateMiniApi }) {
  const [api] = useState(() => injected ?? orchestrateMiniApi());
  const payload = useOrchestrateMiniPayload(api);
  const skinKey = JSON.stringify(payload?.skin ?? null);
  const theme = useMemo(() => toSkinTheme(payload?.skin), [skinKey]);
  useApplySkin(theme);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') void api?.close();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [api]);

  const rows = payload ? miniRows(payload.snapshot) : [];
  const needsYou = rows.filter(row => row.waiting).length;

  return (
    <Box
      data-testid="orchestrate-mini"
      data-skin={theme.id ?? 'default'}
      sx={{
        height: '100vh',
        display: 'flex',
        flexDirection: 'column',
        bgcolor: `var(${SKIN_STAGE_VARIABLE}, var(--joy-palette-background-body))`,
        overflow: 'hidden',
        userSelect: 'none',
        ...(theme.fontFamily
          ? { '--joy-fontFamily-body': theme.fontFamily, '--joy-fontFamily-display': theme.fontFamily }
          : {}),
      }}
    >
      <Box
        component="header"
        sx={{ display: 'flex', alignItems: 'center', gap: 1, px: 1.25, py: 0.75, WebkitAppRegion: 'drag' }}
      >
        <Typography
          level="title-lg"
          data-testid="orchestrate-mini-needs-you-count"
          data-count={needsYou}
          sx={{ color: needsYou > 0 ? stateLampColor('needs-you') : 'text.tertiary', fontWeight: 'lg' }}
        >
          {needsYou}
        </Typography>
        <Typography level="body-sm" textColor={needsYou > 0 ? 'text.primary' : 'text.tertiary'} noWrap>
          {needsYou === 1 ? 'needs you' : 'need you'}
        </Typography>
        <Box sx={{ flex: 1 }} />
        {payload?.presenting && (
          <Chip
            size="sm"
            color="primary"
            variant="solid"
            data-testid="orchestrate-mini-presenting"
            title="Presenter mode: titles are hidden"
          >
            Presenting
          </Chip>
        )}
        <IconButton
          size="sm"
          variant="plain"
          color="neutral"
          aria-label="Close the mini window"
          data-testid="orchestrate-mini-close"
          onClick={() => void api?.close()}
          sx={noDrag}
        >
          <CloseIcon />
        </IconButton>
      </Box>
      {payload ? (
        <List
          size="sm"
          data-testid="orchestrate-mini-list"
          sx={{ flex: 1, overflowY: 'auto', px: 0.5, pb: 0.5, ...noDrag }}
        >
          {rows.map(row => (
            <ListItem key={row.id} data-testid="orchestrate-mini-row" data-state={row.state} data-agent-id={row.id}>
              {row.waiting ? (
                <ListItemButton
                  data-testid="orchestrate-mini-open"
                  title="Show this decision in Bike4Mind"
                  onClick={() => void api?.focus(row.id)}
                  sx={{ gap: 1, borderRadius: 'sm', bgcolor: `var(${SKIN_CARD_VARIABLE}, transparent)` }}
                >
                  <RowContent row={row} />
                </ListItemButton>
              ) : (
                <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, px: 1.5, py: 0.5, flex: 1, minWidth: 0 }}>
                  <RowContent row={row} />
                </Box>
              )}
            </ListItem>
          ))}
        </List>
      ) : (
        <Typography
          level="body-sm"
          textColor="text.tertiary"
          data-testid="orchestrate-mini-empty"
          sx={{ px: 1.5, py: 1 }}
        >
          No orchestration on stage. Open one in Bike4Mind to follow it here.
        </Typography>
      )}
    </Box>
  );
}
