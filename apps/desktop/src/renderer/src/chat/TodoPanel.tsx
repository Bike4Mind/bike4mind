import { useState } from 'react';
import Box from '@mui/joy/Box';
import Stack from '@mui/joy/Stack';
import Typography from '@mui/joy/Typography';
import { todoProgress, type PlanItem, type PlanItemStatus } from '@shared/todos';
import { contentColumnSx, thinScrollbarSx } from './layout';

const MARKER: Record<PlanItemStatus, string> = {
  completed: '\u2713',
  in_progress: '\u25cf',
  pending: '\u25cb',
  cancelled: '\u2715',
};

/**
 * The plan worth drawing, or null.
 *
 * Hidden once every item is done or cancelled and no turn is running: a finished plan left on
 * screen reads as work still owed. While a turn is open it stays, so the last tick is seen landing,
 * unless every item is cancelled and there is nothing to count. Shared by this bar and the session
 * panel's Plan section so the two agree on when there is a plan at all.
 */
export function visiblePlan(todos: readonly PlanItem[] | null, turnOpen: boolean): readonly PlanItem[] | null {
  if (!todos || todos.length === 0) return null;
  const { done, total } = todoProgress(todos);
  if (total === 0 || (done === total && !turnOpen)) return null;
  return todos;
}

/** The items themselves, with their status markers. */
export function TodoList({ todos }: { todos: readonly PlanItem[] }) {
  return (
    <Stack
      component="ul"
      spacing={0.25}
      sx={{ m: 0, mt: 0.5, p: 0, listStyle: 'none', maxHeight: '25vh', overflowY: 'auto', ...thinScrollbarSx }}
    >
      {todos.map(todo => (
        <Stack
          component="li"
          key={todo.id}
          direction="row"
          spacing={1}
          alignItems="baseline"
          data-testid={`chat-todo-item-${todo.status}`}
        >
          <Typography
            level="body-xs"
            aria-hidden
            textColor={todo.status === 'pending' || todo.status === 'cancelled' ? 'text.tertiary' : undefined}
          >
            {MARKER[todo.status]}
          </Typography>
          <Typography
            level="body-sm"
            textColor={todo.status === 'in_progress' ? 'text.primary' : 'text.tertiary'}
            sx={{
              fontWeight: todo.status === 'in_progress' ? 'lg' : undefined,
              textDecoration: todo.status === 'completed' || todo.status === 'cancelled' ? 'line-through' : undefined,
            }}
            data-testid="chat-todo-text"
          >
            {todo.status === 'in_progress' ? (todo.activeForm ?? todo.content) : todo.content}
          </Typography>
        </Stack>
      ))}
    </Stack>
  );
}

/**
 * The model's plan for the task in hand, pinned above the composer - for a conversation that has
 * no session panel on screen to carry it (see SessionPanel's Plan section).
 *
 * Collapsed to its one-line bar by default. The plan is context for the reply, not the reply,
 * and a list unfolded over the composer on every turn costs more room than it earns; the item
 * in progress rides the bar so the closed state still says what is happening.
 */
export function TodoPanel({ todos, turnOpen }: { todos: readonly PlanItem[] | null; turnOpen: boolean }) {
  const [open, setOpen] = useState(false);
  const plan = visiblePlan(todos, turnOpen);
  if (!plan) return null;

  const progress = todoProgress(plan);

  return (
    <Box sx={contentColumnSx} data-testid="chat-todo-panel">
      <Box sx={{ border: '1px solid', borderColor: 'divider', borderRadius: 'md', px: 1.5, py: 0.75, mb: 1 }}>
        <Box
          component="button"
          type="button"
          onClick={() => setOpen(value => !value)}
          aria-expanded={open}
          data-testid="chat-todo-toggle"
          sx={{ all: 'unset', cursor: 'pointer', display: 'block', width: '100%' }}
        >
          <Typography level="body-xs" textColor="text.tertiary" noWrap>
            {`Plan \u00b7 ${progress.done} of ${progress.total} done`}
            {!open && progress.current ? (
              <Box component="span" sx={{ color: 'text.secondary' }}>{` \u00b7 ${progress.current}`}</Box>
            ) : null}
          </Typography>
        </Box>
        {open && <TodoList todos={plan} />}
      </Box>
    </Box>
  );
}
