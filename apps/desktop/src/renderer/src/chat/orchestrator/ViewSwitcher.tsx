import Box from '@mui/joy/Box';
import Dropdown from '@mui/joy/Dropdown';
import ListDivider from '@mui/joy/ListDivider';
import ListItemDecorator from '@mui/joy/ListItemDecorator';
import Menu, { type MenuProps } from '@mui/joy/Menu';
import MenuButton from '@mui/joy/MenuButton';
import MenuItem from '@mui/joy/MenuItem';
import Typography from '@mui/joy/Typography';
import { Fragment, useEffect, useMemo, useRef, type ReactNode } from 'react';
import {
  AquariumIcon,
  BoardIcon,
  CaretDownIcon,
  CheckIcon,
  ConstellationIcon,
  PlanIcon,
  SwimlanesIcon,
  TableIcon,
  TavernIcon,
  TileWallIcon,
  TransitIcon,
} from '../icons';
import { isMac } from '../platform';
import { ORCHESTRATOR_VIEWS, type OrchestratorViewId } from './orchestratorPrefs';
import {
  LAYOUT_PRESETS,
  applyPreset,
  presetOf,
  setPaneSession,
  setPaneView,
  singlePaneLayout,
  type LayoutPresetId,
  type OrchestratorLayout,
} from './orchestratorLayout';
import { AMBIENT_IDLE_MS } from './ambient';
import type { AgentDetailsSkin } from './AgentPeekDrawer';
import { SkinMenuSection } from './SkinMenuSection';
import { SoundPackMenuSection } from './SoundPackMenuSection';
import { PaneSessionMenu, type PaneSessionChoices } from './PaneSessionMenu';
import type { FinaleHostArt, FinaleLook } from './FinaleBanner';
import type { SceneDefinition } from './scene/sceneDefinition';
import { skinScene } from './scene/sceneSkin';
import { useSkinTheme } from './skins';
import { OFFICE_SCENE } from './office/officeScene';
import { TAVERN_SCENE } from './tavern/tavernScene';
import { AQUARIUM_SCENE } from './aquarium/aquariumScene';

type ViewGroup = 'scene' | 'layout';

/** What the stage and shell need to know about a scene view, so neither checks a view id. */
export interface SceneStageInfo {
  /** Draws the parent as a host character, so the finale banner and the empty prompt sit in the scene. */
  host: boolean;
  /** Answers every agent request in its own dialogue box, so the stage and composer leave theirs out. */
  inSceneDecisions: boolean;
  finale: FinaleLook;
  /** The host's portrait on the finale banner; the Innkeeper if unset. */
  hostArt?: FinaleHostArt;
  /** The scene's lines for the settled Needs-you card, quiet header, talk button, empty stage and finale. */
  copy: SceneDefinition['copy']['stage'];
  /** The scene as it ships; useSceneStageInfo reads the active skin's version of it. */
  definition: SceneDefinition;
}

/** A scene on the framework (scene/SceneStage) has every feature, so its info is read off its definition. */
const frameworkScene = (scene: SceneDefinition): SceneStageInfo => ({
  host: true,
  inSceneDecisions: true,
  finale: scene.look.finale,
  hostArt: scene.cast.host.sprites,
  copy: scene.copy.stage,
  definition: scene,
});

const TAVERN_STAGE_COPY = TAVERN_SCENE.copy.stage;

interface ViewInfo {
  label: string;
  description: string;
  group: ViewGroup;
  icon: ReactNode;
  /** Settles into a quiet scene when idle (ambient.ts), so the menu offers "Quiet when idle". */
  ambient: boolean;
  detailsSkin?: AgentDetailsSkin;
  /** Set for every `scene` view. */
  scene?: SceneStageInfo;
}

