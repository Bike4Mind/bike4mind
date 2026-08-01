import type { AgentStep } from '@bike4mind/agents';

/**
 * Bounds the height of the agent step trace while it is being rendered in
 * Ink's live frame.
 *
 * Ink 7 repaints the live frame in place (cursor-up + erase) only while the
 * frame fits the viewport. For any frame taller than `stdout.rows` it falls
 * back to `ansiEscapes.clearTerminal` - which includes ESC[3J, "erase
 * scrollback" - and then re-dumps every <Static> line written so far
 * (`shouldClearTerminalForFrame` in ink/build/ink.js). With the thinking
 * spinner ticking every 80ms that means scrollback is destroyed and rebuilt
 * ~12x/sec, so the terminal is pinned to the bottom and scrolling up during a
 * turn is impossible. Keeping the live trace short keeps Ink on the in-place
 * path.
 *
 * Nothing is lost by windowing: the complete step trace is committed to
 * session.messages when the turn ends and rendered once through <Static>,
 * which is what actually lands in terminal scrollback.
 */

/** Floor for the trace budget so a very short terminal still shows something. */
export const MIN_TRACE_ROWS = 4;

/** paddingLeft on the trace Box (2) plus the nested result Box (2). */
const TRACE_INDENT = 4;

/** Columns the thought bubble glyph plus its trailing space occupy. */
const THOUGHT_PREFIX_COLS = 3;

/** Row held back for the "N earlier steps" hint so the total stays within `rows`. */
const HINT_ROWS = 1;

/** Character caps MessageItem applies to tool args and tool results. */
export const ACTION_ARG_LIMIT = 100;
export const OBSERVATION_LIMIT = 200;

/**
 * Truncates a value to maxLength, converting objects to JSON strings.
 * Appends '...' if truncated.
 */
export function truncateValue(value: unknown, maxLength: number): string {
  const str = typeof value === 'string' ? value : JSON.stringify(value);
  if (str.length <= maxLength) {
    return str;
  }
  return str.slice(0, maxLength) + '...';
}

const wrappedRows = (text: string, width: number): number =>
  text.split('\n').reduce((rows, line) => rows + Math.max(1, Math.ceil(line.length / width)), 0);

const isRenderable = (step: AgentStep, showThoughts: boolean): boolean =>
  step.type === 'action' || (step.type === 'thought' && showThoughts);

/**
 * Rows `MessageItem` will spend on `steps[index]`, including the blank
 * marginTop row and - for actions - the trailing observation rendered as the
 * "Result:" line. Steps that render nothing cost 0.
 */
function stepRows(steps: AgentStep[], index: number, width: number, showThoughts: boolean): number {
  const step = steps[index];

  if (step.type === 'thought') {
    return showThoughts ? 1 + wrappedRows(step.content, Math.max(1, width - THOUGHT_PREFIX_COLS)) : 0;
  }

  if (step.type !== 'action') {
    return 0;
  }

  const toolName = step.metadata?.toolName || 'unknown';
  const args = step.metadata?.toolInput ? ` - ${truncateValue(step.metadata.toolInput, ACTION_ARG_LIMIT)}` : '';
  let rows = 1 + wrappedRows(`${toolName}${args}`, width);

  const observation = steps[index + 1];
  if (observation?.type === 'observation') {
    rows += wrappedRows(`Result: ${truncateValue(observation.content, OBSERVATION_LIMIT)}`, width);
  }

  return rows;
}

const countRenderable = (steps: AgentStep[], showThoughts: boolean): number =>
  steps.filter(step => isRenderable(step, showThoughts)).length;

/** Shortens an oversized step so it alone cannot overflow the row budget. */
function clampContent(step: AgentStep, rows: number, traceWidth: number): AgentStep {
  // Must match the width stepRows() charges this step type, or the clamped copy
  // wraps to more rows than the budget allows.
  const width = step.type === 'thought' ? Math.max(1, traceWidth - THOUGHT_PREFIX_COLS) : traceWidth;
  const maxChars = Math.max(width, (rows - 1) * width);
  if (step.content.length <= maxChars) {
    return step;
  }
  return { ...step, content: step.content.slice(0, Math.max(0, maxChars - 3)) + '...' };
}

export interface LiveTraceWindow {
  /** Contiguous tail of the trace that fits the budget. */
  steps: AgentStep[];
  /** Renderable steps dropped off the head, for the "earlier steps" hint. */
  hiddenSteps: number;
}

/**
 * Picks the newest slice of `steps` that renders within `rows`. The slice stays
 * contiguous so each action keeps the observation that follows it.
 */
export function windowLiveTrace(
  steps: AgentStep[],
  { rows, columns, showThoughts = true }: { rows: number; columns: number; showThoughts?: boolean }
): LiveTraceWindow {
  const budget = Math.max(MIN_TRACE_ROWS, Math.floor(rows) - HINT_ROWS);
  const width = Math.max(1, columns - TRACE_INDENT);

  let used = 0;
  let start = steps.length;
  for (let i = steps.length - 1; i >= 0; i--) {
    const height = stepRows(steps, i, width, showThoughts);
    if (height > 0 && used + height > budget) break;
    used += height;
    start = i;
  }

  if (start < steps.length) {
    // Zero-height steps are free, so the walk can stop on an observation whose
    // action fell outside the window. It renders nothing - drop it.
    while (start < steps.length && stepRows(steps, start, width, showThoughts) === 0) start++;
    return { steps: steps.slice(start), hiddenSteps: countRenderable(steps.slice(0, start), showThoughts) };
  }

  // The newest step alone overflows the budget (a long thought). Show a
  // clamped copy rather than an empty trace.
  let newest = -1;
  for (let i = steps.length - 1; i >= 0; i--) {
    if (isRenderable(steps[i], showThoughts)) {
      newest = i;
      break;
    }
  }
  if (newest < 0) {
    return { steps: [], hiddenSteps: 0 };
  }

  return {
    steps: steps.slice(newest).map((step, idx) => (idx === 0 ? clampContent(step, budget, width) : step)),
    hiddenSteps: countRenderable(steps.slice(0, newest), showThoughts),
  };
}
