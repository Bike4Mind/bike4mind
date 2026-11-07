import Alert from '@mui/joy/Alert';
import Box from '@mui/joy/Box';
import Button from '@mui/joy/Button';
import Chip from '@mui/joy/Chip';
import CircularProgress from '@mui/joy/CircularProgress';
import IconButton from '@mui/joy/IconButton';
import Slider from '@mui/joy/Slider';
import Stack from '@mui/joy/Stack';
import Typography from '@mui/joy/Typography';
import { useCallback, useLayoutEffect, useState, type RefObject } from 'react';
import { CloseIcon, CubeIcon } from './icons';
import type { ModelEngine } from './model3d/useModelEngine';
import { ModelClips } from './model3d/ModelClips';
import { ModelJoints } from './model3d/ModelJoints';
import { ModelViewport } from './model3d/ModelViewport';
import {
  clampModelPaneWidth,
  MODEL_PANE_MIN_WIDTH,
  MODEL_PANE_WIDTH,
  modelPaneMaxWidth,
  readModelPaneWidth,
  writeModelPaneWidth,
} from './model3d/modelPaneWidth';
import { ResizeHandle } from './ResizeHandle';

/** First-run prompts: game-asset shaped, since that is who this pane is for first. */
export const MODEL_EXAMPLE_PROMPTS = [
  'Make a low-poly treasure chest with a domed lid',
  'Make a modular dungeon wall piece with a doorway',
  'Make a stylised sword with a crossguard',
] as const;

type Props = {
  engine: ModelEngine;
  dark: boolean;
  onClose: () => void;
  /** Puts an example prompt in the composer. */
  onExamplePrompt: (text: string) => void;
  /** Adds a mention of a clicked part to the end of the composer's draft. */
  onPickPart: (text: string) => void;
  /** The column the pane trades width with; it bounds how wide a drag may take the pane. */
  conversation?: RefObject<HTMLElement | null>;
};

const STATUS_LABEL = { idle: 'No model', building: 'Building', ok: 'Ready', error: 'Error' } as const;
const STATUS_COLOR = { idle: 'neutral', building: 'primary', ok: 'success', error: 'danger' } as const;

function formatSize(size: [number, number, number], units: string): string {
  return `${size.map(value => Number(value.toFixed(value < 10 ? 2 : 1))).join(' x ')} ${units}`;
}

/** How a clicked part reads in the draft: its name as the model file and the agent know it. */
export function partMention(name: string): string {
  return `the \`${name}\` part `;
}

