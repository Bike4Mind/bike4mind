import Box from '@mui/joy/Box';
import Dropdown from '@mui/joy/Dropdown';
import ListDivider from '@mui/joy/ListDivider';
import ListItemDecorator from '@mui/joy/ListItemDecorator';
import Menu from '@mui/joy/Menu';
import MenuButton from '@mui/joy/MenuButton';
import MenuItem from '@mui/joy/MenuItem';
import Typography from '@mui/joy/Typography';
import { Fragment, useEffect, useRef, type ReactNode } from 'react';
import { BoardIcon, CaretDownIcon, CheckIcon, TableIcon, TavernIcon } from '../icons';
import { isMac } from '../platform';
import { ORCHESTRATOR_VIEWS, type OrchestratorViewId } from './orchestratorPrefs';

type ViewGroup = 'scene' | 'layout';

interface ViewInfo {
  label: string;
  description: string;
  group: ViewGroup;
  icon: ReactNode;
}

/** Every view's menu entry; typed by id so adding a view to ORCHESTRATOR_VIEWS fails until it has one. */
export const ORCHESTRATOR_VIEW_INFO: Record<OrchestratorViewId, ViewInfo> = {
  tavern: {
    label: 'Tavern',
    description: 'Agents as characters around the inn',
    group: 'scene',
    icon: <TavernIcon />,
  },
  board: { label: 'Board', description: 'Columns by state, like a kanban', group: 'layout', icon: <BoardIcon /> },
  table: { label: 'Table', description: 'Every agent in sortable rows', group: 'layout', icon: <TableIcon /> },
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

const SHORTCUT_HINT = isMac ? '\u2318\u21E7[ ]' : 'Ctrl+Shift+[ ]';

export function ViewSwitcher({
  view,
  onViewChange,
}: {
  view: OrchestratorViewId;
  onViewChange(view: OrchestratorViewId): void;
}) {
  const current = ORCHESTRATOR_VIEW_INFO[view];

  // On the window, as the sidebar's own shortcuts are: the user is usually typing in the composer.
  const latest = useRef({ view, onViewChange });
  latest.current = { view, onViewChange };
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      const step = viewStepFor(event);
      if (step === null) return;
      event.preventDefault();
      latest.current.onViewChange(stepView(latest.current.view, step));
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  return (
    <Dropdown>
      <MenuButton
        size="sm"
        variant="outlined"
        color="neutral"
        startDecorator={current.icon}
        endDecorator={<CaretDownIcon />}
        aria-label={`View: ${current.label}`}
        data-testid="orchestrator-view-menu-btn"
        data-view={view}
      >
        {current.label}
      </MenuButton>
      <Menu size="sm" placement="bottom-start" sx={{ minWidth: 260 }} data-testid="orchestrator-view-menu">
        {GROUP_ORDER.map((group, groupIndex) => (
          <Fragment key={group}>
            {groupIndex > 0 && <ListDivider />}
            <Typography level="body-xs" textColor="text.tertiary" sx={{ px: 1.5, pt: 0.75, pb: 0.25 }}>
              {GROUP_LABEL[group]}
            </Typography>
            {ORCHESTRATOR_VIEWS.filter(id => ORCHESTRATOR_VIEW_INFO[id].group === group).map(id => {
              const info = ORCHESTRATOR_VIEW_INFO[id];
              const selected = id === view;
              return (
                <MenuItem
                  key={id}
                  selected={selected}
                  onClick={() => onViewChange(id)}
                  data-testid={`orchestrator-view-option-${id}`}
                >
                  <ListItemDecorator>{info.icon}</ListItemDecorator>
                  <Box sx={{ flex: 1, minWidth: 0 }}>
                    <Typography level="body-sm">{info.label}</Typography>
                    <Typography level="body-xs" textColor="text.tertiary">
                      {info.description}
                    </Typography>
                  </Box>
                  {selected && <CheckIcon />}
                </MenuItem>
              );
            })}
          </Fragment>
        ))}
        <ListDivider />
        <Typography level="body-xs" textColor="text.tertiary" sx={{ px: 1.5, py: 0.5 }}>
          {`${SHORTCUT_HINT} to switch views`}
        </Typography>
      </Menu>
    </Dropdown>
  );
}
