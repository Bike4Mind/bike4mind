import Box from '@mui/joy/Box';
import Chip from '@mui/joy/Chip';
import IconButton from '@mui/joy/IconButton';
import Typography from '@mui/joy/Typography';
import { keyframes } from '@mui/system';
import { useEffect, useState } from 'react';
import type { MiniTavernApi } from '@shared/ipc';
import { CloseIcon, FollowIcon, PagerIcon } from '../chat/icons';
import { prefersReducedMotion } from '../chat/orchestrator/motion';
import { MiniRoom } from './MiniRoom';
import { MiniStrip } from './MiniStrip';
import { NeedsYouCard } from './NeedsYouCard';
import { useRoomSelection } from './useRoomSelection';
import { miniApi, useWatchSnapshot } from './useWatchSnapshot';

/** Below either of these the window drops the scene for the strip of state dots. */
export const STRIP_MAX_HEIGHT = 140;
export const STRIP_MAX_WIDTH = 300;

const fadeIn = keyframes`from { opacity: 0; } to { opacity: 1; }`;

function useWindowSize() {
  const [size, setSize] = useState(() => ({ width: window.innerWidth, height: window.innerHeight }));
  useEffect(() => {
    const update = () => setSize({ width: window.innerWidth, height: window.innerHeight });
    window.addEventListener('resize', update);
    return () => window.removeEventListener('resize', update);
  }, []);
  return size;
}

const noDrag = { WebkitAppRegion: 'no-drag' } as const;

/** The always-on-top mini Tavern window (main/watch/miniWindow.ts), rendered at #/mini-tavern. */
export function MiniTavern({ api = miniApi() }: { api?: MiniTavernApi }) {
  const snapshot = useWatchSnapshot(api);
  const room = useRoomSelection(snapshot);
  const { width, height } = useWindowSize();
  const strip = height < STRIP_MAX_HEIGHT || width < STRIP_MAX_WIDTH;
  const orchestration = snapshot.orchestrations.find(candidate => candidate.rootId === room.rootId);
  const [oldest, ...behind] = snapshot.pending;

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') api?.close();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [api]);

  const focus = (sessionId: string, rootId: string) => api?.focusAgent(sessionId, rootId);

  return (
    <Box
      data-testid="mini-tavern"
      sx={{
        height: '100vh',
        display: 'flex',
        flexDirection: strip ? 'row' : 'column',
        alignItems: strip ? 'center' : 'stretch',
        bgcolor: 'background.body',
        overflow: 'hidden',
        userSelect: 'none',
      }}
    >
      <Box
        component="header"
        data-testid="mini-tavern-header"
        sx={{
          display: 'flex',
          alignItems: 'center',
          gap: 0.5,
          px: 1,
          py: 0.5,
          minWidth: 0,
          flex: strip ? '0 1 auto' : 'none',
          // In the strip the dots lead and the close button trails.
          order: strip ? 1 : 0,
          WebkitAppRegion: 'drag',
        }}
      >
        {!strip && (
          <>
            <Typography level="title-sm" noWrap sx={{ flex: 1, minWidth: 0 }} data-testid="mini-tavern-title">
              {orchestration?.title ?? 'No orchestrations yet'}
            </Typography>
            {room.otherNeedsYou && (
              <Chip
                size="sm"
                color="warning"
                variant="soft"
                onClick={room.unpin}
                sx={noDrag}
                data-testid="mini-tavern-other-room-pill"
              >
                Another room needs you
              </Chip>
            )}
            {room.count > 1 && (
              <Box sx={{ display: 'flex', alignItems: 'center', ...noDrag }} data-testid="mini-tavern-pager">
                <IconButton
                  size="sm"
                  variant="plain"
                  aria-label="Previous orchestration"
                  onClick={() => room.step(-1)}
                  data-testid="mini-tavern-prev-btn"
                >
                  <PagerIcon direction="previous" />
                </IconButton>
                <Typography level="body-xs" data-testid="mini-tavern-position">
                  {room.position} of {room.count}
                </Typography>
                <IconButton
                  size="sm"
                  variant="plain"
                  aria-label="Next orchestration"
                  onClick={() => room.step(1)}
                  data-testid="mini-tavern-next-btn"
                >
                  <PagerIcon direction="next" />
                </IconButton>
              </Box>
            )}
            {room.pinned && !room.otherNeedsYou && (
              <IconButton
                size="sm"
                variant="plain"
                aria-label="Follow attention"
                title="Follow attention"
                onClick={room.unpin}
                sx={noDrag}
                data-testid="mini-tavern-unpin-btn"
              >
                <FollowIcon />
              </IconButton>
            )}
          </>
        )}
        <IconButton
          size="sm"
          variant="plain"
          aria-label="Close mini Tavern"
          onClick={() => api?.close()}
          sx={noDrag}
          data-testid="mini-tavern-close-btn"
        >
          <CloseIcon />
        </IconButton>
      </Box>

      {strip ? (
        <MiniStrip orchestrations={snapshot.orchestrations} onOpen={rootId => focus(rootId, rootId)} />
      ) : (
        <Box sx={{ position: 'relative', flex: 1, minHeight: 0 }}>
          {orchestration && (
            <Box
              key={orchestration.rootId}
              data-testid="mini-tavern-room"
              sx={{
                position: 'absolute',
                inset: 0,
                // TavernView's frame is a flex: 1 size container.
                display: 'flex',
                flexDirection: 'column',
                animation: prefersReducedMotion() ? 'none' : `${fadeIn} 300ms ease-out`,
              }}
            >
              <MiniRoom
                orchestration={orchestration}
                awake={snapshot.needsYouCount > 0}
                onSelect={sessionId => focus(sessionId, orchestration.rootId)}
              />
            </Box>
          )}
          {oldest && (
            <Box sx={{ position: 'absolute', left: 8, right: 8, bottom: 8 }}>
              <NeedsYouCard
                key={oldest.approvalId}
                pending={oldest}
                more={behind.length}
                onRespond={async (approvalId, decision) => (await api?.respond(approvalId, decision)) ?? false}
                onReview={item => focus(item.sessionId, item.rootId)}
              />
            </Box>
          )}
        </Box>
      )}
    </Box>
  );
}
