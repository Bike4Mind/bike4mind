import Alert from '@mui/joy/Alert';
import Box from '@mui/joy/Box';
import Button from '@mui/joy/Button';
import CircularProgress from '@mui/joy/CircularProgress';
import IconButton from '@mui/joy/IconButton';
import Option from '@mui/joy/Option';
import Select from '@mui/joy/Select';
import Stack from '@mui/joy/Stack';
import Typography from '@mui/joy/Typography';
import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import type { SimulatorPaneInput, SimulatorViewDevice, SimulatorViewState } from '@shared/simulator';
import { CloseIcon } from './icons';
import { SWIPE_THRESHOLD_PX, toDevicePoints } from './simulatorGeometry';

export const SIMULATOR_PANE_WIDTH = 360;
/** Typed characters are batched for this long, so a word goes over as one `type` rather than one per key. */
const TYPE_FLUSH_MS = 150;

function errorText(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  // Electron prefixes a rejected invoke with where it came from; the user needs the reason only.
  return message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
}

/**
 * The live iOS Simulator beside the chat: the screen streamed as JPEG frames into an <img>
 * (not a native view, so nothing here has the browser pane's occlusion problems), with the
 * user's own taps, drags and typing sent back to the device. The agent opens it with
 * simulator_view; the user can open it from the toolbar and pick a device.
 */
