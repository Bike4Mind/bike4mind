import { useState, type DragEvent, type MouseEvent, type ReactNode } from 'react';
import Box from '@mui/joy/Box';
import Button from '@mui/joy/Button';
import Chip from '@mui/joy/Chip';
import Dropdown from '@mui/joy/Dropdown';
import IconButton from '@mui/joy/IconButton';
import Input from '@mui/joy/Input';
import ListDivider from '@mui/joy/ListDivider';
import Menu from '@mui/joy/Menu';
import MenuButton from '@mui/joy/MenuButton';
import MenuItem from '@mui/joy/MenuItem';
import Typography from '@mui/joy/Typography';
import { workItemPriorityRank, type WorkItemPriority } from '@bike4mind/common';
import { UNSURE_PREFIX } from '@bike4mind/common/loops';
import type { LocalLoopDetail, LocalTicket, UpdateLocalTicketRequest } from '@shared/localLoops';
import { MoreIcon } from '../chat/icons';

const PRIORITIES: WorkItemPriority[] = ['p0', 'p1', 'p2', 'p3'];
const DRAG_TYPE = 'application/x-b4m-local-ticket';

export type TicketMove = Omit<UpdateLocalTicketRequest, 'id'>;

/** Where a drop lands: a stage column, or the Blocked strip. */
export type DropTarget = { stage: string } | { blocked: true };

/** The move a drop makes: into a stage (reopening a blocked or closed ticket), or blocked by the owner. */
export function dropMove(ticket: LocalTicket, target: DropTarget): TicketMove | null {
  if (ticket.status === 'in_progress') return null;
  if ('blocked' in target)
    return ticket.status === 'blocked' ? null : { status: 'blocked', reason: 'Blocked by owner' };
  if (ticket.stage === target.stage && ticket.status === 'open') return null;
  return { stage: target.stage, ...(ticket.status !== 'open' && { status: 'open' as const }) };
}

const byRunOrder = (a: LocalTicket, b: LocalTicket) =>
  Number(b.status === 'in_progress') - Number(a.status === 'in_progress') ||
  workItemPriorityRank(a.priority) - workItemPriorityRank(b.priority) ||
  a.createdAt.localeCompare(b.createdAt);

const isUnsure = (ticket: LocalTicket) => ticket.statusReason?.startsWith(UNSURE_PREFIX) ?? false;

interface CardActions {
  stages: string[];
  onOpen: (id: string) => void;
  onMove: (id: string, move: TicketMove) => void;
  onDelete: (id: string) => void;
}

