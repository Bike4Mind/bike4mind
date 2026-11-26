import Box from '@mui/joy/Box';
import Button from '@mui/joy/Button';
import Dropdown from '@mui/joy/Dropdown';
import List from '@mui/joy/List';
import ListItem from '@mui/joy/ListItem';
import ListSubheader from '@mui/joy/ListSubheader';
import Menu from '@mui/joy/Menu';
import MenuButton from '@mui/joy/MenuButton';
import MenuItem from '@mui/joy/MenuItem';
import Tooltip from '@mui/joy/Tooltip';
import Typography from '@mui/joy/Typography';
import { isUnfinishedOutcome, type ChildOutcome } from '@shared/agentOutcome';
import { isAgentSession, type ChatSessionStatus, type ChatSessionSummary } from '@shared/chat';
import { BranchIcon, CheckIcon, WarningIcon } from './icons';
import { contentColumnSx } from './layout';
import { SessionBadge } from './SessionBadge';

/** What a chip shows: live status while the child runs, else how its last turn ended. */
export type ChildChipState = 'processing' | 'needs-action' | 'finished' | 'failed';

export interface ChildChip {
  id: string;
  title: string;
  state: ChildChipState;
  branch?: string;
  snippet?: string;
  /** Finished, but its last reply hit the length limit; noted on hover rather than marked red. */
  cutShort?: boolean;
}

// Whatever wants the user sorts first.
const STATE_RANK: Record<ChildChipState, number> = { 'needs-action': 0, processing: 1, failed: 2, finished: 3 };

export function childChipState(
  status: ChatSessionStatus | undefined,
  outcome: ChildOutcome | undefined
): ChildChipState {
  if (status === 'processing' || status === 'needs-action') return status;
  return isUnfinishedOutcome(outcome) ? 'failed' : 'finished';
}

/**
 * The open conversation's direct agent children, not archived, most urgent first and newest first
 * within a state. Side chats are excluded by isAgentSession; grandchildren belong to their own parent
 * (see backgroundTasks.ts spawnedSessions).
 */
export function childChips(
  sessions: readonly ChatSessionSummary[],
  statuses: ReadonlyMap<string, ChatSessionStatus>,
  parentId: string | null
): ChildChip[] {
  if (!parentId) return [];
  return sessions
    .filter(session => session.origin?.parentSessionId === parentId && isAgentSession(session) && !session.archived)
    .map(session => {
      const branch = session.project?.workspace ? session.project.workspaceBranch : undefined;
      const state = childChipState(statuses.get(session.id), session.lastOutcome);
      return {
        chip: {
          id: session.id,
          title: session.title,
          state,
          ...(branch ? { branch } : {}),
          ...(session.lastSnippet ? { snippet: session.lastSnippet } : {}),
          ...(state === 'finished' && session.lastOutcome === 'max-tokens' ? { cutShort: true } : {}),
        },
        createdAt: session.createdAt,
      };
    })
    .sort((a, b) => STATE_RANK[a.chip.state] - STATE_RANK[b.chip.state] || b.createdAt.localeCompare(a.createdAt))
    .map(entry => entry.chip);
}

/**
 * Split for drawing: running, waiting and failed children get chips of their own, finished ones
 * fold into one menu. `hidden` once nothing is live and every child's report card is already in
 * the thread, which then says everything the strip would.
 */
export function stripLayout(
  chips: readonly ChildChip[],
  reportedIds: ReadonlySet<string>
): { active: ChildChip[]; done: ChildChip[]; hidden: boolean } {
  const active = chips.filter(chip => chip.state !== 'finished');
  const done = chips.filter(chip => chip.state === 'finished');
  const live = chips.some(chip => chip.state === 'processing' || chip.state === 'needs-action');
  const hidden = chips.length === 0 || (!live && chips.every(chip => reportedIds.has(chip.id)));
  return { active, done, hidden };
}

const STATE_LABEL: Record<ChildChipState, string> = {
  processing: 'Working',
  'needs-action': 'Needs you',
  finished: 'Finished',
  failed: 'Did not finish',
};

/**
 * Hover text: the full branch (the chip truncates it), then the last reply's excerpt, with a note
 * when it was cut short.
 */
export function chipHint(chip: Pick<ChildChip, 'snippet' | 'cutShort' | 'branch'>): string | undefined {
  const excerpt = chip.cutShort ? (chip.snippet ? `${chip.snippet} (cut short)` : '(cut short)') : chip.snippet;
  const lines = [chip.branch ? `Branch: ${chip.branch}` : undefined, excerpt].filter(Boolean);
  return lines.length > 0 ? lines.join('\n') : undefined;
}

