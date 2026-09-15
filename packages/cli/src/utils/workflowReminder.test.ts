import { describe, it, expect } from 'vitest';
import {
  renderWorkflowReminder,
  DEFAULT_REMINDER_MAX_TOKENS,
  REMINDER_RECENT_DECISIONS,
  type WorkflowReminderState,
} from './workflowReminder';
import type { TodoItem } from '../tools/writeTodosTool.js';
import type { WorkflowBlocker, WorkflowDecision } from '../storage/types.js';

function todo(description: string, status: TodoItem['status'] = 'pending'): TodoItem {
  return { description, status };
}

function decision(summary: string, rationale = 'because'): WorkflowDecision {
  return { id: `d-${summary}`, timestamp: '2026-01-01T00:00:00.000Z', summary, rationale };
}

function blocker(description: string, status: WorkflowBlocker['status'] = 'open'): WorkflowBlocker {
  return { id: `b-${description}`, createdAt: '2026-01-01T00:00:00.000Z', description, status };
}

function state(overrides: Partial<WorkflowReminderState> = {}): WorkflowReminderState {
  return { todos: [], decisions: [], blockers: [], ...overrides };
}

/** Same chars/4 approximation the renderer budgets with. */
const approxTokens = (text: string) => Math.ceil(text.length / 4);

describe('renderWorkflowReminder', () => {
  it('returns null when there is no open state', () => {
    expect(renderWorkflowReminder(state()).text).toBeNull();
  });

  it('returns null when todos/blockers exist but none are open', () => {
    const result = renderWorkflowReminder(
      state({
        todos: [todo('done', 'completed'), todo('dropped', 'cancelled')],
        blockers: [{ ...blocker('resolved one'), status: 'resolved' }],
      })
    );
    expect(result.text).toBeNull();
  });

  it('renders open todos with status, open blockers, and recent decisions', () => {
    const result = renderWorkflowReminder(
      state({
        todos: [todo('write tests', 'in_progress'), todo('update docs'), todo('shipped', 'completed')],
        blockers: [blocker('waiting on API key')],
        decisions: [decision('use vitest', 'repo standard')],
      })
    );

    expect(result.text).toContain('Open todos:');
    expect(result.text).toContain('1. [in_progress] write tests');
    expect(result.text).toContain('2. [pending] update docs');
    expect(result.text).not.toContain('shipped');
    expect(result.text).toContain('Open blockers:\n- waiting on API key');
    expect(result.text).toContain('Recent decisions:\n- use vitest (rationale: repo standard)');
    expect(result.elided).toBe(0);
  });

  it('shows only the most recent K decisions and counts older ones as elided', () => {
    const decisions = Array.from({ length: REMINDER_RECENT_DECISIONS + 3 }, (_, i) => decision(`decision ${i}`));
    const result = renderWorkflowReminder(state({ decisions }));

    expect(result.text).toContain(`decision ${decisions.length - 1}`);
    expect(result.text).not.toContain('decision 0 ');
    expect(result.elided).toBe(3);
  });

  it('never exceeds the token cap, even with many long items', () => {
    const many = state({
      todos: Array.from({ length: 60 }, (_, i) => todo(`todo ${i} ${'x'.repeat(300)}`)),
      blockers: Array.from({ length: 40 }, (_, i) => blocker(`blocker ${i} ${'y'.repeat(300)}`)),
      decisions: Array.from({ length: 40 }, (_, i) => decision(`decision ${i}`, 'z'.repeat(300))),
    });

    const result = renderWorkflowReminder(many);
    expect(result.text).not.toBeNull();
    expect(approxTokens(result.text as string)).toBeLessThanOrEqual(DEFAULT_REMINDER_MAX_TOKENS);
    expect(result.elided).toBeGreaterThan(0);
  });

  it('respects a custom (smaller) token cap and drops oldest-first', () => {
    const result = renderWorkflowReminder(
      state({
        todos: [todo('keep me newest')],
        decisions: [decision('oldest decision'), decision('newest decision')],
      }),
      { maxTokens: 12 }
    );

    // Budget pressure drops decisions before todos, oldest decision first.
    expect(result.text).toContain('keep me newest');
    expect(result.text).not.toContain('oldest decision');
    expect(result.elided).toBeGreaterThan(0);
    expect(approxTokens(result.text as string)).toBeLessThanOrEqual(12);
  });

  it('elides long item text to a single line', () => {
    const result = renderWorkflowReminder(state({ todos: [todo(`multi\nline\n${'a'.repeat(400)}`)] }));
    const line = (result.text as string).split('\n').find(l => l.startsWith('1.'));
    expect(line).toBeDefined();
    expect(line).toContain('multi line');
    expect(line!.endsWith('...')).toBe(true);
  });
});