function TicketCard({
  ticket,
  stages,
  runningModel,
  onOpen,
  onMove,
  onDelete,
}: CardActions & { ticket: LocalTicket; runningModel?: string }) {
  const running = ticket.status === 'in_progress';
  // Delete is permanent: the first click arms it, a second one from the reopened menu deletes.
  const [armed, setArmed] = useState(false);
  return (
    <Box
      role="button"
      tabIndex={0}
      draggable={!running}
      onDragStart={event => event.dataTransfer.setData(DRAG_TYPE, ticket.id)}
      onClick={() => onOpen(ticket.id)}
      onKeyDown={event => {
        if (event.target !== event.currentTarget || (event.key !== 'Enter' && event.key !== ' ')) return;
        event.preventDefault();
        onOpen(ticket.id);
      }}
      data-testid={`local-loops-card-${ticket.id}`}
      sx={{
        p: 1,
        borderRadius: 'sm',
        border: '1px solid',
        borderColor: running ? 'primary.outlinedBorder' : 'divider',
        bgcolor: 'background.surface',
        cursor: running ? 'pointer' : 'grab',
        display: 'flex',
        flexDirection: 'column',
        gap: 0.5,
        '&:hover': { bgcolor: 'background.level1' },
      }}
    >
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
        <Typography
          level="title-sm"
          sx={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
        >
          {ticket.title}
        </Typography>
        <Dropdown>
          <MenuButton
            slots={{ root: IconButton }}
            slotProps={{
              root: {
                size: 'sm',
                variant: 'plain',
                'aria-label': `Actions for ${ticket.title}`,
                'data-testid': `local-loops-card-menu-${ticket.id}`,
              },
            }}
            onClick={(event: MouseEvent) => event.stopPropagation()}
          >
            <MoreIcon />
          </MenuButton>
          <Menu size="sm" placement="bottom-end" onClick={event => event.stopPropagation()}>
            {PRIORITIES.map(priority => (
              <MenuItem
                key={priority}
                selected={ticket.priority === priority}
                onClick={() => onMove(ticket.id, { priority })}
                data-testid={`local-loops-card-priority-${priority}`}
              >
                Priority {priority}
              </MenuItem>
            ))}
            <MenuItem onClick={() => onMove(ticket.id, { priority: null })}>Clear priority</MenuItem>
            <ListDivider />
            {!running &&
              stages
                .filter(stage => stage !== ticket.stage || ticket.status !== 'open')
                .map(stage => (
                  <MenuItem key={stage} onClick={() => onMove(ticket.id, dropMove(ticket, { stage })!)}>
                    Move to {stage}
                  </MenuItem>
                ))}
            {ticket.status !== 'blocked' && (
              <MenuItem onClick={() => onMove(ticket.id, { status: 'blocked', reason: 'Blocked by owner' })}>
                Block
              </MenuItem>
            )}
            {ticket.status !== 'open' && ticket.status !== 'in_progress' && (
              <MenuItem
                onClick={() => onMove(ticket.id, { status: 'open' })}
                data-testid={`local-loops-card-reopen-${ticket.id}`}
              >
                Reopen
              </MenuItem>
            )}
            {ticket.status !== 'closed' && (
              <MenuItem
                onClick={() => onMove(ticket.id, { status: 'closed' })}
                data-testid={`local-loops-card-close-${ticket.id}`}
              >
                Close
              </MenuItem>
            )}
            {!running && (
              <MenuItem
                color="danger"
                onClick={() => (armed ? onDelete(ticket.id) : setArmed(true))}
                data-testid={`local-loops-card-delete-${ticket.id}`}
              >
                {armed ? 'Confirm delete' : 'Delete'}
              </MenuItem>
            )}
          </Menu>
        </Dropdown>
      </Box>
      {ticket.statusReason && ticket.status === 'blocked' && (
        <Typography level="body-xs" textColor="text.secondary" noWrap>
          {ticket.statusReason}
        </Typography>
      )}
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.75, flexWrap: 'wrap' }}>
        <Chip size="sm" variant="soft" color={ticket.priority ? 'neutral' : 'warning'}>
          {ticket.priority ?? 'untriaged'}
        </Chip>
        {running && (
          <Chip size="sm" variant="soft" color="primary" data-testid={`local-loops-card-running-${ticket.id}`}>
            running{runningModel ? ` on ${runningModel}` : ''}
          </Chip>
        )}
        {ticket.runCount > 0 && (
          <Typography level="body-xs" textColor="text.tertiary">
            {ticket.runCount} run{ticket.runCount === 1 ? '' : 's'}
          </Typography>
        )}
      </Box>
    </Box>
  );
}

function Lane({
  label,
  testId,
  target,
  tickets,
  runningModels,
  onDropTicket,
  children,
  ...actions
}: CardActions & {
  label: string;
  testId: string;
  /** Absent: not a drop target. */
  target?: DropTarget;
  tickets: LocalTicket[];
  runningModels: Map<string, string>;
  onDropTicket: (id: string, target: DropTarget) => void;
  children?: ReactNode;
}) {
  return (
    <Box
      data-testid={testId}
      onDragOver={target && ((event: DragEvent) => event.preventDefault())}
      onDrop={
        target &&
        ((event: DragEvent) => {
          event.preventDefault();
          const id = event.dataTransfer.getData(DRAG_TYPE);
          if (id) onDropTicket(id, target);
        })
      }
      sx={{ flex: '1 1 0', minWidth: 200, minHeight: 0, display: 'flex', flexDirection: 'column', gap: 1 }}
    >
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.75 }}>
        <Typography level="title-sm" noWrap>
          {label}
        </Typography>
        <Typography level="body-sm" textColor="text.tertiary">
          {tickets.length}
        </Typography>
      </Box>
      {children}
      <Box sx={{ flex: 1, minHeight: 0, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 1 }}>
        {tickets.map(ticket => (
          <TicketCard key={ticket.id} ticket={ticket} runningModel={runningModels.get(ticket.id)} {...actions} />
        ))}
      </Box>
    </Box>
  );
}