function ChipIcon({ state }: { state: ChildChipState }) {
  if (state === 'processing' || state === 'needs-action') return <SessionBadge status={state} />;
  return (
    <Box
      aria-label={STATE_LABEL[state]}
      data-testid="children-strip-outcome-icon"
      data-state={state}
      sx={{
        display: 'grid',
        placeItems: 'center',
        flexShrink: 0,
        color: state === 'failed' ? 'danger.plainColor' : 'success.plainColor',
        '& svg': { width: 14, height: 14 },
      }}
    >
      {state === 'failed' ? <WarningIcon /> : <CheckIcon />}
    </Box>
  );
}

function ChipLabel({ chip }: { chip: ChildChip }) {
  return (
    <>
      <Typography
        level="body-xs"
        textColor="text.primary"
        noWrap
        sx={{ minWidth: 0, maxWidth: 160 }}
        data-testid="children-strip-chip-title"
      >
        {chip.title}
      </Typography>
      {chip.branch && (
        <Typography
          level="body-xs"
          textColor="text.tertiary"
          noWrap
          startDecorator={<BranchIcon />}
          sx={{ minWidth: 0, maxWidth: 120, '& svg': { width: 12, height: 12 } }}
          data-testid="children-strip-chip-branch"
        >
          {chip.branch}
        </Typography>
      )}
    </>
  );
}