/** Every view's menu entry; typed by id so adding a view to ORCHESTRATOR_VIEWS fails until it has one. */
export const ORCHESTRATOR_VIEW_INFO: Record<OrchestratorViewId, ViewInfo> = {
  tavern: {
    label: 'Tavern',
    description: 'Agents as characters around the inn',
    group: 'scene',
    icon: <TavernIcon />,
    ambient: true,
    detailsSkin: {
      light: { background: '#f2ece1', border: '#c4b8a5' },
      dark: { background: '#29251f', border: '#5d5345' },
    },
    scene: frameworkScene(TAVERN_SCENE),
  },
  aquarium: {
    label: 'Aquarium',
    description: 'A quiet tank, one fish per agent',
    group: 'scene',
    icon: <AquariumIcon />,
    ambient: true,
    detailsSkin: {
      light: { background: '#e7eff0', border: '#a9bec3' },
      dark: { background: '#1d2c31', border: '#49616a' },
    },
    scene: frameworkScene(AQUARIUM_SCENE),
  },
  office: {
    label: 'Office',
    description: 'Manager and the team at Paper company',
    group: 'scene',
    icon: <BoardIcon />,
    ambient: true,
    detailsSkin: {
      light: { background: '#eef0e6', border: '#aebbab' },
      dark: { background: '#222d2a', border: '#4c5f58' },
      radius: '2px',
    },
    scene: frameworkScene(OFFICE_SCENE),
  },
  board: {
    label: 'Board',
    description: 'Columns by state, like a kanban',
    group: 'layout',
    icon: <BoardIcon />,
    ambient: false,
  },
  table: {
    label: 'Table',
    description: 'Every agent in sortable rows',
    group: 'layout',
    icon: <TableIcon />,
    ambient: false,
  },
  plan: {
    label: 'Plan',
    description: 'Done, working on and next for every agent',
    group: 'layout',
    icon: <PlanIcon />,
    ambient: false,
  },
  'tile-wall': {
    label: 'Tile Wall',
    description: 'A calm grid, one tile per agent',
    group: 'layout',
    icon: <TileWallIcon />,
    ambient: false,
  },
  swimlanes: {
    label: 'Swimlanes',
    description: 'One lane per agent, nested under its parent',
    group: 'layout',
    icon: <SwimlanesIcon />,
    ambient: false,
  },
  constellation: {
    label: 'Constellation',
    description: 'Agents as stars around the orchestrator',
    group: 'layout',
    icon: <ConstellationIcon />,
    ambient: false,
  },
  transit: {
    label: 'Transit',
    description: 'A line of stops, agents placed by phase',
    group: 'layout',
    icon: <TransitIcon />,
    ambient: false,
  },
};

const GROUP_LABEL: Record<ViewGroup, string> = { scene: 'Scenes', layout: 'Layouts' };
const GROUP_ORDER: readonly ViewGroup[] = ['scene', 'layout'];

/** The view after (or before) `current`, wrapping, in ORCHESTRATOR_VIEWS order. */
export function stepView(current: OrchestratorViewId, direction: 1 | -1): OrchestratorViewId {
  const index = ORCHESTRATOR_VIEWS.indexOf(current);
  return ORCHESTRATOR_VIEWS[(index + direction + ORCHESTRATOR_VIEWS.length) % ORCHESTRATOR_VIEWS.length];
}

/** Mod+Shift+] and Mod+Shift+[, matched by `code` so the shifted brace on any layout still counts. */
export function viewStepFor(event: Pick<KeyboardEvent, 'metaKey' | 'ctrlKey' | 'altKey' | 'shiftKey' | 'code'>) {
  const mod = isMac ? event.metaKey : event.ctrlKey;
  if (!mod || !event.shiftKey || event.altKey) return null;
  if (event.code === 'BracketRight') return 1;
  if (event.code === 'BracketLeft') return -1;
  return null;
}

/** Mod+Shift+F, matched by `code` like the view step. */
export function isFocusToggle(event: Pick<KeyboardEvent, 'metaKey' | 'ctrlKey' | 'altKey' | 'shiftKey' | 'code'>) {
  const mod = isMac ? event.metaKey : event.ctrlKey;
  return mod && event.shiftKey && !event.altKey && event.code === 'KeyF';
}

/** Mod+Shift+Esc, matched by `code` like the others: the reserved way back to a known layout. */
export function isViewReset(event: Pick<KeyboardEvent, 'metaKey' | 'ctrlKey' | 'altKey' | 'shiftKey' | 'code'>) {
  const mod = isMac ? event.metaKey : event.ctrlKey;
  return mod && event.shiftKey && !event.altKey && event.code === 'Escape';
}

