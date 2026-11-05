import { useEffect, useRef, useState, type ReactNode } from 'react';
import Button from '@mui/joy/Button';
import CircularProgress from '@mui/joy/CircularProgress';
import Stack from '@mui/joy/Stack';
import Typography from '@mui/joy/Typography';
import { LOCAL_SERVER_ID, type ModelServerLaunchView } from '@shared/modelServers';
import { OLLAMA_NOT_RUNNING, OLLAMA_START_HINT } from './localRuntimeCopy';

/** How long Start waits on main; `ollama serve` itself gives up after 30s. */
export const START_WAIT_MS = 45_000;
/** How long "started" shows before Start is offered again, in case the banner is still up because it stopped. */
export const STARTED_SHOW_MS = 15_000;

export type StartPhase = 'idle' | 'starting' | 'failed' | 'started';

/** Starts the Ollama Desktop runs on this computer. Its outcome belongs to the caller that clicked, not to every banner. */
export function useStartLocalOllama(launch: ModelServerLaunchView | null | undefined, onStarted: () => void) {
  const [phase, setPhase] = useState<StartPhase>('idle');
  const [error, setError] = useState<string | null>(null);
  const inFlight = useRef(false);
  const live = useRef(true);
  const onStartedRef = useRef(onStarted);
  onStartedRef.current = onStarted;

  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);

  useEffect(() => {
    if (phase !== 'started') return;
    const timer = setTimeout(() => setPhase('idle'), STARTED_SHOW_MS);
    return () => clearTimeout(timer);
  }, [phase]);

  // Servers are health-checked once a minute, so a view from before Ollama stopped would hide Start.
  const rechecked = useRef(false);
  useEffect(() => {
    if (rechecked.current) return;
    rechecked.current = true;
    window.b4m.modelServers.check(LOCAL_SERVER_ID).catch(() => undefined);
  }, []);

  const start = async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    setPhase('starting');
    setError(null);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const result = await Promise.race([
        window.b4m.modelServers.launch(LOCAL_SERVER_ID, 'start'),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(
            () => reject(new Error(`Ollama did not answer within ${START_WAIT_MS / 1000} seconds.`)),
            START_WAIT_MS
          );
        }),
      ]);
      if (!live.current) return;
      if (result.ok) {
        setPhase('started');
        onStartedRef.current();
      } else {
        setPhase('failed');
        setError(result.error);
      }
    } catch (caught) {
      if (!live.current) return;
      setPhase('failed');
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      clearTimeout(timer);
      inFlight.current = false;
    }
  };

  const shown: StartPhase = phase === 'starting' || launch?.busy === 'starting' ? 'starting' : phase;
  return { phase: shown, error, canStart: launch?.canStart === true, start };
}

/**
 * "Ollama is not running" with a Start button when Desktop can start it here (Ollama found, nothing on its port),
 * else how to start it by hand. `compact` is one row, for the composer.
 */
export function OllamaNotRunning({
  launch,
  onStarted,
  compact = false,
  icon,
  actions,
  children,
}: {
  /** This computer's launch view from the model servers list; null while it loads. */
  launch: ModelServerLaunchView | null | undefined;
  /** After a start that succeeded: reload whatever lists models. */
  onStarted: () => void;
  compact?: boolean;
  icon?: ReactNode;
  /** More buttons after Start. */
  actions?: ReactNode;
  /** Detail lines under the status. */
  children?: ReactNode;
}) {
  const { phase, error, canStart, start } = useStartLocalOllama(launch, onStarted);
  const offerStart = canStart && (phase === 'idle' || phase === 'failed');
  const textLevel = compact ? 'body-xs' : 'body-sm';

  const status =
    phase === 'starting' ? (
      <Stack direction="row" alignItems="center" spacing={1} data-testid="ollama-start-progress">
        <CircularProgress size="sm" sx={{ '--CircularProgress-size': '16px' }} />
        <Typography level={textLevel}>Starting Ollama...</Typography>
      </Stack>
    ) : phase === 'started' ? (
      <Typography level={textLevel} data-testid="ollama-start-done">
        Ollama started. Loading models...
      </Typography>
    ) : (
      <>
        {phase === 'failed' && (
          <Typography level={textLevel} color="danger" data-testid="ollama-start-error">
            Ollama did not start: {error}
          </Typography>
        )}
        {!canStart && (
          <Typography level={textLevel} data-testid="ollama-start-hint">
            {OLLAMA_START_HINT}
          </Typography>
        )}
      </>
    );

  const startButton = offerStart && (
    <Button
      size="sm"
      color={compact ? 'warning' : 'primary'}
      variant={compact ? 'soft' : 'solid'}
      onClick={() => void start()}
      data-testid="ollama-start-btn"
    >
      Start Ollama
    </Button>
  );

  if (compact)
    return (
      <Stack
        direction="row"
        alignItems="center"
        spacing={1}
        sx={{ width: '100%' }}
        data-testid="ollama-not-running"
        data-phase={phase}
      >
        <Stack spacing={0.25} sx={{ flex: 1, minWidth: 0 }}>
          <Typography level="body-sm">{OLLAMA_NOT_RUNNING}.</Typography>
          {status}
        </Stack>
        {startButton}
      </Stack>
    );

  return (
    <Stack spacing={0.5} data-testid="ollama-not-running" data-phase={phase}>
      <Stack direction="row" alignItems="center" spacing={1}>
        {icon}
        <Typography level="title-sm">{OLLAMA_NOT_RUNNING}</Typography>
      </Stack>
      {status}
      {children}
      {(startButton || actions) && (
        <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap sx={{ pt: 0.5 }}>
          {startButton}
          {actions}
        </Stack>
      )}
    </Stack>
  );
}