function ChildChipButton({ chip, onOpen }: { chip: ChildChip; onOpen: (sessionId: string) => void }) {
  const button = (
    <Button
      size="sm"
      variant="outlined"
      color={chip.state === 'needs-action' ? 'warning' : chip.state === 'failed' ? 'danger' : 'neutral'}
      onClick={() => onOpen(chip.id)}
      startDecorator={<ChipIcon state={chip.state} />}
      aria-label={`${chip.title} - ${STATE_LABEL[chip.state]}`}
      data-testid="children-strip-chip-btn"
      data-state={chip.state}
      sx={{ flexShrink: 0, minHeight: 28, px: 1, gap: 0.5, fontWeight: 'md', maxWidth: 280, borderRadius: 'sm' }}
    >
      <ChipLabel chip={chip} />
    </Button>
  );
  const hint = chipHint(chip);
  if (!hint) return button;
  return (
    <Tooltip
      title={hint}
      size="sm"
      variant="soft"
      placement="top-start"
      sx={{ maxWidth: 360, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}
    >
      {button}
    </Tooltip>
  );
}

function DoneMenu({ done, onOpen }: { done: readonly ChildChip[]; onOpen: (sessionId: string) => void }) {
  return (
    <Dropdown>
      <MenuButton
        size="sm"
        variant="outlined"
        color="neutral"
        startDecorator={<ChipIcon state="finished" />}
        data-testid="children-strip-done-btn"
        sx={{ flexShrink: 0, minHeight: 28, px: 1, gap: 0.5, fontWeight: 'md', borderRadius: 'sm' }}
      >
        <Typography level="body-xs" textColor="text.primary">
          {done.length} done
        </Typography>
      </MenuButton>
      <Menu
        size="sm"
        placement="top-start"
        sx={{ maxWidth: 360, zIndex: 'popup' }}
        data-testid="children-strip-done-menu"
      >
        {done.map(chip => (
          <MenuItem
            key={chip.id}
            onClick={() => onOpen(chip.id)}
            title={chipHint(chip)}
            data-testid="children-strip-done-item"
            sx={{ gap: 0.75, minWidth: 0 }}
          >
            <ChipLabel chip={chip} />
          </MenuItem>
        ))}
      </Menu>
    </Dropdown>
  );
}

/**
 * Most buttons the strip draws before it folds into the Party pill. The content column is 712px
 * wide inside its padding and a chip with a title and a branch runs ~170px, so four (the done menu
 * counts as one) still sit on one row; a fifth wraps.
 */
export const PARTY_THRESHOLD = 4;

export function foldsIntoParty(active: readonly ChildChip[], done: readonly ChildChip[]): boolean {
  return active.length + (done.length > 0 ? 1 : 0) > PARTY_THRESHOLD;
}

export type PartyGroupKey = 'needs-you' | 'working' | 'done';

export interface PartyGroup {
  key: PartyGroupKey;
  label: string;
  chips: ChildChip[];
}

const GROUP_OF: Record<ChildChipState, PartyGroupKey> = {
  'needs-action': 'needs-you',
  processing: 'working',
  failed: 'done',
  finished: 'done',
};

const GROUP_LABEL: Record<PartyGroupKey, string> = { 'needs-you': 'Needs you', working: 'Working', done: 'Done' };

/** The roster's non-empty groups, in the order the user acts on them; chips keep childChips' order within each. */
export function partyGroups(chips: readonly ChildChip[]): PartyGroup[] {
  return (['needs-you', 'working', 'done'] as const)
    .map(key => ({ key, label: GROUP_LABEL[key], chips: chips.filter(chip => GROUP_OF[chip.state] === key) }))
    .filter(group => group.chips.length > 0);
}

/** The state the pill leads with: the first of needs you, working, did not finish, finished that any chip is in. */
export function partyLead(chips: readonly ChildChip[]): ChildChipState {
  const order: readonly ChildChipState[] = ['needs-action', 'processing', 'failed'];
  return order.find(state => chips.some(chip => chip.state === state)) ?? 'finished';
}

/** The pill's text: the party size, then the count for its lead state. */
export function partySummary(chips: readonly ChildChip[]): string {
  const lead = partyLead(chips);
  const count = chips.filter(chip => chip.state === lead).length;
  const detail: Record<ChildChipState, string> = {
    'needs-action': `${count} ${count === 1 ? 'needs' : 'need'} you`,
    processing: `${count} working`,
    failed: `${count} did not finish`,
    finished: 'all done',
  };
  return `Party: ${chips.length} - ${detail[lead]}`;
}

function PartyPill({ chips, onOpen }: { chips: readonly ChildChip[]; onOpen: (sessionId: string) => void }) {
  const lead = partyLead(chips);
  return (
    <Dropdown>
      <MenuButton
        size="sm"
        variant="outlined"
        color={lead === 'needs-action' ? 'warning' : lead === 'failed' ? 'danger' : 'neutral'}
        startDecorator={<ChipIcon state={lead} />}
        aria-label={`${partySummary(chips)}. Show every session this conversation started`}
        data-testid="children-strip-party-btn"
        sx={{ minHeight: 28, px: 1.25, gap: 0.75, fontWeight: 'md', borderRadius: 'xl' }}
      >
        <Typography level="body-xs" textColor="text.primary" data-testid="children-strip-party-summary">
          {partySummary(chips)}
        </Typography>
      </MenuButton>
      <Menu
        size="sm"
        placement="top-start"
        sx={{ width: 360, maxWidth: 'calc(100vw - 32px)', maxHeight: 420, overflowY: 'auto', zIndex: 'popup' }}
        data-testid="children-strip-party-menu"
      >
        {partyGroups(chips).map(group => (
          <ListItem nested key={group.key} data-testid="children-strip-party-group" data-group={group.key}>
            <ListSubheader sticky>
              {group.label} ({group.chips.length})
            </ListSubheader>
            <List size="sm">
              {group.chips.map(chip => (
                <MenuItem
                  key={chip.id}
                  onClick={() => onOpen(chip.id)}
                  title={chipHint(chip)}
                  aria-label={`${chip.title} - ${STATE_LABEL[chip.state]}`}
                  data-testid="children-strip-party-item"
                  data-state={chip.state}
                  sx={{ gap: 0.75, minWidth: 0 }}
                >
                  <ChipIcon state={chip.state} />
                  <ChipLabel chip={chip} />
                </MenuItem>
              ))}
            </List>
          </ListItem>
        ))}
      </Menu>
    </Dropdown>
  );
}

/**
 * One row above the composer showing the sessions the open conversation spawned: which are still
 * working, which wait on the user, which failed, and how many are done, each a click away. Past
 * PARTY_THRESHOLD buttons it is one Party pill whose roster lists them grouped instead. Not drawn
 * when there are none, or once all have settled and reported into the thread.
 */
export function ChildrenStrip({
  sessions,
  statuses,
  parentId,
  reportedIds,
  onOpenSession,
}: {
  sessions: readonly ChatSessionSummary[];
  statuses: ReadonlyMap<string, ChatSessionStatus>;
  parentId: string | null;
  /** Children whose report is already in the open thread (ChatMessage.reportedChildId, set even when the card is withheld). */
  reportedIds: ReadonlySet<string>;
  onOpenSession: (sessionId: string) => void;
}) {
  const chips = childChips(sessions, statuses, parentId);
  const { active, done, hidden } = stripLayout(chips, reportedIds);
  if (hidden) return null;

  if (foldsIntoParty(active, done)) {
    return (
      <Box sx={{ ...contentColumnSx, pt: 1 }} data-testid="children-strip">
        <PartyPill chips={chips} onOpen={onOpenSession} />
      </Box>
    );
  }

  return (
    <Box sx={{ ...contentColumnSx, pt: 1 }} data-testid="children-strip">
      <Box
        role="list"
        aria-label="Sessions this conversation started"
        sx={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 0.75 }}
      >
        {active.map(chip => (
          <Box role="listitem" key={chip.id} sx={{ display: 'flex', minWidth: 0 }}>
            <ChildChipButton chip={chip} onOpen={onOpenSession} />
          </Box>
        ))}
        {done.length > 0 && (
          <Box role="listitem" sx={{ display: 'flex' }}>
            <DoneMenu done={done} onOpen={onOpenSession} />
          </Box>
        )}
      </Box>
    </Box>
  );
}