/** What the reset lands on: the plain layout alone, so a skinned, broken or crowded stage is always escapable. */
export const RESET_VIEW: OrchestratorViewId = 'board';
export const RESET_LAYOUT: OrchestratorLayout = singlePaneLayout(RESET_VIEW);

const PRESET_INFO: Record<LayoutPresetId, { label: string; description: string }> = {
  single: { label: 'One view', description: 'The whole stage for one view' },
  'side-by-side': { label: 'Side by side', description: 'Two views next to each other' },
  stacked: { label: 'Stacked', description: 'Two views, one above the other' },
  'three-across': { label: 'Three across', description: 'Three views in a row' },
};
const PRESET_IDS = Object.keys(LAYOUT_PRESETS) as LayoutPresetId[];

/** Which pane Mod+Shift+[ ] steps: the one holding keyboard focus (StageLayout marks them), else the first. */
function focusedPane(layout: OrchestratorLayout): number {
  const pane = document.activeElement?.closest<HTMLElement>('[data-orchestrator-pane]');
  const index = Number(pane?.dataset.paneIndex);
  return Number.isInteger(index) && index < layout.panes.length ? index : 0;
}

const SHORTCUT_HINT = isMac ? '\u2318\u21E7[ ]' : 'Ctrl+Shift+[ ]';
const FOCUS_SHORTCUT = isMac ? '\u2318\u21E7F' : 'Ctrl+Shift+F';
const RESET_SHORTCUT = isMac ? '\u2318\u21E7Esc' : 'Ctrl+Shift+Esc';

/** Window space a menu leaves free, in px; Joy Menu's 4px offset comes out of it, leaving a 4px gap. */
const MENU_VIEWPORT_MARGIN = 8;
/** Below this many px the menu stops shrinking, so a button at the very bottom still shows a few items. */
const MENU_MIN_HEIGHT = 120;

/** The tallest a menu may be and still fit `space` px of window between its anchor and the window edge. */
export function menuMaxHeight(space: number): number {
  return Math.max(MENU_MIN_HEIGHT, Math.floor(space - MENU_VIEWPORT_MARGIN));
}

type MenuModifier = NonNullable<MenuProps['modifiers']>[number];

/**
 * Caps the menu to the window space on its side of the button (below, or above when Popper flips it)
 * so a long menu scrolls instead of running off a laptop screen with its last items unreachable.
 */
export const fitMenuToViewport: MenuModifier = {
  name: 'fitMenuToViewport',
  enabled: true,
  phase: 'beforeWrite',
  requires: ['computeStyles'],
  fn: ({ state }) => {
    const anchor = state.elements.reference.getBoundingClientRect();
    const space = state.placement.startsWith('top') ? anchor.top : window.innerHeight - anchor.bottom;
    state.styles.popper = { ...state.styles.popper, maxHeight: `${menuMaxHeight(space)}px` };
  },
};
const MENU_MODIFIERS = [fitMenuToViewport];

interface Toggle {
  on: boolean;
  onToggle(on: boolean): void;
}

