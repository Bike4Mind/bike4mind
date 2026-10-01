import { useState } from 'react';
import Box from '@mui/joy/Box';
import Stack from '@mui/joy/Stack';
import Typography from '@mui/joy/Typography';
import { countTodos, type TodoItem, type TodoStatus } from '@shared/todos';
import { contentColumnSx } from './layout';

const MARKER: Record<TodoStatus, string> = {
  completed: '\u2713',
  in_progress: '\u25cf',
  pending: '\u25cb',
};

/**
 * The model's plan for the task in hand, pinned above the composer.
 *
 * Hidden once every item is done and no turn is running: a finished plan left above the box
 * reads as work still owed. While a turn is open it stays, so the last tick is seen landing.
 */
export function TodoPanel({ todos, turnOpen }: { todos: readonly TodoItem[] | null; turnOpen: boolean }) {
  const [open, setOpen] = useState(true);
  if (!todos || todos.length === 0) return null;

  const counts = countTodos(todos);
  if (counts.completed === todos.length && !turnOpen) return null;

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
          <Typography level="body-xs" textColor="text.tertiary">
            {`Plan \u00b7 ${counts.completed} of ${todos.length} done`}
          </Typography>
        </Box>
        {open && (
          <Stack
            component="ul"
            spacing={0.25}
            sx={{ m: 0, mt: 0.5, p: 0, listStyle: 'none', maxHeight: '25vh', overflowY: 'auto' }}
          >
            {todos.map((todo, index) => (
              <Stack
                component="li"
                key={`${index}-${todo.content}`}
                direction="row"
                spacing={1}
                alignItems="baseline"
                data-testid={`chat-todo-item-${todo.status}`}
              >
                <Typography
                  level="body-xs"
                  aria-hidden
                  textColor={todo.status === 'pending' ? 'text.tertiary' : undefined}
                >
                  {MARKER[todo.status]}
                </Typography>
                <Typography
                  level="body-sm"
                  textColor={todo.status === 'in_progress' ? 'text.primary' : 'text.tertiary'}
                  sx={{
                    fontWeight: todo.status === 'in_progress' ? 'lg' : undefined,
                    textDecoration: todo.status === 'completed' ? 'line-through' : undefined,
                  }}
                >
                  {todo.content}
                </Typography>
              </Stack>
            ))}
          </Stack>
        )}
      </Box>
    </Box>
  );
}