export function ModelPane({ engine, dark, onClose, onExamplePrompt, onPickPart, conversation }: Props) {
  const [width, setWidth] = useState(readModelPaneWidth);
  const [dragging, setDragging] = useState(false);
  const [limit, setLimit] = useState(() => modelPaneMaxWidth(window.innerWidth, Number.POSITIVE_INFINITY));
  const [pane, setPane] = useState<HTMLDivElement | null>(null);
  const clamp = useCallback((next: number) => clampModelPaneWidth(next, limit), [limit]);
  const commitWidth = useCallback((next: number) => writeModelPaneWidth(next), []);

  // The pane and the conversation split what the sidebar and other panes leave, so the ceiling is
  // measured from both; a drag moves width between them and does not move the ceiling.
  useLayoutEffect(() => {
    const measure = () => {
      const other = conversation?.current?.getBoundingClientRect().width;
      const own = pane?.getBoundingClientRect().width ?? 0;
      setLimit(modelPaneMaxWidth(window.innerWidth, other === undefined ? Number.POSITIVE_INFINITY : own + other));
    };
    measure();
    const observer = new ResizeObserver(measure);
    if (conversation?.current) observer.observe(conversation.current);
    window.addEventListener('resize', measure);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', measure);
    };
  }, [conversation, pane]);

  const { state, status, error, object, summary, params, unsaved, joints, jointAngles, clips } = engine;
  const [wireframe, setWireframe] = useState(false);
  // Keyed to the file, so opening another model never keeps a stale highlight.
  const [picked, setPicked] = useState<{ path: string | null; name: string } | null>(null);
  const pickedName = picked && picked.path === state.path ? picked.name : null;
  // Keyed to the file like `picked`, so another file opens at rest.
  const [playing, setPlaying] = useState<{ path: string | null; clip: string } | null>(null);
  const playingClip = playing && playing.path === state.path && clips.includes(playing.clip) ? playing.clip : null;
  const pickPart = (part: string | null) => {
    // A second click on the picked part, or a click on empty space, clears it without adding text.
    if (part === null || part === pickedName) {
      setPicked(null);
      return;
    }
    setPicked({ path: state.path, name: part });
    onPickPart(partMention(part));
  };
  const [note, setNote] = useState('');
  const name = state.path ? (state.path.split(/[\\/]/).pop() ?? state.path) : null;
  const paramEntries = Object.entries(params);
  const canExport = !!object && status !== 'building';

  const runExport = async (format: 'glb' | 'stl') => {
    try {
      const saved = await engine.exportFile(format);
      setNote(saved ? `Saved ${saved.split(/[\\/]/).pop()}` : '');
    } catch (caught) {
      setNote(caught instanceof Error ? caught.message : String(caught));
    }
  };

  const runOpen = async () => {
    try {
      await engine.openFile();
      setNote('');
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : String(caught);
      // Electron prefixes a rejected invoke with where it came from; the user needs the reason only.
      setNote(message.replace(/^Error invoking remote method '[^']+': (Error: )?/, ''));
    }
  };

  return (
    <Stack
      ref={setPane}
      style={{ width: Math.min(width, limit) }}
      sx={{
        position: 'relative',
        flexShrink: 0,
        borderLeft: '1px solid',
        borderColor: 'divider',
        bgcolor: 'background.level1',
        height: '100%',
        minHeight: 0,
      }}
      data-testid="model-pane"
      data-status={status}
    >
      <ResizeHandle
        edge="left"
        label="Resize 3D model pane"
        testId="model-pane-resize-handle"
        width={Math.min(width, limit)}
        min={Math.min(MODEL_PANE_MIN_WIDTH, limit)}
        max={limit}
        defaultWidth={MODEL_PANE_WIDTH}
        clamp={clamp}
        dragging={dragging}
        onWidth={setWidth}
        onCommit={commitWidth}
        onDraggingChange={setDragging}
        sx={{ left: -5 }}
      />
      <Stack direction="row" alignItems="center" spacing={0.75} sx={{ px: 1.5, pt: 1.5, pb: 1 }}>
        <Typography
          level="title-sm"
          noWrap
          sx={{ flex: 1, minWidth: 0 }}
          data-testid="model-pane-title"
          title={state.path ?? ''}
        >
          {name ?? '3D model'}
        </Typography>
        {name && (
          <Chip size="sm" variant="soft" color={STATUS_COLOR[status]} data-testid="model-pane-status">
            {STATUS_LABEL[status]}
          </Chip>
        )}
        <IconButton
          size="sm"
          variant="plain"
          color="neutral"
          aria-label="Close the model pane"
          onClick={onClose}
          data-testid="model-pane-close-btn"
        >
          <CloseIcon />
        </IconButton>
      </Stack>

      {error && (
        <Alert
          color="danger"
          variant="soft"
          size="sm"
          sx={{ mx: 1.5, mb: 1, whiteSpace: 'pre-wrap', fontSize: 'xs' }}
          data-testid="model-pane-error"
        >
          {error.line ? `Line ${error.line}: ` : ''}
          {error.message}
        </Alert>
      )}

      <Box
        sx={{
          flex: 1,
          minHeight: 0,
          position: 'relative',
          mx: 1.5,
          borderRadius: 'sm',
          overflow: 'hidden',
          bgcolor: 'background.surface',
        }}
      >
        {name ? (
          <>
            <ModelViewport
              object={object}
              wireframe={wireframe}
              dark={dark}
              dimmed={status === 'error'}
              frameKey={state.path}
              pose={jointAngles}
              picked={pickedName}
              onPick={pickPart}
              clip={playingClip}
            />
            {status === 'building' && !object && (
              <Stack alignItems="center" justifyContent="center" sx={{ position: 'absolute', inset: 0 }}>
                <CircularProgress size="sm" />
              </Stack>
            )}
            {summary && (
              <Typography
                level="body-xs"
                sx={{ position: 'absolute', left: 8, bottom: 6, pointerEvents: 'none', color: 'text.secondary' }}
                data-testid="model-pane-size"
              >
                {formatSize(summary.size, summary.units)}
                {state.kind === 'stl' ? ' (assumed)' : ''} - {summary.triangles} tris
                {summary.parts.length > 1 && (pickedName ? ` - ${pickedName}` : ' - click a part to mention it')}
              </Typography>
            )}
          </>
        ) : (
          <Stack
            spacing={1.25}
            justifyContent="center"
            sx={{ position: 'absolute', inset: 0, p: 2.5 }}
            data-testid="model-pane-empty"
          >
            <Box sx={{ color: 'text.tertiary', fontSize: 28, lineHeight: 0 }}>
              <CubeIcon />
            </Box>
            <Typography level="title-md">Prompt a 3D model</Typography>
            <Typography level="body-sm" sx={{ color: 'text.secondary' }}>
              Describe a model and the agent builds it here as code, live. Each version is saved as a .glb in your
              project, ready for three.js or Unity.
            </Typography>
            {MODEL_EXAMPLE_PROMPTS.map((prompt, index) => (
              <Button
                key={prompt}
                size="sm"
                variant="outlined"
                color="neutral"
                sx={{ justifyContent: 'flex-start', textAlign: 'left', fontWeight: 'md' }}
                onClick={() => onExamplePrompt(prompt)}
                data-testid={`model-pane-example-${index}`}
              >
                {prompt}
              </Button>
            ))}
            <Button
              size="sm"
              variant="plain"
              color="neutral"
              onClick={() => void runOpen()}
              data-testid="model-pane-open-empty-btn"
            >
              Or open a .glb / .stl file
            </Button>
          </Stack>
        )}
      </Box>

      {paramEntries.length > 0 && (
        <Stack spacing={0.5} sx={{ px: 1.5, pt: 1, maxHeight: 220, overflowY: 'auto' }} data-testid="model-pane-params">
          {paramEntries.map(([key, param]) => (
            <Stack key={key} direction="row" alignItems="center" spacing={1.25}>
              <Typography level="body-xs" noWrap sx={{ width: 96, flexShrink: 0 }} title={key}>
                {key}
              </Typography>
              <Slider
                size="sm"
                min={param.min}
                max={param.max}
                step={param.step}
                value={param.value}
                onChange={(_event, value) => typeof value === 'number' && engine.previewParam(key, value)}
                onChangeCommitted={(_event, value) => typeof value === 'number' && void engine.commitParam(key, value)}
                slotProps={{ input: { 'aria-label': key } }}
                data-testid={`model-pane-param-${key}`}
              />
              <Typography level="body-xs" sx={{ width: 44, flexShrink: 0, textAlign: 'right' }}>
                {Number(param.value.toFixed(3))}
              </Typography>
            </Stack>
          ))}
          {unsaved.length > 0 && (
            <Typography level="body-xs" color="warning" data-testid="model-pane-unsaved">
              Could not save {unsaved.join(', ')} to the file; the preview shows it, the file does not.
            </Typography>
          )}
        </Stack>
      )}

      {clips.length > 0 && (
        <ModelClips
          clips={clips}
          playing={playingClip}
          onPlay={clip => setPlaying(clip === null ? null : { path: state.path, clip })}
        />
      )}
      {joints.length > 0 && (
        <ModelJoints
          joints={joints}
          units={summary?.units ?? 'mm'}
          angles={jointAngles}
          onChange={engine.setJointAngles}
        />
      )}

      <Stack direction="row" alignItems="center" spacing={0.75} sx={{ px: 1.5, py: 1.25 }}>
        <Button
          size="sm"
          variant={wireframe ? 'soft' : 'plain'}
          color="neutral"
          disabled={!object}
          onClick={() => setWireframe(value => !value)}
          aria-pressed={wireframe}
          data-testid="model-pane-wireframe-btn"
        >
          Wireframe
        </Button>
        <Button
          size="sm"
          variant="plain"
          color="neutral"
          onClick={() => void runOpen()}
          data-testid="model-pane-open-btn"
        >
          Open
        </Button>
        <Box sx={{ flex: 1 }} />
        <Button
          size="sm"
          variant="outlined"
          color="neutral"
          disabled={!canExport}
          onClick={() => void runExport('glb')}
          data-testid="model-pane-export-glb-btn"
        >
          GLB
        </Button>
        <Button
          size="sm"
          variant="outlined"
          color="neutral"
          disabled={!canExport || state.kind !== 'model'}
          onClick={() => void runExport('stl')}
          data-testid="model-pane-export-stl-btn"
        >
          STL
        </Button>
      </Stack>
      {note && (
        <Typography level="body-xs" sx={{ px: 1.5, pb: 1, color: 'text.secondary' }} data-testid="model-pane-note">
          {note}
        </Typography>
      )}
    </Stack>
  );
}
