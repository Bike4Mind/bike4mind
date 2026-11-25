import type { AgentState } from '@shared/agentState';

/** The stops of the Transit line, in travel order. */
export const TRANSIT_STOPS = ['waiting', 'planning', 'working', 'reviewing', 'done'] as const;
export type TransitStop = (typeof TRANSIT_STOPS)[number];

/** Where an agent sits: a stop on the line, or off it when the run ended without finishing. */
export type TransitPhase = TransitStop | 'off-line';

export const TRANSIT_STOP_LABEL: Record<TransitStop, string> = {
  waiting: 'Waiting',
  planning: 'Planning',
  working: 'Working',
  reviewing: 'Reviewing',
  done: 'Done',
};

// Activity text is "<tool> <detail>" (activityLabel), or a phase label such as "Thinking".
const SHELL_TOOL = /^bash/;
// Matched only against a shell command, never a file path: "file_edit check.ts" is editing, not verifying.
const VERIFY_COMMAND = /\b(test|tests|vitest|jest|lint|typecheck|tsc|check|verify)\b/i;
const PLANNING = /^(thinking|planning)\b/i;
const WORKING =
  /^(file_edit|file_write|file_read|bash|glob_files|grep_search|web_fetch|web_search|session_|preparing|writing a reply)/i;

/**
 * The stop an agent belongs at, from its state and the one-line activity the snapshot carries (the
 * only signal a view has). Only a working agent is read from its text; a working agent whose text is
 * missing or not recognised stays at Waiting rather than guessing a phase.
 */
export function transitPhase(state: AgentState, activity?: string): TransitPhase {
  switch (state) {
    case 'done':
      return 'done';
    case 'failed':
    case 'paused':
    case 'stopped':
      return 'off-line';
    case 'needs-you':
    case 'waiting':
    case 'idle':
      return 'waiting';
    case 'working': {
      const text = activity?.trim() ?? '';
      const [tool = '', ...rest] = text.split(/\s+/);
      if (SHELL_TOOL.test(tool) && VERIFY_COMMAND.test(rest.join(' '))) return 'reviewing';
      if (PLANNING.test(text)) return 'planning';
      if (WORKING.test(text)) return 'working';
      return 'waiting';
    }
  }
}
