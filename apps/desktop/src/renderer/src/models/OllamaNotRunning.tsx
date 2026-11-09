import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import Box from '@mui/joy/Box';
import Button from '@mui/joy/Button';
import CircularProgress from '@mui/joy/CircularProgress';
import Stack from '@mui/joy/Stack';
import Typography from '@mui/joy/Typography';
import { LOCAL_SERVER_ID, type ModelServerLaunchView, type ModelServerMutationResult } from '@shared/modelServers';
import { OLLAMA_NOT_RUNNING, OLLAMA_START_HINT } from './localRuntimeCopy';

/** How long Start waits on main; `ollama serve` itself gives up after 30s. */
export const START_WAIT_MS = 45_000;
/** How long "started" shows before Start is offered again, in case the banner is still up because it stopped. */
export const STARTED_SHOW_MS = 15_000;

export type StartPhase = 'idle' | 'starting' | 'failed' | 'started';

const errorText = (caught: unknown) => (caught instanceof Error ? caught.message : String(caught));

/** Starts the Ollama Desktop runs on this computer. Its outcome belongs to the caller that clicked, not to every banner. */
export function useStartLocalOllama(launch: ModelServerLaunchView | null | undefined, onStarted: () => void) {
  const [phase, setPhase] = useState<StartPhase>('idle');
  const [error, setError] = useState<string | null>(null);
  const inFlight = useRef(false);
  // Mirrors inFlight for rendering: true from the click until main settles, past the wait if need be.
  const [launching, setLaunching] = useState(false);
  const live = useRef(true);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const onStartedRef = useRef(onStarted);
  onStartedRef.current = onStarted;

  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
      clearTimeout(timer.current);
    };
  }, []);

  useEffect(() => {
    if (phase !== 'started') return;
    const shown = setTimeout(() => setPhase('idle'), STARTED_SHOW_MS);
    return () => clearTimeout(shown);
  }, [phase]);

  // Servers are health-checked once a minute, so a view from before Ollama stopped would hide Start.
  const recheck = useCallback(() => {
    window.b4m.modelServers.check(LOCAL_SERVER_ID).catch((error: unknown) => {
      console.warn('Rechecking this computer failed', error);
    });
  }, []);
  const rechecked = useRef(false);
  useEffect(() => {
    if (rechecked.current) return;
    rechecked.current = true;
    recheck();
  }, [recheck]);

  const succeeded = () => {
    setPhase('started');
    setError(null);
    onStartedRef.current();
  };

  const start = async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    setLaunching(true);
    setPhase('starting');
    setError(null);
    const launched: Promise<ModelServerMutationResult> = window.b4m.modelServers
      .launch(LOCAL_SERVER_ID, 'start')
      .catch((caught: unknown) => ({ ok: false as const, error: errorText(caught) }));
    const waited = new Promise<'timeout'>(resolve => {
      timer.current = setTimeout(() => resolve('timeout'), START_WAIT_MS);
    });
    const first = await Promise.race([launched, waited]);
    clearTimeout(timer.current);
    if (first === 'timeout') {
      if (live.current) {
        setPhase('failed');
        setError(`no answer within ${START_WAIT_MS / 1000} seconds.`);
      }
      // Main may still finish the start, so no second start until it settles; a late success counts.
      const late = await launched;
      inFlight.current = false;
      if (!live.current) return;
      setLaunching(false);
      if (late.ok) succeeded();
      return;
    }
    inFlight.current = false;
    if (!live.current) return;
    setLaunching(false);
    if (first.ok) succeeded();
    else {
      setPhase('failed');
      setError(first.error);
    }
  };

  const shown: StartPhase = phase === 'starting' || launch?.busy === 'starting' ? 'starting' : phase;
  return { phase: shown, error, canStart: launch?.canStart === true, launching, start, recheck };
}

/**
 * "Ollama is not running" with a Start button when Desktop can start it here (Ollama found, nothing on its port),
 * else how to start it by hand. `compact` is one row, for the composer.
 */
export function OllamaNotRunning({
  launch,
  onStarted,
  onRetry,
  retryTestId = 'ollama-recheck-btn',
  compact = false,
  icon,
  actions,
  children,
}: {
  /** This computer's launch view from the model servers list; undefined while it loads. */
  launch: ModelServerLaunchView | null | undefined;
  /** After a start that succeeded: reload whatever lists models. */
  onStarted: () => void;
  /** Adds Check again, which also rechecks whether Desktop can start Ollama. */
  onRetry?: () => void;
  retryTestId?: string;
  compact?: boolean;
  icon?: ReactNode;
  /** More buttons between Start and Check again. */
  actions?: ReactNode;
  /** Detail lines under the status. */
  children?: ReactNode;
}) {
  const { phase, error, canStart, launching, start, recheck } = useStartLocalOllama(launch, onStarted);
  const starting = phase === 'starting';
  const blocked = starting || launching;
  const textLevel = compact ? 'body-xs' : 'body-sm';

  const status = (
    <Box role="status" aria-live="polite">
      {starting ? (
        <Typography level={textLevel} data-testid="ollama-start-progress">
          Starting Ollama...
        </Typography>
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
          {launch !== undefined && !canStart && !launch?.programPending && (
            <Typography level={textLevel} data-testid="ollama-start-hint">
              {OLLAMA_START_HINT}
            </Typography>
          )}
        </>
      )}
    </Box>
  );

  // aria-disabled rather than disabled, which Joy's `loading` also sets: a disabled button drops keyboard focus.
  const startButton = (starting || (canStart && phase !== 'started')) && (
    <Button
      size="sm"
      color={compact ? 'warning' : 'primary'}
      variant={compact ? 'soft' : 'solid'}
      aria-disabled={blocked}
      startDecorator={
        starting ? (
          <CircularProgress size="sm" aria-label="Starting Ollama" sx={{ '--CircularProgress-size': '16px' }} />
        ) : undefined
      }
      onClick={() => {
        if (!blocked) void start();
      }}
      data-testid="ollama-start-btn"
    >
      Start Ollama
    </Button>
  );

  const retryButton = onRetry && (
    <Button
      size="sm"
      variant="plain"
      color="neutral"
      onClick={() => {
        recheck();
        onRetry();
      }}
      data-testid={retryTestId}
    >
      Check again
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
          <Typography level="body-sm">{OLLAMA_NOT_RUNNING}</Typography>
          {status}
        </Stack>
        {startButton}
        {retryButton}
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
      {(startButton || actions || retryButton) && (
        <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap sx={{ pt: 0.5 }}>
          {startButton}
          {actions}
          {retryButton}
        </Stack>
      )}
    </Stack>
  );
}

/** The composer's banner, keyed by conversation so a failed start does not follow the user into another one. */
export function ComposerOllamaNotice({
  sessionId,
  launch,
  reload,
}: {
  sessionId: string | null;
  launch: ModelServerLaunchView | null | undefined;
  /** Reloads the chat model list, after a start and on Check again. */
  reload: () => void;
}) {
  return <OllamaNotRunning key={sessionId ?? ''} compact launch={launch} onStarted={reload} onRetry={reload} />;
}
