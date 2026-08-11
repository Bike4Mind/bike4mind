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
 *
 * Heights here are exact rather than estimated, and that is load-bearing:
 * MessageItem renders every live trace line with `wrap="truncate-end"` and
 * collapses whitespace, so a step occupies a fixed number of rows no matter how
 * long its text or how narrow the terminal. Estimating wrapped rows instead
 * looks reasonable and is wrong - Ink wraps with `wrapAnsi(trim: false, hard:
 * true)`, whose word-boundary waste compounds per line, so any chars/width
 * estimate runs short exactly when the terminal is narrow. If the truncation in
 * MessageItem is ever relaxed, this module has to go back to measuring.
 */

/** Rows the trace Box spends on the "N earlier steps" hint and its bottom margin. */
const TRACE_BOX_CHROME_ROWS = 2;

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

const isRenderable = (step: AgentStep, showThoughts: boolean): boolean =>
  step.type === 'action' || (step.type === 'thought' && showThoughts);

/**
 * Rows `MessageItem` spends on `steps[index]` in the live frame: a blank
 * marginTop row, one truncated line, and - for an action - one more line for the
 * observation that follows it. Steps that render nothing cost 0.
 */
function stepRows(steps: AgentStep[], index: number, showThoughts: boolean): number {
  const step = steps[index];
  if (step.type === 'thought') {
    return showThoughts ? 2 : 0;
  }
  if (step.type !== 'action') {
    return 0;
  }
  return steps[index + 1]?.type === 'observation' ? 3 : 2;
}

/** Rows a whole window occupies, excluding the trace Box chrome. */
export function measureTraceRows(steps: AgentStep[], { showThoughts = true }: { showThoughts?: boolean } = {}): number {
  let rows = 0;
  for (let i = 0; i < steps.length; i++) rows += stepRows(steps, i, showThoughts);
  return rows;
}

const countRenderable = (steps: AgentStep[], showThoughts: boolean): number =>
  steps.filter(step => isRenderable(step, showThoughts)).length;

export interface LiveTraceWindow {
  /** Contiguous tail of the trace that fits the budget. */
  steps: AgentStep[];
  /** Renderable steps dropped off the head, for the "earlier steps" hint. */
  hiddenSteps: number;
}

const EMPTY_WINDOW: LiveTraceWindow = { steps: [], hiddenSteps: 0 };

/**
 * Picks the newest slice of `steps` that renders within `rows`, which is the
 * total height the trace Box may occupy - the hint line and bottom margin are
 * charged against it. The slice stays contiguous so each action keeps the
 * observation that follows it.
 */
export function windowLiveTrace(
  steps: AgentStep[],
  { rows, showThoughts = true }: { rows: number; showThoughts?: boolean }
): LiveTraceWindow {
  const budget = Math.floor(rows) - TRACE_BOX_CHROME_ROWS;
  if (budget <= 0 || steps.length === 0) {
    return EMPTY_WINDOW;
  }

  let used = 0;
  let start = steps.length;
  for (let i = steps.length - 1; i >= 0; i--) {
    const height = stepRows(steps, i, showThoughts);
    if (height > 0 && used + height > budget) break;
    used += height;
    start = i;
  }

  if (start < steps.length) {
    // Zero-height steps are free, so the walk can stop on an observation whose
    // action fell outside the window. It renders nothing - drop it.
    while (start < steps.length && stepRows(steps, start, showThoughts) === 0) start++;
    if (start < steps.length) {
      return { steps: steps.slice(start), hiddenSteps: countRenderable(steps.slice(0, start), showThoughts) };
    }
  }

  // Nothing fit whole. Only an action can be trimmed further, by dropping the
  // "Result:" line that its observation renders (3 rows down to 2).
  let newest = -1;
  for (let i = steps.length - 1; i >= 0; i--) {
    if (isRenderable(steps[i], showThoughts)) {
      newest = i;
      break;
    }
  }
  if (newest < 0 || budget < 2) {
    return EMPTY_WINDOW;
  }

  return { steps: [steps[newest]], hiddenSteps: countRenderable(steps.slice(0, newest), showThoughts) };
}