/**
 * The loop's tickets as a board: one column per stage, then Blocked and Unsure. Drag a card to a column (or use its
 * menu) to move it; the move shows at once and rolls back with the reason if main refuses it (useLocalLoop).
 */
export function LoopBoardView({
  detail,
  onMove,
  onCreate,
  onDelete,
  onOpen,
}: {
  detail: LocalLoopDetail;
  onMove: (id: string, move: TicketMove) => void;
  onCreate: (title: string) => Promise<boolean>;
  onDelete: (id: string) => void;
  onOpen: (id: string) => void;
}) {
  const [title, setTitle] = useState('');
  const [showClosed, setShowClosed] = useState(false);
  const { loop, tickets } = detail;
  const runningModels = new Map(
    detail.runs.filter(run => !run.endedAt && run.ticketId).map(run => [run.ticketId!, run.model])
  );
  const sorted = [...tickets].sort(byRunOrder);
  const active = sorted.filter(ticket => ticket.status === 'open' || ticket.status === 'in_progress');
  const blocked = sorted.filter(ticket => ticket.status === 'blocked');
  const closed = sorted.filter(ticket => ticket.status === 'closed');
  const onDropTicket = (id: string, target: DropTarget) => {
    const ticket = tickets.find(entry => entry.id === id);
    const move = ticket && dropMove(ticket, target);
    if (move) onMove(id, move);
  };
  const cardProps = { stages: loop.stages, runningModels, onOpen, onMove, onDelete, onDropTicket };

  const add = async () => {
    if (!title.trim()) return;
    if (await onCreate(title.trim())) setTitle('');
  };

  return (
    <Box
      data-testid="local-loops-board"
      sx={{ display: 'flex', flexDirection: 'column', gap: 1.5, flex: 1, minHeight: 0, p: 1.5 }}
    >
      <Box sx={{ display: 'flex', gap: 1.5, flex: 1, minHeight: 0, overflowX: 'auto' }}>
        {loop.stages.map((stage, i) => (
          <Lane
            key={stage}
            label={stage}
            testId={`local-loops-column-${stage}`}
            target={{ stage }}
            tickets={active.filter(
              ticket => ticket.stage === stage || (i === 0 && !loop.stages.includes(ticket.stage))
            )}
            {...cardProps}
          >
            {i === 0 && (
              <Input
                size="sm"
                placeholder="Add a ticket"
                value={title}
                onChange={event => setTitle(event.target.value)}
                onKeyDown={event => {
                  if (event.key === 'Enter') {
                    event.preventDefault();
                    void add();
                  }
                }}
                slotProps={{ input: { 'data-testid': 'local-loops-add-ticket-input' } }}
              />
            )}
          </Lane>
        ))}
        <Lane
          label="Blocked"
          testId="local-loops-column-blocked"
          target={{ blocked: true }}
          tickets={blocked.filter(ticket => !isUnsure(ticket))}
          {...cardProps}
        />
        <Lane label="Unsure" testId="local-loops-column-unsure" tickets={blocked.filter(isUnsure)} {...cardProps} />
      </Box>
      {closed.length > 0 && (
        <Box>
          <Button
            size="sm"
            variant="plain"
            color="neutral"
            onClick={() => setShowClosed(open => !open)}
            data-testid="local-loops-closed-toggle"
          >
            Closed ({closed.length})
          </Button>
          {showClosed && (
            <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 1, maxHeight: 200, overflowY: 'auto' }}>
              {closed.map(ticket => (
                <Box key={ticket.id} sx={{ width: 240 }}>
                  <TicketCard
                    ticket={ticket}
                    stages={loop.stages}
                    onOpen={onOpen}
                    onMove={onMove}
                    onDelete={onDelete}
                  />
                </Box>
              ))}
            </Box>
          )}
        </Box>
      )}
    </Box>
  );
}