export function ViewSwitcher({
  layout,
  onLayoutChange,
  ambient,
  focus,
  presenter,
  miniWindow,
  paneSessions,
}: {
  layout: OrchestratorLayout;
  onLayoutChange(layout: OrchestratorLayout): void;
  /** The quiet-when-idle switch; listed only while the stage is one view that settles. */
  ambient?: Toggle;
  /** Focus mode, on top of whichever layout is chosen; also toggled with Mod+Shift+F. */
  focus?: Toggle;
  /** Presenter mode (presenter.ts), on top of whichever view is chosen; Reset leaves it as it is. */
  presenter?: Toggle;
  /** The always-on-top Orchestrate mini window (orchestrateMini.ts); absent without the desktop bridge. */
  miniWindow?: Toggle;
  /** Lets each pane in a split be pinned to another session (panePins.ts); without it every pane follows. */
  paneSessions?: PaneSessionChoices;
}) {
  const view = layout.panes[0].view;
  const current = ORCHESTRATOR_VIEW_INFO[view];
  const split = layout.panes.length > 1;
  const preset = presetOf(layout);
  const menuLabel = split && preset ? PRESET_INFO[preset].label : current.label;
  const changePaneView = (index: number, paneView: OrchestratorViewId) =>
    onLayoutChange(setPaneView(layout, index, paneView));

  // On the window, as the sidebar's own shortcuts are: the user is usually typing in the composer.
  const latest = useRef({ layout, onLayoutChange, focus });
  latest.current = { layout, onLayoutChange, focus };
  const resetView = () => {
    const { onLayoutChange: changeLayout, focus: currentFocus } = latest.current;
    changeLayout(RESET_LAYOUT);
    if (currentFocus?.on) currentFocus.onToggle(false);
  };
  useEffect(() => {
    // Capture phase and stopped: the composer's and peek drawer's Escape handlers would otherwise
    // take the chord first (stopping a turn, closing the drawer) and the reset would never run.
    const onResetKeyDown = (event: KeyboardEvent) => {
      // The focus toggle rides the capture phase too, so it is handled ahead of the sidebar's own
      // Mod+Shift+F (focus its search), which yields to a chord already handled.
      const { focus: currentFocus } = latest.current;
      if (currentFocus && isFocusToggle(event)) {
        event.preventDefault();
        currentFocus.onToggle(!currentFocus.on);
        return;
      }
      if (!isViewReset(event)) return;
      event.preventDefault();
      event.stopPropagation();
      resetView();
    };
    window.addEventListener('keydown', onResetKeyDown, true);
    return () => window.removeEventListener('keydown', onResetKeyDown, true);
  }, []);
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      const { layout: currentLayout, onLayoutChange: changeLayout } = latest.current;
      const step = viewStepFor(event);
      if (step === null) return;
      event.preventDefault();
      const pane = focusedPane(currentLayout);
      changeLayout(setPaneView(currentLayout, pane, stepView(currentLayout.panes[pane].view, step)));
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  return (
    <Box sx={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 0.75, minWidth: 0 }}>
      <Dropdown>
        <MenuButton
          size="sm"
          variant="outlined"
          color="neutral"
          startDecorator={split ? <LayoutIcon split={layout.split} panes={layout.panes.length} /> : current.icon}
          endDecorator={<CaretDownIcon />}
          aria-label={`View: ${menuLabel}${focus?.on ? ', focused' : ''}`}
          data-testid="orchestrator-view-menu-btn"
          data-view={view}
          data-layout={preset ?? 'custom'}
          data-focus={focus?.on ? 'on' : 'off'}
        >
          {focus?.on ? `${menuLabel} \u00B7 Focus` : menuLabel}
        </MenuButton>
        <Menu
          size="sm"
          placement="bottom-start"
          modifiers={MENU_MODIFIERS}
          sx={{ minWidth: 260, overflowY: 'auto' }}
          data-testid="orchestrator-view-menu"
        >
          <Typography level="body-xs" textColor="text.tertiary" sx={{ px: 1.5, pt: 0.75, pb: 0.25 }}>
            Panes
          </Typography>
          {PRESET_IDS.map(id => (
            <MenuItem
              key={id}
              selected={id === preset}
              onClick={() => onLayoutChange(applyPreset(layout, id))}
              data-testid={`orchestrator-layout-option-${id}`}
            >
              <ListItemDecorator>
                <LayoutIcon split={LAYOUT_PRESETS[id].split} panes={LAYOUT_PRESETS[id].panes} />
              </ListItemDecorator>
              <Box sx={{ flex: 1, minWidth: 0 }}>
                <Typography level="body-sm">{PRESET_INFO[id].label}</Typography>
                <Typography level="body-xs" textColor="text.tertiary">
                  {PRESET_INFO[id].description}
                </Typography>
              </Box>
              {id === preset && <CheckIcon />}
            </MenuItem>
          ))}
          {/* A split picks each pane's view from that pane's own menu beside this one. */}
          {!split && (
            <>
              <ListDivider />
              <ViewOptions
                selected={view}
                onPick={id => changePaneView(0, id)}
                testIdPrefix="orchestrator-view-option"
              />
            </>
          )}
          <ListDivider />
          <MenuItem onClick={resetView} data-testid="orchestrator-view-reset">
            <Box sx={{ flex: 1, minWidth: 0 }}>
              <Typography level="body-sm">Reset to Board</Typography>
              <Typography level="body-xs" textColor="text.tertiary">
                {`Back to Board alone, Focus off (${RESET_SHORTCUT})`}
              </Typography>
            </Box>
          </MenuItem>
          {focus && (
            <>
              <ListDivider />
              <MenuItem
                role="menuitemcheckbox"
                aria-checked={focus.on}
                onClick={() => focus.onToggle(!focus.on)}
                data-testid="orchestrator-focus-toggle"
              >
                <Box sx={{ flex: 1, minWidth: 0 }}>
                  <Typography level="body-sm">Focus</Typography>
                  <Typography level="body-xs" textColor="text.tertiary">
                    {`Show only what needs you (${FOCUS_SHORTCUT})`}
                  </Typography>
                </Box>
                {focus.on && <CheckIcon />}
              </MenuItem>
            </>
          )}
          {presenter && (
            <>
              <ListDivider />
              <MenuItem
                role="menuitemcheckbox"
                aria-checked={presenter.on}
                onClick={() => presenter.onToggle(!presenter.on)}
                data-testid="orchestrator-presenter-toggle"
              >
                <Box sx={{ flex: 1, minWidth: 0 }}>
                  <Typography level="body-sm">Presenter mode</Typography>
                  <Typography level="body-xs" textColor="text.tertiary">
                    Hide titles, activity, questions, PRs and costs for screen sharing
                  </Typography>
                </Box>
                {presenter.on && <CheckIcon />}
              </MenuItem>
            </>
          )}
          {miniWindow && (
            <>
              <ListDivider />
              <MenuItem
                role="menuitemcheckbox"
                aria-checked={miniWindow.on}
                onClick={() => miniWindow.onToggle(!miniWindow.on)}
                data-testid="orchestrator-mini-window-toggle"
              >
                <Box sx={{ flex: 1, minWidth: 0 }}>
                  <Typography level="body-sm">Mini window</Typography>
                  <Typography level="body-xs" textColor="text.tertiary">
                    Keep what needs you in a small window on top of other apps
                  </Typography>
                </Box>
                {miniWindow.on && <CheckIcon />}
              </MenuItem>
            </>
          )}
          {ambient && current.ambient && !split && (
            <>
              <ListDivider />
              <MenuItem
                role="menuitemcheckbox"
                aria-checked={ambient.on}
                onClick={() => ambient.onToggle(!ambient.on)}
                data-testid="orchestrator-ambient-toggle"
              >
                <Box sx={{ flex: 1, minWidth: 0 }}>
                  <Typography level="body-sm">Quiet when idle</Typography>
                  <Typography level="body-xs" textColor="text.tertiary">
                    {`After ${AMBIENT_IDLE_MS / 1000} seconds without input, hide the conversation, composer and agent details`}
                  </Typography>
                </Box>
                {ambient.on && <CheckIcon />}
              </MenuItem>
            </>
          )}
          <SkinMenuSection />
          <SoundPackMenuSection />
          <ListDivider />
          <Typography level="body-xs" textColor="text.tertiary" sx={{ px: 1.5, py: 0.5 }}>
            {split ? `${SHORTCUT_HINT} to switch the focused pane's view` : `${SHORTCUT_HINT} to switch views`}
          </Typography>
        </Menu>
      </Dropdown>
      {split &&
        layout.panes.map((pane, index) => (
          <Box key={index} sx={{ display: 'flex', alignItems: 'center', gap: 0.25, minWidth: 0 }}>
            <PaneViewMenu index={index} view={pane.view} onPick={id => changePaneView(index, id)} />
            {paneSessions && (
              <PaneSessionMenu
                index={index}
                sessionId={pane.sessionId}
                choices={paneSessions}
                onPick={sessionId => onLayoutChange(setPaneSession(layout, index, sessionId))}
              />
            )}
          </Box>
        ))}
    </Box>
  );
}

