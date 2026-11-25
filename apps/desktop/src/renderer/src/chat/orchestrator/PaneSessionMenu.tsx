import Dropdown from '@mui/joy/Dropdown';
import ListDivider from '@mui/joy/ListDivider';
import Menu from '@mui/joy/Menu';
import MenuButton from '@mui/joy/MenuButton';
import MenuItem from '@mui/joy/MenuItem';
import Typography from '@mui/joy/Typography';
import type { ChatSessionSummary } from '@shared/chat';
import { CaretDownIcon, CheckIcon } from '../icons';
import { pinLabel, pinOptions, resolvePaneSession, type PinOption, type PinRelation } from './panePins';

/** What the per-pane session pickers need: the active session and the sessions a pane can show instead. */
export interface PaneSessionChoices {
  activeId: string | undefined;
  sessions: readonly ChatSessionSummary[];
  /** Presenter mode: the picker names sessions by relation only, as the pane labels do. */
  presenting: boolean;
}

const GROUP_LABEL: Record<PinRelation, string> = { parent: 'Parent', child: 'Agents', other: 'Other orchestrations' };
const GROUP_ORDER: readonly PinRelation[] = ['parent', 'child', 'other'];

/**
 * One pane's session picker in a split, beside its view picker (ViewSwitcher): follow the active session (the
 * default, stored as no pin), or pin the pane to another session. Picks call back with undefined to unpin.
 */
export function PaneSessionMenu({
  index,
  sessionId,
  choices,
  onPick,
}: {
  index: number;
  sessionId: string | undefined;
  choices: PaneSessionChoices;
  onPick(sessionId: string | undefined): void;
}) {
  const { activeId, sessions, presenting } = choices;
  const pinned = resolvePaneSession({ sessionId }, { activeId, sessions, split: true });
  const options = withPinned(pinOptions(activeId, sessions, { presenting }), pinned, choices);
  const current = pinned ? pinLabel(pinned, activeId, sessions, { presenting }) : 'Active session';
  return (
    <Dropdown>
      <MenuButton
        size="sm"
        variant={pinned ? 'soft' : 'plain'}
        color={pinned ? 'primary' : 'neutral'}
        endDecorator={<CaretDownIcon />}
        aria-label={`Pane ${index + 1} session: ${current}`}
        title={current}
        data-testid={`orchestrator-pane-session-menu-btn-${index}`}
        data-pinned={pinned ? 'true' : undefined}
        sx={{ maxWidth: 200, minWidth: 0 }}
      >
        <Typography level="body-sm" noWrap sx={{ color: 'inherit' }}>
          {current}
        </Typography>
      </MenuButton>
      <Menu
        size="sm"
        placement="bottom-start"
        sx={{ minWidth: 240, maxWidth: 360 }}
        data-testid={`orchestrator-pane-session-menu-${index}`}
      >
        <MenuItem
          selected={!pinned}
          onClick={() => onPick(undefined)}
          data-testid={`orchestrator-pane-${index}-session-option-active`}
        >
          <Typography level="body-sm" sx={{ flex: 1 }}>
            Follow active session
          </Typography>
          {!pinned && <CheckIcon />}
        </MenuItem>
        {GROUP_ORDER.map(relation => {
          const group = options.filter(option => option.relation === relation);
          if (group.length === 0) return null;
          return [
            <ListDivider key={`${relation}-divider`} />,
            <Typography
              key={`${relation}-label`}
              level="body-xs"
              textColor="text.tertiary"
              sx={{ px: 1.5, pt: 0.75, pb: 0.25 }}
            >
              {GROUP_LABEL[relation]}
            </Typography>,
            ...group.map(option => (
              <MenuItem
                key={option.sessionId}
                selected={option.sessionId === pinned?.id}
                onClick={() => onPick(option.sessionId)}
                data-testid={`orchestrator-pane-${index}-session-option-${option.sessionId}`}
              >
                <Typography level="body-sm" noWrap sx={{ flex: 1, minWidth: 0 }}>
                  {option.label}
                </Typography>
                {option.sessionId === pinned?.id && <CheckIcon />}
              </MenuItem>
            )),
          ];
        })}
      </Menu>
    </Dropdown>
  );
}

/** Keeps the pane's current pin listed even when it falls outside the offered options (past the cap). */
function withPinned(
  options: readonly PinOption[],
  pinned: ChatSessionSummary | undefined,
  { activeId, sessions, presenting }: PaneSessionChoices
): readonly PinOption[] {
  if (!pinned || options.some(option => option.sessionId === pinned.id)) return options;
  const label = pinLabel(pinned, activeId, sessions, { presenting });
  return [...options, { sessionId: pinned.id, relation: 'other', label }];
}
