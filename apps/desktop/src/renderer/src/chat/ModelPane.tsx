import Alert from '@mui/joy/Alert';
import Box from '@mui/joy/Box';
import Button from '@mui/joy/Button';
import Chip from '@mui/joy/Chip';
import CircularProgress from '@mui/joy/CircularProgress';
import Divider from '@mui/joy/Divider';
import Dropdown from '@mui/joy/Dropdown';
import IconButton from '@mui/joy/IconButton';
import LinearProgress from '@mui/joy/LinearProgress';
import ListItemContent from '@mui/joy/ListItemContent';
import Menu from '@mui/joy/Menu';
import MenuButton from '@mui/joy/MenuButton';
import MenuItem from '@mui/joy/MenuItem';
import Slider from '@mui/joy/Slider';
import Stack from '@mui/joy/Stack';
import Tooltip from '@mui/joy/Tooltip';
import Typography from '@mui/joy/Typography';
import { keyframes } from '@mui/system';
import {
  useCallback,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
} from 'react';
import type { ModelLighting, ModelUnits, ModelView } from '@shared/model3d';
import {
  CaretDownIcon,
  CheckIcon,
  CloseIcon,
  CubeIcon,
  DownloadIcon,
  ExplodeIcon,
  FolderIcon,
  FrameIcon,
  GridIcon,
  RecordIcon,
  SunIcon,
  WarningIcon,
  WireframeIcon,
} from './icons';
import type { ModelEngine } from './model3d/useModelEngine';
import { ModelClips } from './model3d/ModelClips';
import { ModelJoints } from './model3d/ModelJoints';
import { canExplode, renderPartCloseup } from './model3d/modelScene';
import {
  ModelViewport,
  type ModelViewportHandle,
  type ViewportPick,
  type ViewportPoint,
} from './model3d/ModelViewport';
import { PartEditPrompt, partListLabel } from './model3d/PartEditPrompt';
import { formatModelEditNote, modelEditContext } from '@shared/modelEdit';
import {
  clampModelPaneWidth,
  MODEL_PANE_MIN_WIDTH,
  MODEL_PANE_WIDTH,
  modelPaneMaxWidth,
  readModelPaneWidth,
  writeModelPaneWidth,
} from './model3d/modelPaneWidth';
import { ResizeHandle } from './ResizeHandle';
import { TURNTABLE_SECONDS } from './model3d/turntable';

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
  /**
   * Sends a point-and-edit turn into this pane's conversation: what the user typed, the hidden
   * note tying it to the picked parts, and a close-up of them. Resolves false when it was refused.
   */
  onSendEdit: (edit: PartEditTurn) => Promise<boolean>;
  /** The column the pane trades width with; it bounds how wide a drag may take the pane. */
  conversation?: RefObject<HTMLElement | null>;
};

/** A point-and-edit turn, as the pane hands it to the conversation. */
export type PartEditTurn = {
  text: string;
  /**
   * The hidden context (shared/modelEdit.ts), never drawn in the thread; `withCloseup` false when
   * the close-up could not go along (a model that cannot read images).
   */
  note: (withCloseup: boolean) => string;
  closeup: { name: string; bytes: Uint8Array } | null;
};

/** The close-up's file name: the picked parts, kept to safe characters. */
export function closeupName(parts: readonly string[]): string {
  const slug = parts
    .join('-')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  return `model-edit-${slug || 'part'}.png`;
}

const NO_PARTS: readonly string[] = [];

const STATUS_LABEL = { idle: 'No model', building: 'Building', ok: 'Ready', error: 'Error' } as const;
const STATUS_COLOR = { idle: 'neutral', building: 'primary', ok: 'success', error: 'danger' } as const;