/** The views grouped as in ORCHESTRATOR_VIEWS, with `selected` checked; shared by the main and per-pane menus. */
function ViewOptions({
  selected,
  onPick,
  testIdPrefix,
}: {
  selected: OrchestratorViewId;
  onPick(view: OrchestratorViewId): void;
  testIdPrefix: string;
}) {
  return GROUP_ORDER.map((group, groupIndex) => (
    <Fragment key={group}>
      {groupIndex > 0 && <ListDivider />}
      <Typography level="body-xs" textColor="text.tertiary" sx={{ px: 1.5, pt: 0.75, pb: 0.25 }}>
        {GROUP_LABEL[group]}
      </Typography>
      {ORCHESTRATOR_VIEWS.filter(id => ORCHESTRATOR_VIEW_INFO[id].group === group).map(id => {
        const info = ORCHESTRATOR_VIEW_INFO[id];
        const isSelected = id === selected;
        return (
          <MenuItem key={id} selected={isSelected} onClick={() => onPick(id)} data-testid={`${testIdPrefix}-${id}`}>
            <ListItemDecorator>{info.icon}</ListItemDecorator>
            <Box sx={{ flex: 1, minWidth: 0 }}>
              <Typography level="body-sm">{info.label}</Typography>
              <Typography level="body-xs" textColor="text.tertiary">
                {info.description}
              </Typography>
            </Box>
            {isSelected && <CheckIcon />}
          </MenuItem>
        );
      })}
    </Fragment>
  ));
}