export function SimulatorPane({ state, onClose }: { state: SimulatorViewState; onClose: () => void }) {
  const image = useRef<HTMLImageElement | null>(null);
  const frameUrl = useRef<string | null>(null);
  const [hasFrame, setHasFrame] = useState(false);
  const [devices, setDevices] = useState<SimulatorViewDevice[]>([]);
  const [problem, setProblem] = useState('');
  const [busy, setBusy] = useState(false);
  const press = useRef<{ x: number; y: number; at: number } | null>(null);
  const typed = useRef('');
  const typeTimer = useRef<number | null>(null);
  const udid = state.device?.udid ?? null;

  const refreshDevices = useCallback(() => {
    window.b4m.simulator
      .listDevices()
      .then(list => setDevices([...list].sort((a, b) => Number(b.state === 'Booted') - Number(a.state === 'Booted'))))
      .catch(error => setProblem(errorText(error)));
  }, []);

  useEffect(refreshDevices, [refreshDevices]);

  // Frames bypass React state: at ten a second a re-render each would be wasted work.
  useEffect(() => {
    setHasFrame(false);
    const unsubscribe = window.b4m.simulator.onFrame(frame => {
      if (frame.udid !== udid || !image.current) return;
      const next = URL.createObjectURL(new Blob([frame.bytes], { type: 'image/jpeg' }));
      image.current.src = next;
      if (frameUrl.current) URL.revokeObjectURL(frameUrl.current);
      frameUrl.current = next;
      setHasFrame(true);
    });
    return () => {
      unsubscribe();
      if (frameUrl.current) URL.revokeObjectURL(frameUrl.current);
      frameUrl.current = null;
    };
  }, [udid]);

  const send = useCallback((input: SimulatorPaneInput) => {
    window.b4m.simulator.input(input).catch(error => setProblem(errorText(error)));
  }, []);

  const attach = useCallback(
    (next: string) => {
      setProblem('');
      setBusy(true);
      window.b4m.simulator
        .attach(next)
        .catch(error => setProblem(errorText(error)))
        .finally(() => {
          setBusy(false);
          refreshDevices();
        });
    },
    [refreshDevices]
  );

  const pointAt = (event: ReactPointerEvent) => {
    const node = image.current;
    if (!node || !state.screen) return null;
    const rect = node.getBoundingClientRect();
    return toDevicePoints(
      event.clientX,
      event.clientY,
      {
        left: rect.left,
        top: rect.top,
        width: rect.width,
        height: rect.height,
        naturalWidth: node.naturalWidth,
        naturalHeight: node.naturalHeight,
      },
      state.screen
    );
  };

  const onPointerDown = (event: ReactPointerEvent<HTMLImageElement>) => {
    event.currentTarget.setPointerCapture(event.pointerId);
    event.currentTarget.focus();
    press.current = { x: event.clientX, y: event.clientY, at: performance.now() };
  };

  const onPointerUp = (event: ReactPointerEvent<HTMLImageElement>) => {
    const start = press.current;
    press.current = null;
    if (!start) return;
    const to = pointAt(event);
    if (!to) return;
    const moved = Math.hypot(event.clientX - start.x, event.clientY - start.y);
    if (moved < SWIPE_THRESHOLD_PX) {
      send({ kind: 'tap', ...to });
      return;
    }
    const from = pointAt({ ...event, clientX: start.x, clientY: start.y } as ReactPointerEvent);
    if (from) send({ kind: 'swipe', from, to, duration: (performance.now() - start.at) / 1000 });
  };

  const flushTyped = useCallback(() => {
    typeTimer.current = null;
    const text = typed.current;
    typed.current = '';
    if (text) send({ kind: 'type', text });
  }, [send]);

  const onKeyDown = (event: React.KeyboardEvent<HTMLImageElement>) => {
    if (event.metaKey || event.ctrlKey || event.altKey || event.key.length !== 1) return;
    event.preventDefault();
    typed.current += event.key;
    if (typeTimer.current !== null) window.clearTimeout(typeTimer.current);
    typeTimer.current = window.setTimeout(flushTyped, TYPE_FLUSH_MS);
  };

  useEffect(
    () => () => {
      if (typeTimer.current !== null) window.clearTimeout(typeTimer.current);
    },
    []
  );

  const shown = state.status === 'live' || state.status === 'starting';
  const message = problem || (state.status === 'error' ? state.message : '');

  return (
    <Stack
      sx={{
        width: SIMULATOR_PANE_WIDTH,
        flexShrink: 0,
        borderLeft: '1px solid',
        borderColor: 'divider',
        bgcolor: 'background.level1',
        height: '100%',
        minHeight: 0,
      }}
      data-testid="simulator-pane"
      data-status={state.status}
    >
      <Stack direction="row" alignItems="center" spacing={0.75} sx={{ px: 1.5, pt: 1.5, pb: 1 }}>
        <Typography level="title-sm" sx={{ flexShrink: 0 }}>
          iOS Simulator
        </Typography>
        <Select
          size="sm"
          variant="plain"
          placeholder="Choose a device"
          value={udid}
          onListboxOpenChange={open => open && refreshDevices()}
          onChange={(_event, value) => value && value !== udid && attach(value)}
          sx={{ flex: 1, minWidth: 0 }}
          slotProps={{ button: { 'aria-label': 'Simulator device' } }}
          data-testid="simulator-device-select"
        >
          {devices.map(device => (
            <Option key={device.udid} value={device.udid}>
              {device.name} ({device.runtime}){device.state === 'Booted' ? '' : ' - off'}
            </Option>
          ))}
        </Select>
        <IconButton
          size="sm"
          variant="plain"
          color="neutral"
          aria-label="Close the simulator view"
          onClick={onClose}
          data-testid="simulator-close-btn"
        >
          <CloseIcon />
        </IconButton>
      </Stack>

      {message && (
        <Alert
          color="warning"
          variant="soft"
          size="sm"
          sx={{ mx: 1.5, mb: 1, whiteSpace: 'pre-wrap', fontSize: 'xs' }}
          data-testid="simulator-error"
        >
          {message}
        </Alert>
      )}

      <Box
        sx={{
          flex: 1,
          minHeight: 0,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          px: 1.5,
          pb: 1,
          position: 'relative',
        }}
      >
        {shown ? (
          <>
            <Box
              component="img"
              ref={image}
              alt={state.device ? `${state.device.name} screen` : 'Simulator screen'}
              tabIndex={0}
              draggable={false}
              onPointerDown={onPointerDown}
              onPointerUp={onPointerUp}
              onKeyDown={onKeyDown}
              sx={{
                display: hasFrame ? 'block' : 'none',
                maxWidth: '100%',
                maxHeight: '100%',
                objectFit: 'contain',
                borderRadius: '28px',
                boxShadow: 'md',
                cursor: 'pointer',
                userSelect: 'none',
                touchAction: 'none',
                outline: 'none',
                '&:focus-visible': { boxShadow: theme => `0 0 0 2px ${theme.vars.palette.primary.outlinedBorder}` },
              }}
              data-testid="simulator-screen"
            />
            {!hasFrame && <CircularProgress size="sm" data-testid="simulator-starting" />}
          </>
        ) : (
          <Stack
            spacing={1.5}
            alignItems="center"
            sx={{ textAlign: 'center', maxWidth: 260 }}
            data-testid="simulator-empty"
          >
            <Typography level="body-sm">
              Watch an iOS app run here. The agent opens this view when it launches your app, or pick a device to start.
            </Typography>
            {devices
              .filter(device => device.state === 'Booted')
              .slice(0, 3)
              .map(device => (
                <Button
                  key={device.udid}
                  size="sm"
                  variant="soft"
                  loading={busy}
                  onClick={() => attach(device.udid)}
                  data-testid="simulator-attach-btn"
                >
                  Show {device.name} ({device.runtime})
                </Button>
              ))}
          </Stack>
        )}
      </Box>

      {shown && (
        <Stack direction="row" alignItems="center" spacing={0.5} sx={{ px: 1.5, pb: 1.5 }}>
          <Button
            size="sm"
            variant="plain"
            color="neutral"
            onClick={() => send({ kind: 'button', button: 'home' })}
            data-testid="simulator-home-btn"
          >
            Home
          </Button>
          <Button
            size="sm"
            variant="plain"
            color="neutral"
            onClick={() => send({ kind: 'button', button: 'lock' })}
            data-testid="simulator-lock-btn"
          >
            Lock
          </Button>
          <Button
            size="sm"
            variant="plain"
            color="neutral"
            onClick={() => send({ kind: 'appearance', mode: 'light' })}
            data-testid="simulator-light-btn"
          >
            Light
          </Button>
          <Button
            size="sm"
            variant="plain"
            color="neutral"
            onClick={() => send({ kind: 'appearance', mode: 'dark' })}
            data-testid="simulator-dark-btn"
          >
            Dark
          </Button>
        </Stack>
      )}
      {shown && state.source === 'snapshots' && state.message && (
        <Typography level="body-xs" sx={{ px: 1.5, pb: 1.5, color: 'text.tertiary' }} data-testid="simulator-note">
          {state.message}
        </Typography>
      )}
    </Stack>
  );
}
