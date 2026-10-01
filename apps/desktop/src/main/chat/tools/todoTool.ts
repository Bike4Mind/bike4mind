import { countTodos, MAX_TODOS, parseTodos, TODO_TOOL_NAME } from '@shared/todos';
import type { ToolDefinition } from './types';

/**
 * The model's working plan. It holds no state here: the list is the call's own input, and the
 * transcript is where it lives (see shared/todos.ts). Each call replaces the whole list, so the
 * model cannot drift out of step with a half-applied patch, and a later read of the history
 * always shows the current plan in the last call.
 */
export const todoWrite: ToolDefinition = {
  schema: {
    name: TODO_TOOL_NAME,
    description: [
      'Keep a short checklist for a multi-step task, shown to the user as the plan. Send the WHOLE',
      'list every time; it replaces the previous one.',
      '',
      'Most work needs no plan, and one on a small task is noise the user has to look past. Use it',
      'only when the user gave you several separate things to do, or the work clearly runs to five',
      'or more steps, usually across several files. Never for a question, an explanation, an',
      'investigation, a piece of research, a single fix or a small edit: answer those directly.',
      '',
      'Mark a todo "in_progress" before you start it, with only one in progress at a time, and',
      '"completed" as soon as it is done and checked - not in a batch at the end. Drop todos that',
      'turn out to be unnecessary. Never mark something completed while tests are failing or the',
      'work is partial.',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        todos: {
          type: 'array',
          description: `The full list, in order (at most ${MAX_TODOS}).`,
          items: {
            type: 'object',
            properties: {
              content: { type: 'string', description: 'What needs doing, in a short imperative sentence.' },
              status: { type: 'string', description: '"pending", "in_progress" or "completed".' },
            },
            required: ['content', 'status'],
          },
        },
      },
      required: ['todos'],
    },
  },

  async run(input) {
    const parsed = parseTodos(input.todos);
    if ('error' in parsed) throw new Error(parsed.error);

    const counts = countTodos(parsed.todos);
    const warning =
      counts.in_progress > 1 ? ' More than one is in progress; keep it to one and finish it before the next.' : '';
    return (
      `Plan updated: ${counts.completed} done, ${counts.in_progress} in progress, ${counts.pending} pending.` + warning
    );
  },
};