/** One pane's view picker in a split, numbered as the pane's region is labelled (StageLayout). */
function PaneViewMenu({
  index,
  view,
  onPick,
}: {
  index: number;
  view: OrchestratorViewId;
  onPick(view: OrchestratorViewId): void;
}) {
  const info = ORCHESTRATOR_VIEW_INFO[view];
  return (
    <Dropdown>
      <MenuButton
        size="sm"
        variant="plain"
        color="neutral"
        startDecorator={info.icon}
        endDecorator={<CaretDownIcon />}
        aria-label={`Pane ${index + 1} view: ${info.label}`}
        data-testid={`orchestrator-pane-view-menu-btn-${index}`}
        data-view={view}
      >
        {`${index + 1}. ${info.label}`}
      </MenuButton>
      <Menu
        size="sm"
        placement="bottom-start"
        modifiers={MENU_MODIFIERS}
        sx={{ minWidth: 260, overflowY: 'auto' }}
        data-testid={`orchestrator-pane-view-menu-${index}`}
      >
        <ViewOptions selected={view} onPick={onPick} testIdPrefix={`orchestrator-pane-${index}-view-option`} />
      </Menu>
    </Dropdown>
  );
}

/** A small diagram of a pane preset: `panes` boxes in a row or a column. */
function LayoutIcon({ split, panes = 2 }: { split: 'row' | 'column'; panes?: number }) {
  const row = split === 'row';
  return (
    <Box
      aria-hidden
      sx={{
        display: 'flex',
        flexDirection: row ? 'row' : 'column',
        gap: '2px',
        width: 16,
        height: 14,
      }}
    >
      {Array.from({ length: panes }, (_, index) => (
        <Box key={index} sx={{ flex: 1, border: '1.5px solid currentColor', borderRadius: '2px' }} />
      ))}
    </Box>
  );
}

/**
 * A scene view's info as the active skin dresses it (copy, host art); undefined for a layout. The feature
 * flags and `definition` stay the view's own, so a skinned scene has exactly the features of the bare one.
 */
export function useSceneStageInfo(view: OrchestratorViewId): SceneStageInfo | undefined {
  const theme = useSkinTheme();
  const info = ORCHESTRATOR_VIEW_INFO[view].scene;
  const block = info && theme.scenes[info.definition.id];
  return useMemo(() => {
    if (!info || !block) return info;
    const skinned = skinScene(info.definition, block, theme.id);
    return { ...info, hostArt: skinned.cast.host.sprites, copy: skinned.copy.stage };
  }, [info, block, theme.id]);
}

/** A view's stage lines under the active skin; a layout, which never settles or hosts, falls back to the Tavern's. */
export function useSceneStageCopy(view: OrchestratorViewId): SceneStageInfo['copy'] {
  return useSceneStageInfo(view)?.copy ?? TAVERN_STAGE_COPY;
}