/** The camera presets, in menu order, with the key that picks each while the view has focus. */
export const MODEL_VIEW_PRESETS: readonly { view: ModelView | null; label: string; key: string }[] = [
  { view: null, label: 'Three-quarter', key: '0' },
  { view: 'front', label: 'Front', key: '1' },
  { view: 'right', label: 'Right', key: '2' },
  { view: 'top', label: 'Top', key: '3' },
  { view: 'back', label: 'Back', key: '4' },
];
/** One arrow-key orbit step, in radians. */
const ORBIT_STEP = Math.PI / 12;
const ZOOM_STEP = 0.85;
/** The lighting presets, in menu order; L steps through them while the view has focus. */
export const MODEL_LIGHTING_PRESETS: readonly { lighting: ModelLighting; label: string }[] = [
  { lighting: 'studio', label: 'Studio' },
  { lighting: 'sunset', label: 'Sunset' },
  { lighting: 'workshop', label: 'Workshop' },
  { lighting: 'night', label: 'Night' },
];
const KEY_HELP =
  'Arrow keys orbit, plus and minus zoom, 0 to 4 pick a view, W wireframe, G grid, E explode, L lighting, N night, [ and ] pick a part, Enter edits it.';

function nextLighting(lighting: ModelLighting): ModelLighting {
  const index = MODEL_LIGHTING_PRESETS.findIndex(preset => preset.lighting === lighting);
  return MODEL_LIGHTING_PRESETS[(index + 1) % MODEL_LIGHTING_PRESETS.length].lighting;
}

const pulse = keyframes`
  0%, 100% { opacity: 1; }
  50% { opacity: 0.35; }
`;

/** What the line under the toolbar says; an error reads in the danger colour. */
type Note = { kind: 'info' | 'success' | 'error'; text: string } | null;

/** What the pane's live region says, so a screen reader hears each build start, finish or fail. */
function buildAnnouncement(status: ModelEngine['status'], error: ModelEngine['error']): string {
  if (status === 'building') return 'Building the model.';
  if (status === 'ok') return 'Model built.';
  if (status !== 'error' || !error) return '';
  return error.line
    ? `Model build failed at line ${error.line}: ${error.message}`
    : `Model build failed: ${error.message}`;
}

const VISUALLY_HIDDEN = {
  position: 'absolute',
  width: 1,
  height: 1,
  overflow: 'hidden',
  clip: 'rect(0 0 0 0)',
  whiteSpace: 'nowrap',
} as const;

function errorText(caught: unknown): string {
  return caught instanceof Error ? caught.message : String(caught);
}

/** A tooltip'd icon toggle for the viewport toolbar; the pressed state is colour and aria-pressed both. */
function ViewToggle({
  label,
  shortcut,
  pressed,
  disabled,
  onToggle,
  testId,
  children,
}: {
  label: string;
  shortcut: string;
  pressed: boolean;
  disabled: boolean;
  onToggle: () => void;
  testId: string;
  children: ReactNode;
}) {
  return (
    <Tooltip title={`${label} (${shortcut})`} size="sm" placement="bottom" variant="solid">
      <IconButton
        size="sm"
        variant={pressed ? 'solid' : 'plain'}
        color={pressed ? 'primary' : 'neutral'}
        disabled={disabled}
        aria-label={label}
        aria-pressed={pressed}
        aria-keyshortcuts={shortcut}
        onClick={onToggle}
        data-testid={testId}
      >
        {children}
      </IconButton>
    </Tooltip>
  );
}

function formatSize(size: [number, number, number], units: string): string {
  return `${size.map(value => Number(value.toFixed(value < 10 ? 2 : 1))).join(' x ')} ${units}`;
}

