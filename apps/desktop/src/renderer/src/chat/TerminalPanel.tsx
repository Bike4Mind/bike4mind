import { lazy, Suspense, useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react';
import Box from '@mui/joy/Box';
import Button from '@mui/joy/Button';
import IconButton from '@mui/joy/IconButton';
import Stack from '@mui/joy/Stack';
import Typography from '@mui/joy/Typography';
import { MAX_TERMINALS_PER_SESSION, type TerminalInfo } from '@shared/terminal';
import { DisclosureIcon, ReloadIcon } from './icons';
import { SCROLL_GUTTER_VAR } from './layout';
import { ResizeHandle } from './ResizeHandle';
import { TabStrip } from './TabStrip';
import {
  clampTerminalPanelHeight,
  readTerminalPanelHeight,
  TERMINAL_PANEL_HEIGHT,
  TERMINAL_PANEL_MIN_HEIGHT,
  terminalPanelMaxHeight,
  writeTerminalPanelHeight,
} from './terminalPanelState';
import { useTerminals } from './useTerminals';

const TerminalView = lazy(() => import('./TerminalView'));

function exitLine(exit: NonNullable<TerminalInfo['exit']>): string {
  return exit.signal ? `The shell was ended by signal ${exit.signal}.` : `The shell exited with code ${exit.code}.`;
}

/**
 * The user's terminals for one conversation, docked under it.
 *
 * Inside the conversation column, under the composer, rather than a column of its own: it
 * takes height, not width, so the browser pane beside it keeps its size and both can be open
 * at once. Everything here is drawn in the React tree, so it is never one of the body-level
 * layers that make the browser page stand down (see agentBrowser.ts).
 *
 * Mount it per conversation (keyed). Opening it on a conversation with no terminal starts one;
 * closing the last tab hides it.
 */
export function TerminalPanel({
  sessionId,
  column,
  focusRequest,
  onHide,
  onOpenLink,
}: {
  sessionId: string;
  /** The conversation column it shares height with; the drag's maximum is measured from it. */
  column: RefObject<HTMLElement | null>;
  /** Bumped to move the keyboard into the terminal, as opening the panel from its toggle does. */
  focusRequest: number;
  onHide: () => void;
  onOpenLink: (url: string) => void;
}) {
  const { terminals, loaded, error, create, restart, close } = useTerminals(sessionId, true);
  const [selected, setSelected] = useState<string | null>(null);
  const [localFocus, setLocalFocus] = useState(0);
  const [preferred, setPreferred] = useState(readTerminalPanelHeight);
  const [dragHeight, setDragHeight] = useState<number | null>(null);
  const [dragging, setDragging] = useState(false);
  const [limit, setLimit] = useState(Number.POSITIVE_INFINITY);
  const height = clampTerminalPanelHeight(dragHeight ?? preferred, limit);
  const started = useRef(false);

  const active = terminals.find(entry => entry.id === selected) ?? terminals.at(-1) ?? null;

  const newTerminal = useCallback(async () => {
    const created = await create();
    if (!created) return;
    setSelected(created.id);
    setLocalFocus(current => current + 1);
  }, [create]);

  useEffect(() => {
    if (!loaded || started.current) return;
    started.current = true;
    if (terminals.length === 0) void newTerminal();
  }, [loaded, terminals.length, newTerminal]);

  useLayoutEffect(() => {
    const measure = () => {
      const total = column.current?.getBoundingClientRect().height;
      setLimit(total ? terminalPanelMaxHeight(total) : Number.POSITIVE_INFINITY);
    };
    measure();
    const resizes = new ResizeObserver(measure);
    if (column.current) resizes.observe(column.current);
    return () => resizes.disconnect();
  }, [column]);

  const closeTab = (terminalId: string) => {
    if (terminals.length === 1 && terminals[0].id === terminalId) onHide();
    void close(terminalId);
  };

  const restartTab = (terminalId: string) => {
    void restart(terminalId).then(() => setLocalFocus(current => current + 1));
  };

  const clamp = useCallback((next: number) => clampTerminalPanelHeight(next, limit), [limit]);
  const onCommit = useCallback((next: number) => {
    setDragHeight(null);
    setPreferred(next);
    writeTerminalPanelHeight(next);
  }, []);

  return (
    <Box
      style={{ height }}
      sx={{
        position: 'relative',
        flexShrink: 0,
        display: 'flex',
        flexDirection: 'column',
        minHeight: 0,
        borderTop: '1px solid',
        borderColor: 'divider',
        bgcolor: 'background.level1',
        // Out over the gutter the column reserves for the thread's scrollbar, to the pane edge.
        marginRight: `calc(-1 * var(${SCROLL_GUTTER_VAR}, 0px))`,
      }}
      data-testid="terminal-panel"
    >
      <ResizeHandle
        edge="top"
        label="Resize terminal"
        testId="terminal-resize-handle"
        width={height}
        min={Math.min(TERMINAL_PANEL_MIN_HEIGHT, limit)}
        max={limit}
        defaultWidth={TERMINAL_PANEL_HEIGHT}
        clamp={clamp}
        dragging={dragging}
        onWidth={setDragHeight}
        onCommit={onCommit}
        onDraggingChange={setDragging}
        sx={{ top: -3 }}
      />
      <TabStrip
        tabs={terminals.map((entry, index) => ({
          id: entry.id,
          label: index === 0 ? entry.title : `${entry.title} ${index + 1}`,
          title: entry.exit ? `${entry.cwd}\n${exitLine(entry.exit)}` : entry.cwd,
          ended: !!entry.exit,
        }))}
        activeId={active?.id ?? null}
        ariaLabel="Terminal tabs"
        testIdPrefix="terminal"
        newDisabledTitle={
          terminals.length >= MAX_TERMINALS_PER_SESSION ? `At most ${MAX_TERMINALS_PER_SESSION} terminals` : undefined
        }
        onSelect={id => {
          setSelected(id);
          setLocalFocus(current => current + 1);
        }}
        onClose={closeTab}
        onNew={() => void newTerminal()}
        trailing={
          <>
            <IconButton
              size="sm"
              variant="plain"
              color="neutral"
              aria-label="Restart the terminal"
              title="Restart the terminal"
              disabled={!active}
              onClick={() => active && restartTab(active.id)}
              data-testid="terminal-panel-restart-btn"
              sx={{ '--IconButton-size': '26px', minWidth: 26, minHeight: 26 }}
            >
              <ReloadIcon />
            </IconButton>
            <IconButton
              size="sm"
              variant="plain"
              color="neutral"
              aria-label="Hide the terminal"
              title="Hide the terminal (Ctrl+`)"
              onClick={onHide}
              data-testid="terminal-panel-hide-btn"
              sx={{ '--IconButton-size': '26px', minWidth: 26, minHeight: 26 }}
            >
              <DisclosureIcon open={false} />
            </IconButton>
          </>
        }
      />
      <Box
        sx={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0, bgcolor: 'background.surface' }}
        data-testid="terminal-panel-body"
      >
        {/* The exit bar is BELOW the screen rather than over it, so the screen refits around it
            and the shell's last lines - usually why it exited - stay readable. */}
        <Box sx={{ position: 'relative', flex: 1, minHeight: 0 }}>
          {active ? (
            <Suspense fallback={null}>
              <TerminalView
                key={`${active.id}:${active.generation}`}
                terminalId={active.id}
                focusKey={focusRequest + localFocus}
                onOpenLink={onOpenLink}
              />
            </Suspense>
          ) : (
            <Stack spacing={1} alignItems="center" justifyContent="center" sx={{ height: '100%', px: 3 }}>
              <Typography
                level="body-sm"
                textColor={error ? 'danger.plainColor' : 'text.tertiary'}
                data-testid="terminal-panel-status"
              >
                {error ?? 'Starting a shell...'}
              </Typography>
              {error && (
                <Button
                  size="sm"
                  variant="soft"
                  onClick={() => void newTerminal()}
                  data-testid="terminal-panel-retry-btn"
                >
                  Try again
                </Button>
              )}
            </Stack>
          )}
        </Box>
        {active?.exit && (
          <Stack
            direction="row"
            spacing={1}
            alignItems="center"
            sx={{
              flexShrink: 0,
              px: 1.5,
              py: 0.75,
              borderTop: '1px solid',
              borderColor: 'divider',
              bgcolor: 'background.level1',
            }}
            data-testid="terminal-exit-banner"
          >
            <Typography level="body-xs" textColor="text.secondary" sx={{ flex: 1, minWidth: 0 }} noWrap>
              {exitLine(active.exit)}
            </Typography>
            <Button
              size="sm"
              variant="soft"
              onClick={() => restartTab(active.id)}
              data-testid="terminal-exit-restart-btn"
            >
              Restart
            </Button>
            <Button
              size="sm"
              variant="plain"
              color="neutral"
              onClick={() => closeTab(active.id)}
              data-testid="terminal-exit-close-btn"
            >
              Close
            </Button>
          </Stack>
        )}
      </Box>
    </Box>
  );
}