export function ModelPane({ engine, dark, onClose, onExamplePrompt, onSendEdit, conversation }: Props) {
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

  const { state, status, error, object, summary, parts, params, unsaved, joints, jointAngles, clips } = engine;
  const explodable = useMemo(() => object !== null && canExplode(object), [object]);
  const [wireframe, setWireframe] = useState(false);
  const [grid, setGrid] = useState(false);
  const [lighting, setLighting] = useState<ModelLighting>('studio');
  const [exploded, setExploded] = useState(false);
  // The recorded share of the clip (0..1) while a turntable records, else null.
  const [recordProgress, setRecordProgress] = useState<number | null>(null);
  const recording = recordProgress !== null;
  const keyHelpId = useId();
  const viewportHandle = useRef<ModelViewportHandle | null>(null);
  const stageRef = useRef<HTMLDivElement | null>(null);
  // Keyed to the file, so opening another model never keeps a stale highlight.
  const [picked, setPicked] = useState<{ path: string | null; names: string[] } | null>(null);
  const pickedNames = useMemo(
    () => (picked && picked.path === state.path ? picked.names : NO_PARTS),
    [picked, state.path]
  );
  // The point-and-edit prompt, open by the selection; only a model file has code to edit.
  const editable = state.kind === 'model' && !!state.source && !!object && !recording;
  const [prompt, setPrompt] = useState<{
    path: string | null;
    point: ViewportPoint;
    bounds: { width: number; height: number };
  } | null>(null);
  const promptOpen = prompt && prompt.path === state.path && pickedNames.length > 0 && editable ? prompt : null;
  const [sending, setSending] = useState(false);
  // Parts a sent edit is waiting on, so the rebuild that changes them gets its moment.
  const [editing, setEditing] = useState<{ path: string | null; names: string[] } | null>(null);
  const editingNames = editing && editing.path === state.path ? editing.names : NO_PARTS;
  // Keyed to the file like `picked`, so another file opens at rest.
  const [playing, setPlaying] = useState<{ path: string | null; clip: string } | null>(null);
  const playingClip = playing && playing.path === state.path && clips.includes(playing.clip) ? playing.clip : null;
  const stageBounds = () => {
    const rect = stageRef.current?.getBoundingClientRect();
    return { width: rect?.width ?? 0, height: rect?.height ?? 0 };
  };
  const openPrompt = (point: ViewportPoint | null) =>
    setPrompt({
      path: state.path,
      point: point ?? { x: stageBounds().width / 2, y: stageBounds().height / 2 },
      bounds: stageBounds(),
    });
  const clearPick = () => {
    setPicked(null);
    setPrompt(null);
  };
  const pickPart = ({ name: part, additive, point }: ViewportPick) => {
    // Empty space, or a second plain click on the only picked part, clears the selection.
    if (part === null || (!additive && pickedNames.length === 1 && pickedNames[0] === part)) {
      clearPick();
      return;
    }
    const names = additive
      ? pickedNames.includes(part)
        ? pickedNames.filter(entry => entry !== part)
        : [...pickedNames, part]
      : [part];
    if (!names.length) {
      clearPick();
      return;
    }
    setPicked({ path: state.path, names });
    openPrompt(point);
  };
  // `[` and `]` from the keyboard: one part at a time, in the order the model lists them.
  const stepPick = (direction: 1 | -1) => {
    const all = summary?.parts ?? [];
    if (!all.length) return;
    const at = pickedNames.length ? all.indexOf(pickedNames[pickedNames.length - 1]) : -1;
    const next = all[(at + direction + all.length) % all.length] ?? all[0];
    setPicked({ path: state.path, names: [next] });
    setPrompt(null);
  };
  const sendEdit = async (text: string) => {
    if (!state.path || !state.source || !summary || !pickedNames.length) return;
    const names = [...pickedNames];
    setSending(true);
    try {
      const name = closeupName(names);
      const bytes = object ? await renderPartCloseup(object, names, dark, jointAngles).catch(() => null) : null;
      const context = {
        path: state.path,
        source: state.source,
        units: (summary.units === 'm' ? 'm' : 'mm') as ModelUnits,
        facts: parts,
        picked: names,
      };
      const note = (withCloseup: boolean) =>
        formatModelEditNote(modelEditContext(withCloseup ? { ...context, closeup: name } : context));
      const sent = await onSendEdit({ text, note, closeup: bytes ? { name, bytes } : null });
      if (!sent) return;
      setEditing({ path: state.path, names });
      clearPick();
      // Focus goes back to the view, so the next pick or shortcut works without a click.
      stageRef.current?.focus();
    } catch (caught) {
      setNote({ kind: 'error', text: errorText(caught) });
    } finally {
      setSending(false);
    }
  };
  const onEditShown = useCallback((shown: string[]) => {
    setEditing(current => {
      if (!current) return current;
      const left = current.names.filter(name => !shown.includes(name));
      return left.length ? { ...current, names: left } : null;
    });
  }, []);
  const [note, setNote] = useState<Note>(null);
  const name = state.path ? (state.path.split(/[\\/]/).pop() ?? state.path) : null;
  const paramEntries = Object.entries(params);
  const canExport = !!object && status !== 'building';
  // A failed build leaves the last good model on show, dimmed; a clip of it would pass for the current one.
  const canRecord = canExport && status !== 'error';
  const savedNote = (saved: string | null): Note =>
    saved ? { kind: 'success', text: `Saved ${saved.split(/[\\/]/).pop()}` } : null;

  const runExport = async (format: 'glb' | 'stl') => {
    try {
      setNote(savedNote(await engine.exportFile(format)));
    } catch (caught) {
      setNote({ kind: 'error', text: errorText(caught) });
    }
  };

  const runRecord = async () => {
    const handle = viewportHandle.current;
    if (!handle) return;
    // A playing clip would fight the turntable's own joint swing.
    setPlaying(null);
    setRecordProgress(0);
    setNote({ kind: 'info', text: `Recording a turntable (${TURNTABLE_SECONDS} s)...` });
    try {
      const session = engine.sessionId;
      const bytes = await handle.recordTurntable(joints, setRecordProgress);
      setRecordProgress(null);
      setNote(savedNote(await engine.saveRecording(session, bytes)));
    } catch (caught) {
      setNote({ kind: 'error', text: errorText(caught) });
    } finally {
      setRecordProgress(null);
    }
  };

  // Shortcuts act only while the view itself has focus, so they never steal a letter from a field.
  const onViewKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.target !== event.currentTarget || !object || recording) return;
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    const handle = viewportHandle.current;
    const preset = MODEL_VIEW_PRESETS.find(entry => entry.key === event.key);
    const actions: Record<string, () => void> = {
      ArrowLeft: () => handle?.orbit(-ORBIT_STEP, 0),
      ArrowRight: () => handle?.orbit(ORBIT_STEP, 0),
      ArrowUp: () => handle?.orbit(0, -ORBIT_STEP),
      ArrowDown: () => handle?.orbit(0, ORBIT_STEP),
      '+': () => handle?.zoom(ZOOM_STEP),
      '=': () => handle?.zoom(ZOOM_STEP),
      '-': () => handle?.zoom(1 / ZOOM_STEP),
      w: () => setWireframe(value => !value),
      g: () => setGrid(value => !value),
      l: () => setLighting(nextLighting),
      n: () => setLighting(value => (value === 'night' ? 'studio' : 'night')),
      e: () => explodable && setExploded(value => !value),
      '[': () => stepPick(-1),
      ']': () => stepPick(1),
      Enter: () => editable && pickedNames.length > 0 && openPrompt(handle?.partPoint(pickedNames) ?? null),
      Escape: () => clearPick(),
    };
    const action = preset
      ? () => handle?.setView(preset.view)
      : actions[event.key.length === 1 ? event.key.toLowerCase() : event.key];
    if (!action) return;
    event.preventDefault();
    action();
  };

  const runOpen = async () => {
    try {
      await engine.openFile();
      setNote(null);
    } catch (caught) {
      // Electron prefixes a rejected invoke with where it came from; the user needs the reason only.
      setNote({
        kind: 'error',
        text: errorText(caught).replace(/^Error invoking remote method '[^']+': (Error: )?/, ''),
      });
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

      {/* Always mounted: a live region added together with its text is often not read out. */}
      <Box component="span" role="status" aria-live="polite" sx={VISUALLY_HIDDEN} data-testid="model-pane-announcer">
        {buildAnnouncement(status, error)}
      </Box>

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
        ref={stageRef}
        tabIndex={object ? 0 : undefined}
        role={object ? 'application' : undefined}
        aria-roledescription={object ? '3D view' : undefined}
        aria-label={object && name ? `${name}, 3D view` : undefined}
        aria-describedby={object ? keyHelpId : undefined}
        onKeyDown={onViewKeyDown}
        data-testid="model-pane-stage"
        sx={{
          flex: 1,
          minHeight: 0,
          position: 'relative',
          mx: 1.5,
          borderRadius: 'sm',
          overflow: 'hidden',
          bgcolor: 'background.surface',
          outline: 'none',
          // Drawn over the canvas: an inset shadow on the box itself would sit under it.
          '&:focus-visible::after': {
            content: '""',
            position: 'absolute',
            inset: 0,
            borderRadius: 'inherit',
            boxShadow: 'inset 0 0 0 2px var(--joy-palette-focusVisible)',
            pointerEvents: 'none',
          },
          '&:focus-visible .model-key-help': { opacity: 1 },
        }}
      >
        {name ? (
          <>
            <ModelViewport
              object={object}
              wireframe={wireframe}
              grid={grid}
              lighting={lighting}
              dark={dark}
              dimmed={status === 'error'}
              frameKey={state.path}
              pose={jointAngles}
              exploded={exploded && explodable}
              picked={pickedNames}
              onPick={pickPart}
              editing={editingNames}
              onEditShown={onEditShown}
              clip={playingClip}
              handleRef={viewportHandle}
            />
            {promptOpen && (
              <PartEditPrompt
                key={`${promptOpen.point.x},${promptOpen.point.y}`}
                parts={pickedNames}
                point={promptOpen.point}
                bounds={promptOpen.bounds}
                sending={sending}
                onSend={text => void sendEdit(text)}
                onCancel={() => {
                  clearPick();
                  stageRef.current?.focus();
                }}
              />
            )}
            {status === 'building' && !object && (
              <Stack alignItems="center" justifyContent="center" sx={{ position: 'absolute', inset: 0 }}>
                <CircularProgress size="sm" />
              </Stack>
            )}
            {object && (
              <Stack
                direction="row"
                alignItems="center"
                spacing={0.25}
                role="toolbar"
                aria-label="View"
                sx={{
                  position: 'absolute',
                  top: 8,
                  right: 8,
                  p: 0.375,
                  borderRadius: 'md',
                  // Near-opaque, so the icons keep their contrast on the dark lighting backdrops too.
                  bgcolor: 'color-mix(in srgb, var(--joy-palette-background-surface) 88%, transparent)',
                  backdropFilter: 'blur(10px) saturate(1.4)',
                  boxShadow: 'sm',
                  border: '1px solid',
                  borderColor: 'divider',
                  opacity: recording ? 0 : 1,
                  transition: 'opacity 150ms',
                  pointerEvents: recording ? 'none' : undefined,
                }}
              >
                <ViewToggle
                  label="Wireframe"
                  shortcut="W"
                  pressed={wireframe}
                  disabled={recording}
                  onToggle={() => setWireframe(value => !value)}
                  testId="model-pane-wireframe-btn"
                >
                  <WireframeIcon />
                </ViewToggle>
                <ViewToggle
                  label="Grid"
                  shortcut="G"
                  pressed={grid}
                  disabled={recording}
                  onToggle={() => setGrid(value => !value)}
                  testId="model-pane-grid-btn"
                >
                  <GridIcon />
                </ViewToggle>
                {explodable && (
                  <ViewToggle
                    label="Exploded view"
                    shortcut="E"
                    pressed={exploded}
                    disabled={recording}
                    onToggle={() => setExploded(value => !value)}
                    testId="model-pane-explode-btn"
                  >
                    <ExplodeIcon />
                  </ViewToggle>
                )}
                <Dropdown>
                  <Tooltip title="Lighting (L)" size="sm" placement="bottom" variant="solid">
                    <MenuButton
                      slots={{ root: IconButton }}
                      slotProps={{
                        root: { size: 'sm', variant: lighting === 'studio' ? 'plain' : 'soft', color: 'neutral' },
                      }}
                      aria-label="Lighting"
                      disabled={recording}
                      data-testid="model-pane-lighting-btn"
                    >
                      <SunIcon />
                    </MenuButton>
                  </Tooltip>
                  <Menu size="sm" placement="bottom-end" sx={{ minWidth: 160 }}>
                    {MODEL_LIGHTING_PRESETS.map(preset => (
                      <MenuItem
                        key={preset.lighting}
                        selected={preset.lighting === lighting}
                        role="menuitemradio"
                        aria-checked={preset.lighting === lighting}
                        onClick={() => setLighting(preset.lighting)}
                        data-testid={`model-pane-lighting-${preset.lighting}`}
                      >
                        <ListItemContent>{preset.label}</ListItemContent>
                        {preset.lighting === lighting && <CheckIcon />}
                      </MenuItem>
                    ))}
                  </Menu>
                </Dropdown>
                <Divider orientation="vertical" sx={{ mx: 0.25, my: 0.5 }} />
                <Dropdown>
                  <Tooltip title="Camera view" size="sm" placement="bottom" variant="solid">
                    <MenuButton
                      slots={{ root: IconButton }}
                      slotProps={{ root: { size: 'sm', variant: 'plain', color: 'neutral' } }}
                      aria-label="Camera view"
                      disabled={recording}
                      data-testid="model-pane-view-btn"
                    >
                      <FrameIcon />
                    </MenuButton>
                  </Tooltip>
                  <Menu size="sm" placement="bottom-end" sx={{ minWidth: 180 }}>
                    {MODEL_VIEW_PRESETS.map(preset => (
                      <MenuItem
                        key={preset.key}
                        onClick={() => viewportHandle.current?.setView(preset.view)}
                        aria-keyshortcuts={preset.key}
                        data-testid={`model-pane-view-${preset.view ?? 'default'}`}
                      >
                        <ListItemContent>{preset.label}</ListItemContent>
                        <Typography level="body-xs" component="kbd" sx={{ color: 'text.tertiary', fontFamily: 'code' }}>
                          {preset.key}
                        </Typography>
                      </MenuItem>
                    ))}
                  </Menu>
                </Dropdown>
              </Stack>
            )}
            {object && (
              <Typography
                id={keyHelpId}
                className="model-key-help"
                level="body-xs"
                sx={{
                  position: 'absolute',
                  left: 8,
                  top: 8,
                  maxWidth: 'calc(100% - 180px)',
                  px: 0.75,
                  py: 0.25,
                  borderRadius: 'sm',
                  bgcolor: 'background.surface',
                  boxShadow: 'sm',
                  color: 'text.secondary',
                  pointerEvents: 'none',
                  opacity: 0,
                  transition: 'opacity 150ms',
                }}
              >
                {KEY_HELP}
              </Typography>
            )}
            {recording && (
              <>
                <Chip
                  size="sm"
                  variant="solid"
                  color="danger"
                  startDecorator={
                    <Box
                      component="span"
                      sx={{
                        display: 'inline-flex',
                        '@media (prefers-reduced-motion: no-preference)': {
                          animation: `${pulse} 1.2s ease-in-out infinite`,
                        },
                      }}
                    >
                      <RecordIcon />
                    </Box>
                  }
                  sx={{ position: 'absolute', top: 8, left: 8, fontVariantNumeric: 'tabular-nums' }}
                  data-testid="model-pane-rec-badge"
                >
                  REC {((recordProgress ?? 0) * TURNTABLE_SECONDS).toFixed(1)} / {TURNTABLE_SECONDS} s
                </Chip>
                <LinearProgress
                  determinate
                  value={(recordProgress ?? 0) * 100}
                  color="danger"
                  thickness={3}
                  aria-label="Recording progress"
                  sx={{ position: 'absolute', left: 0, right: 0, bottom: 0, borderRadius: 0 }}
                  data-testid="model-pane-record-progress"
                />
              </>
            )}
            {summary && !recording && (
              <Typography
                level="body-xs"
                sx={{
                  position: 'absolute',
                  left: 8,
                  bottom: 8,
                  maxWidth: 'calc(100% - 16px)',
                  px: 0.75,
                  py: 0.25,
                  borderRadius: 'sm',
                  bgcolor: 'color-mix(in srgb, var(--joy-palette-background-surface) 80%, transparent)',
                  backdropFilter: 'blur(6px)',
                  pointerEvents: 'none',
                  color: 'text.secondary',
                }}
                data-testid="model-pane-size"
              >
                {formatSize(summary.size, summary.units)}
                {state.kind === 'stl' ? ' (assumed)' : ''} - {summary.triangles} tris
                {summary.parts.length > 1 &&
                  (pickedNames.length
                    ? ` - ${partListLabel(pickedNames)}`
                    : editable
                      ? ' - click a part to edit it'
                      : '')}
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
          variant="plain"
          color="neutral"
          startDecorator={<FolderIcon />}
          disabled={recording}
          onClick={() => void runOpen()}
          data-testid="model-pane-open-btn"
        >
          Open
        </Button>
        <Box sx={{ flex: 1 }} />
        <Tooltip
          title={
            status === 'error' ? 'Fix the build error to record' : `Save an ${TURNTABLE_SECONDS} s turntable video`
          }
          size="sm"
          variant="solid"
        >
          <Button
            size="sm"
            variant="outlined"
            color={recording ? 'danger' : 'neutral'}
            startDecorator={
              <Box component="span" sx={{ display: 'inline-flex', color: 'danger.plainColor' }}>
                <RecordIcon />
              </Box>
            }
            disabled={!canRecord || recording}
            aria-busy={recording}
            onClick={() => void runRecord()}
            sx={{ fontVariantNumeric: 'tabular-nums' }}
            data-testid="model-pane-record-btn"
          >
            {recording ? `Recording ${Math.round((recordProgress ?? 0) * 100)}%` : 'Record'}
          </Button>
        </Tooltip>
        <Dropdown>
          <MenuButton
            size="sm"
            variant="outlined"
            color="neutral"
            startDecorator={<DownloadIcon />}
            endDecorator={<CaretDownIcon />}
            disabled={!canExport || recording}
            data-testid="model-pane-export-btn"
          >
            Export
          </MenuButton>
          <Menu size="sm" placement="top-end" sx={{ minWidth: 220 }}>
            <MenuItem onClick={() => void runExport('glb')} data-testid="model-pane-export-glb-btn">
              <ListItemContent>
                GLB
                <Typography level="body-xs" sx={{ color: 'text.tertiary' }}>
                  For three.js, Unity, Blender
                </Typography>
              </ListItemContent>
            </MenuItem>
            <MenuItem
              disabled={state.kind !== 'model'}
              onClick={() => void runExport('stl')}
              data-testid="model-pane-export-stl-btn"
            >
              <ListItemContent>
                STL
                <Typography level="body-xs" sx={{ color: 'text.tertiary' }}>
                  {state.kind === 'model' ? 'For 3D printing' : 'Only for models built from code'}
                </Typography>
              </ListItemContent>
            </MenuItem>
          </Menu>
        </Dropdown>
      </Stack>
      <Typography
        role="status"
        level="body-xs"
        startDecorator={note?.kind === 'success' ? <CheckIcon /> : note?.kind === 'error' ? <WarningIcon /> : undefined}
        sx={{
          px: 1.5,
          pb: note ? 1 : 0,
          color: note?.kind === 'error' ? 'danger.plainColor' : 'text.secondary',
          '&:empty': { display: 'none' },
        }}
        data-testid="model-pane-note"
      >
        {note?.text}
      </Typography>
    </Stack>
  );
}
